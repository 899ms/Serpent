# 2026-09-14 色卡提取吞吐优化与基准（Serpent 色卡性能）

> 触发：用户 2026-09-14 反馈「色卡提取很花时间」，要求优化提取算法并给出 benchmark，可用本地外部图片目录做临时基准样本（该目录不入库）。

## 1. 结论先行

1. **生产路径上「算法」不是瓶颈。** 生产固定把源图/缩略图解到 64×64 再提取，200 张真实图片实测：解码 mean **17.3 ms**、`extractRepresentativePalette` mean **0.18 ms**（占解码 **1.05%**）。调优提取循环本身最多只能省掉约 1%。
2. **真正的放大器是二级媒体泵的调度节奏。** 色卡走 `background-secondary`，改动前每轮只 claim **1 个** job 且每轮之间固定睡 **50 ms**（`src/worker/index.ts`）。实测 **12.57 张/秒** → 2 万张色卡约 **26.5 分钟**。
3. **已落地改动：** 二级泵按 `workerMediaDecodeWaveSize()`（=4）claim 一轮，积压时用 10 ms 让出、排空时保留 50 ms 间隔。实测 **56.86 张/秒 → 2 万张约 5.9 分钟（4.5×）**。
4. **算法本体确实快了，但在生产尺寸上看不出来。** 类型化数组直方图 + 有界 top-k 选择 + 平坦图早退：2 MP 帧 **61.05 → 21.97 ms（2.78×）**；64×64 生产缓冲上 0.18 ms → 0.18 ms（无差异）。输出逐字节不变。
5. **解码链去掉 `ensureAlpha()` 属清理，不是提速依据。** 三轮配对测量分别得到 -7.6%、-4%、+1.6%（p50 有正有负），判为**噪声级**，如实记录，不写成收益。

## 2. 四列可追溯

| 需求 | 实现 | 自动化测试 | 证据 / 平台 |
| --- | --- | --- | --- |
| 色卡提取要有可重复的 benchmark，且样本目录不入库 | `tests/worker/palette-benchmark.test.ts`、`scripts/run-palette-benchmark.mjs`、`package.json` `test:perf:palette` | 该文件本身 opt-in（`describe.skipIf`），目录由 `SERPENT_PALETTE_BENCH_DIR` 运行时传入 | 见 §4；结果 JSON 由 `SERPENT_PALETTE_BENCH_JSON` 写到工作区外，未入库 |
| 优化提取算法且行为不变 | `src/worker/palette-extractor.ts:22,104-215` | `tests/unit/palette-extractor-equivalence.test.ts`（240 组随机语料 + 全透明/单 bin 边界，与 `tests/helpers/palette-extractor-reference.ts` 对拍）、`tests/unit/palette-extractor.test.ts` | 7 passed；benchmark 内在真实解码缓冲上再对拍一次（200/200 相等） |
| 大库色卡补齐不再需要几十分钟 | `src/worker/index.ts:1212-1216,1442,1489-1493` | benchmark stage C 六种策略；`tests/worker/palette-artifact.test.ts`；`npm run test:library-availability` | 12.57 → 56.86 张/秒（4.5×）；2 万投影 26.5 → 5.9 分钟 |
| 不破坏原生并发预算与交互让路 | 同上（wave 只是 claim 预算；`workerCount = min(maxJobs, workerMediaDecodeConcurrency())`) | 既有交互优先/空闲窗口/抢占路径未改；`docs/internal/implementation/0032-library-performance-architecture.md` §6.1/§6.2 同步 | 文档已更新为「有界 claim wave + 原生并发仍受解码器 lane 约束」 |

## 3. 根因分析（先证伪，再动手）

| 假设 | 检验 | 结论 |
| --- | --- | --- |
| H1 提取算法慢 | stage A 对每个文件分别计时解码与提取 | **证伪**：提取占 1.05%（0.18 ms vs 17.3 ms）。旧实现用逐像素 `Map` + 每桶对象，但在 4096 像素上绝对值仍极小 |
| H2 解码太贵 | 同一批再测 full decode（不 resize）mean 14.65 ms、缩略图解码 3.22 ms、源图解码 38.63 ms | **部分成立但不可再削**：64×64 目标已靠 libvips shrink-on-load 压到与 full decode 同量级；主要成本是"必须解一次码" |
| H3 每张任务本身便宜，但队列吞吐被封顶 | claim 调用之外单独模拟泵节奏（stage C） | **成立且是主因**：12.57 张/秒，其中约 50 ms/张 是自己睡的 |

补充发现：把 `maxJobs` 保持在 1、只把"睡"换成"连续 claim"（burst=8）只能到 **44.24 张/秒**——单 job 的 claim 调用要付约 **8 ms** 固定开销（claim SQL、事务、wave 记账、`yieldBetweenMediaClaims`），必须让一次 claim 覆盖多个 job 才能摊销。这也是最终选择 wave 而不是 burst 的依据。

## 4. 测量方法与结果

样本：本地外部图片目录（路径运行时传入，仓库不含该路径），取前 200 张图片：jpg 166 / png 25 / gif 6 / webp 3，共 142.5 MB。

命令：

```bash
SERPENT_PALETTE_BENCH_LIMIT=200 \
SERPENT_PALETTE_BENCH_TMP=<本地临时目录> \
SERPENT_PALETTE_BENCH_JSON=<工作区外结果文件> \
SERPENT_PALETTE_BENCH_FULL_DECODE=1 \
npm run test:perf:palette -- <图片目录>
```

| 阶段 | 指标 | 结果 |
| --- | --- | --- |
| A 生产解码 + 提取 | 解码 mean / p50 / p95 | 17.27 / 12.81 / 43.91 ms（max 84.58） |
| A | 提取 mean / p50 / p95 | 0.18 / 0.13 / 0.32 ms |
| A | 提取占解码比例 | **1.05%** |
| A | 2 MP 帧提取（新 / 旧） | 21.97 / 61.05 ms（**2.78×**） |
| A | `ensureAlpha` 配对（有 / 无） | 10.07 / 10.23 ms → 噪声级 |
| B 真实队列 | 色卡 job per-asset / 吞吐 | 11.63 ms、86.01 张/秒（同 call 内批量，非泵节奏） |
| B | 解码源对比（缩略图 / 原图） | 3.22 / 38.63 ms（源直读图片走原图） |
| C 泵策略 | wave=1 gap=50（改动前） | 12.57 张/秒 → 2 万 **26.5 分钟** |
| C | burst=8 wave=1 gap=10 | 44.24 张/秒 → 7.5 分钟（**已否决**） |
| C | wave=2 gap=50 | 23.04 张/秒 → 14.5 分钟 |
| C | wave=4 gap=50 | 36.68 张/秒 → 9.1 分钟 |
| C | **wave=4 gap=10（采用）** | **56.86 张/秒 → 5.9 分钟** |
| C | wave=8 gap=10 | 69.39 张/秒 → 4.8 分钟（未采用，见 §6） |

## 5. 代码改动

- `src/worker/palette-extractor.ts`：直方图由 `Map<number, bucket>` 改为 `Uint32Array(4096)` + 三个 `Float64Array` 通道和；种子从"排序全部桶取前 N"改为**一次遍历的有界插入**；桶均值只算一次；**当占用桶数 ≤ 请求色数时跳过 k-means**（证明为恒等映射，输出不变）；k-means 累加仍用原始通道和，保证逐位一致。
- `src/worker/library-service.ts:24475-24490`：色卡解码链去掉 `ensureAlpha()`，直接用 `info.channels`（3 或 4 通道提取器都支持，不透明像素行为一致）。
- `src/worker/index.ts:1204-1216`：新增 `SECONDARY_MEDIA_BATCH_SIZE` / 积压让出常量；`:1442` 用 wave 替换 `maxJobs: 1`；`:1489-1493` 按"是否占满一轮"选择 10 ms 或 50 ms 间隔。
- 新增 `tests/worker/palette-benchmark.test.ts`、`tests/helpers/palette-extractor-reference.ts`、`tests/unit/palette-extractor-equivalence.test.ts`、`scripts/run-palette-benchmark.mjs`；`package.json` 增加 `test:perf:palette`。

## 6. 取舍与未采纳项

- **未采纳 wave=8（69.39 张/秒，4.8 分钟）**：收益只剩 1.1 分钟，但一轮占用的 worker 时间翻倍。wave=4 与主预览波 `workerMediaDecodeWaveSize()` 同口径，是"够快且沿用既有约定"的点。
- **未把色卡合并进缩略图解码**（同一 revision 只解一次码）：实测缩略图解码仅 3.22 ms，相对 11.63 ms/job 收益有限，而 artifact/job 生命周期、失效与修复路径会明显复杂化，收益不抵风险，未做。
- **未改 `MEDIA_QUEUE_CONCURRENCY`**：wave 是 claim 预算，`workerCount = min(maxJobs, workerMediaDecodeConcurrency())` 仍为 2，与 `background-primary` 共用 Sharp 信号量，原生并发不随 wave 放大。

## 7. 验证与未验证

已执行（当次命令 + 结果）：

- `npx eslint`（改动文件）与 `npm run lint`：**0 error**，1 个既有 `react-hooks/exhaustive-deps` warning（`src/renderer/browse/use-virtual-browse-session.ts:220`，非本次改动）。
- `npx tsc --noEmit`：0 error。
- `npx vitest run --config vitest.config.ts tests/unit/palette-extractor.test.ts tests/unit/palette-extractor-equivalence.test.ts`：**7 passed**。
- `node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/worker/palette-artifact.test.ts`：**11 passed**。
- `npm run test:library-availability`（library-service 改动强制门禁）：**9 files / 211 passed / 1 skipped**。
- `npm run test`：**555 files / 4814 passed / 1 failed / 29 skipped**；唯一失败为既有 `tests/worker/migration-checksum-snapshot.test.ts`（`MIGRATIONS` 已到 v49、快照止于 v48），与本改动无关——本次 diff 不含任何 `MIGRATIONS`/schema 变更（`git diff -- src/worker/library-service.ts` 仅色卡解码链 4 行），且该失败在本次会话较早的干净 HEAD 全量跑中已记录为既有失败。
- benchmark 三段：见 §4。

未执行 / 需说明：

- **真实 2 万资产库**未跑：stage C 的 2 万时间是「200 张实测吞吐 × 线性外推」，不是 2 万真实库的端到端计时。
- **交互响应性**未做真机观测（Computer Use 未执行）：本轮只论证"原生并发不变、交互空闲窗口与抢占路径未改、每轮 claim 之间有 await 让出"，没有实机滚动/切库延迟证据。
- **packaged / Windows 真机 / NAS-SMB** 未重跑。
- **Electron E2E 未重跑**：色卡产物字节不变、改动限于 Worker 内部调度与解码选项；`tests/e2e/media-preview.test.ts` 的「自动色卡预览」用例仍建议在发布门禁重跑。

## 8. 同步更新的文档

- `docs/internal/implementation/0032-library-performance-architecture.md` §6.1 lane 表与 §6.2 预算：`background-secondary` 由「默认单路」改为「有界 claim wave（≤ `workerMediaDecodeWaveSize()`）；原生并发仍受 `workerMediaDecodeConcurrency()` 与解码器 lane 约束」，并记录本次实测数字（该文档原本就写明"后续可按真机基准调整并发"）。
- `docs/internal/qa/human-acceptance-checklist.md`：新增 `MEDIA-PERF-004`（大库色卡补齐吞吐，待人类验收）。
