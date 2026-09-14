# 2026-09-14 文件夹切换与资源加载性能优化（真实 4.3 万资产库基准 → 优化 → 对比）

> 触发：用户 2026-09-14 要求「按 `docs/internal/implementation/2026-09-14-folder-switch-and-resource-loading-optimization.md` 与对应工单完成性能优化；先用真实资源库做覆盖各操作面的插桩基准、找出热区，再优化并对比」。
> 规格：本日志对应的规格文档同上；工单 `Serpent-217028`（观测与回放基准）、`Serpent-e97c00`（状态轮询有界）、`Serpent-8ee170`（拖拽预热合并）、`Serpent-be29a9`（对账归还后台许可）、`Serpent-26f22b`（对账探针去放大）。
> 隐私：真实资源库路径、库名与资产名只通过运行时环境变量传入，**仓库内不保存任何真实路径**；本日志只写类别与数字。

## 1. 交付物

| 交付物 | 位置 | 说明 |
| --- | --- | --- |
| 导航性能基准 | `tests/e2e/navigation-perf-benchmark.test.ts` | 真 Electron + 隔离 userData；覆盖打开、库切换、文件夹切换、合集切换、随机跳转、连续滚轮、查看器打开；破坏性操作（文件夹创建、合集创建、资产移入回收站、文件夹删除）只在显式确认的一次性副本上执行 |
| 基准运行器 | `scripts/run-navigation-benchmark.mjs` + `npm run test:perf:navigation -- <库> [第二个库]` | 复用 `scripts/run-e2e.mjs` 的构建管线；报告写在仓库外（`SERPENT_NAV_BENCH_OUT`） |
| 插桩与日志解析 | `tests/e2e/perf-bench-helpers.ts` | 渲染端探针（long task、帧间隔、卡片挂载/`src` 重写、`serpent:e2e-browse-*` 事件）＋ Worker/Main 结构日志（`worker.cmd`、`performance.span`、`worker.eventLoop.lag`、`worker.scheduler.stall`、`worker.media-queue`、`open.reconciliation.stage`、`refresh.managed-assets.stage`、`preview-cache`） |
| 冷/热回放 | `SERPENT_NAV_BENCH_USER_DATA` | 固定 profile 目录即可在同一夹具上做冷/热重复回放 |

基准刻意不建第二套缓存、不改产品行为：所有额外细节都来自既有 `SERPENT_*_LOG` 门控与注入式探针。

## 2. 基线（真实 4.3 万资产库，冷 profile，200 秒内多次导航）

命令（路径由 env 传入）：

```powershell
. <仓库外环境脚本>            # SERPENT_NAV_BENCH_LIBRARY / _B / _WRITE_LIBRARY / _WRITE_CONFIRM / _OUT / _USER_DATA
npm run test:perf:navigation -- <真实库> <第二个库>
```

渲染端可见结果（p50 / max，毫秒）：

| 操作 | p50 | max | 结论 |
| --- | ---: | ---: | --- |
| 打开资源库 → 首卡 | 2,160 | 2,160 | 打开反馈本身够快 |
| **切文件夹（安静期）** | **20,077** | **39,410** | 复现用户「约半分钟」 |
| **切文件夹（对账运行中）** | **20,045** | 20,079 | 与安静期同量级 → 不是渲染问题 |
| **切合集** | **20,048** | 20,078 | 同上 |
| 随机滚动跳转 | 20 | 69 | 快 |
| 查看器打开 | 258 | 327 | 快 |
| 库切换 → 首卡 | 6,386 | 6,386 | 偏慢 |

Worker/Main 侧热点账本（同一次运行，8.4 分钟）：

| 命令 | 次数 | run 合计 | 排队合计 | 最大排队 |
| --- | ---: | ---: | ---: | ---: |
| `media.list-jobs` | 503 | 66.1 s | 603.8 s | 29.2 s |
| `ai.status` | 503 | 19.3 s | 653.2 s | 29.4 s |
| `plugin.jobs.list` | 503 | 5.1 s | 666.7 s | 29.5 s |
| `browse.session.open` | 15 | 0.32 s | 32.7 s | **28.3 s** |
| `folder.browse-entries` | 7 | 1.8 s | 28.8 s | **28.3 s** |
| `asset.search` | 12 | 7.8 s | 29.6 s | **28.5 s** |
| `media.get-asset-drag-infos` | 535 | 2.5 s | 6.8 s | 2.4 s（Main 侧往返 p95 95 s） |
| `media.get-artifact-paths` | 30 | 1.5 s | 1.5 s | 0.33 s |

对账（`open.reconciliation.stage`，3 次开库）：

| 阶段 | 累计 | 单次最长 |
| --- | ---: | ---: |
| `asset-reconciliation` | 85.2 s | **83.3 s** |
| `artifact-orphan-cleanup` | 18.0 s | 17.2 s |
| `network-metadata-cache` | 6.3 s | 2.3 s |

调度器 stall 证据（`worker.scheduler.stall`，6 次）：5 次的占用者都是同一个 `reconciliation`（maintenance），`runningMs` 一路 3.3 s → 7.3 s → 15.3 s → 21.8 s → **25.8 s**，队列里排着 `media.list-jobs` 等状态查询。

`refresh.managed-assets.stage` 共 2,061 次（同一个库），按分钟分布为 687/687/687 —— 即**每次开库对账按 ~64 资产/批串行 687 批**，其中 `precompute-fingerprints` 累计 53.4 s，是这批批次的固有开销。

### 2.1 热区结论

1. **不是渲染，是 Worker 排队**：导航命令自身只跑 0.3–1.8 s，却排了 28 s 队。
2. **排队的主要填充物是状态轮询**：三类各 503 次、合计排队 1,924 s（占整段运行 8.4 分钟里的大部分排队时间），且没有任何 single-flight。
3. **每个缩略图完成都发一次拖拽预热请求**：535 次，Main 侧往返 p95 达 95 s。
4. **对账作为一个 maintenance 任务连续占用后台许可最长 25.8 s**，而调度器同时只允许 1 个后台任务 → 预览路径（`media.get-artifact-paths`，background-primary）与导航被优先级反转堵住。
5. `artifact-orphan-cleanup` 每次开库 17.2 s：**先对每个 artifact 做 `lstat`、再查数据库引用**，而该库 8 万+ artifact 几乎全部仍被引用。

## 3. 已实施优化

| 工单 | 改动 | 位置 | 单测 |
| --- | --- | --- | --- |
| `Serpent-e97c00` | 用一个 `JobStatusCoordinator` 取代「常驻每秒轮询 + 面板再开一组」：每类查询 single-flight，飞行中的请求把后续请求折叠成一次跟进；库/代次变化或 stop 后的迟到结果直接丢弃；面板打开才用 1 s 快节奏，空闲退避到 10 s；窗口隐藏停止轮询，恢复时只做一次合并刷新；任务事件（`asset.thumbnail.*`/`asset.derived.ready`、AI 进度/完成/清空、插件命令完成）立即触发一次该类刷新 | `src/renderer/job-status-coordinator.ts`（新）、`src/renderer/App.tsx` | `tests/unit/job-status-coordinator.test.ts`（6） |
| `Serpent-8ee170` | 缩略图 ready/failed 事件不再各自发一条 `media.get-asset-drag-infos`，改为进入 Main 的合并队列：按库去重、in-flight id 不重复入队、500 id/批、批间 25 ms 让出、每库 pending 上限 20,000、切库/关窗丢弃旧代次 | `src/main/native-asset-drag-prime.ts`、`src/main/index.ts` | `tests/unit/native-asset-drag-prime-scheduler.test.ts`（6） |
| `Serpent-be29a9` | `InteractiveScheduler` 新增安全点让出：后台任务调用 `yieldAdmission(requestId)` 时，若队列里有交互请求或 mutation 在等，就把自己移出 active 集合（释放唯一后台许可）并等待重新准入；交互/mutation 优先于让出者，其他后台工作让位于让出者（保证对账有限推进）；让出期间取消路径（`cancelActiveBackgroundForLibrary`/`cancelActiveBackgroundOwners`）仍能到达该任务；无事可等时立即返回，零开销。`yieldReconciliation` 在每个批次安全点调用它 | `src/worker/interactive-scheduler.ts`、`src/worker/library-service.ts`、`src/worker/index.ts` | `tests/unit/interactive-scheduler-admission-yield.test.ts`（5）+ 既有 23 |
| `Serpent-26f22b` | 孤儿 artifact 扫描改为**先查引用集合再探针**：8 万+ 已引用 artifact 不再 `lstat`；并输出枚举数/探针数/被引用跳过数/候选数/耗时指标 | `src/worker/library-service.ts` `reconcileOrphanArtifactFiles` | `tests/worker/derived-artifact-repair.test.ts` 等定向 17 passed |

## 4. 优化后对比

两次运行都是同一条旅程、同一批操作、真实 4.3 万资产库；after 使用全新冷 profile。崩溃会落盘部分报告（本轮 after 一次运行曾出现 Worker 以 `0xFFFFFFFF` 退出并拖崩整棵进程树，重跑未复现；已如实记录，未与本轮改动建立因果）。

### 4.1 度量口径修正（重要）

基线与 after 的渲染端「切文件夹 p50 20.0 s」其实**不是导航耗时**：`min 20,029 / max 20,083` 只差 30 ms，是 `coverage≥0.8` 的 **20 s 预算超时**被当成了操作耗时（该库大量资产没有 ready 缩略图，覆盖率长期达不到 80%）。已把 `ms` 改为「页面到达」、覆盖率单独出列。因此**可比对的导航延迟证据用 Worker 侧准入等待**（两次运行口径完全一致，且与渲染端页面到达同源）。

### 4.2 Worker 侧准入等待（同一命令，基线 → after）

| 命令 | 次数 基线→after | 最大排队 基线→after | after p95 |
| --- | --- | --- | --- |
| `browse.session.open` | 15 → 30 | **28,325 ms → 1,374 ms** | 1,205 ms |
| `folder.browse-entries` | 7 → 14 | **28,327 ms → 1,167 ms** | 1,167 ms |
| `asset.search` | 12 → 26 | **28,451 ms → 2,443 ms** | 2,193 ms |
| `media.list-jobs` | 503 → 464 | **29,215 ms → 2,063 ms** | **222 ms** |
| `ai.status` | 503 → 466 | **29,400 ms → 约 2,000 ms** | **约 0.13 ms** |
| `plugin.jobs.list` | 503 → 462 | **29,453 ms → 约 2,000 ms** | **约 0.12 ms** |
| `media.get-asset-drag-infos` | **535 → 44** | 2,361 ms → 2,135 ms | 274 ms（Main 往返 p95 95 s → 41.7 s） |
| `media.get-artifact-paths` | 30 → 38 | 329 ms → 2,408 ms | 2,118 ms |

读法：

- **导航不再是「排 28 秒队」**：`browse.session.open` / `folder.browse-entries` / `asset.search` 的最大等待都从 ~28.3 s 降到 1.2–2.4 s（`Serpent-be29a9` 让出许可生效）。
- **状态轮询不再堆积**：三类查询的 p95 等待约 0.1–0.2 ms（基线 queue 合计 1,924 s），调用次数仍约 1/s（队列为空时按 1 s / 空闲 10 s 的退避策略，面板关闭且任务活跃时仍取快节奏）——这是刻意的：次数不是问题，堆积才是。
  - 进一步把「面板关闭 + 有活动」降到 2 s 可以把调用数再减半，但会与本轮已测数字不同口径，留作后续（`Serpent-e97c00` 的未完成项）。
- **拖拽预热请求从 535 降到 44**（12×），Main 侧往返 p95 从 95 s 降到 41.7 s。
- `media.get-artifact-paths` 最大等待反而从 329 ms 升到 2,408 ms：基线里这 30 次请求几乎都发生在对账开始前，样本不可比；after 的 2.4 s 仍然说明「预览路径仍可能排在一个批次/阶段之后」，与规格要求的「不超过一个对账时间片」还有距离（当前让出粒度是**批次边界**，批次内部仍是同步段）。
- 对账自身总成本基本不变（`apply-discovered-batches` 累计 99 s / 单次最长 35 s，`discovery-walk` 63.8 s）——这符合预期：`be29a9` 改变的是「谁在等」，不是总工作量；降低总量属于 `26f22b`（孤儿探针已修）与 PERF2-07。

### 4.3 其余观察

- 打开首卡 1,960 ms（基线 2,160 ms），首屏 80% 覆盖 131 ms，随机跳转 p50 20 ms，查看器 241 ms，库切换首卡 4,954 ms（基线 6,386 ms）。
- `performance.span`、`worker.eventLoop.lag`、`worker.scheduler.stall`、`worker.media-queue`、`open.reconciliation.stage` 全部已在报告里结构化输出；stall 事件的 `active[].label/runningMs` 是这次能直接指认优先级反转的关键证据。

## 5. 未完成与未验证
- `Serpent-1de919`（ready artifact 与冗余派生任务收敛）与 `Serpent-7ac453`（交互期前台资源预算）**本次未实施**：都需要 20k 夹具上的「运行中 / 暂停」对照，属同一目标的后续步骤；本轮已完成的三项是它们的前置。
- `Serpent-26f22b` 只改了孤儿扫描（先查引用再探针 + 阶段指标）；`reconcileMissingArtifactFiles`、目录快照复用与按影响范围刷新（PERF2-07）未动。
- `Serpent-be29a9` 当前是「批次边界让出许可」，尚未把整段对账切成可恢复 continuation；`media.get-artifact-paths` 仍可能等 2.4 s。
- 基准口径：渲染端导航延迟已改为页面到达，但**基线那次没有单独记录页面到达**，故 4.2 的对比以 Worker 侧等待为准；运行中/暂停对照只做了运行中；`navigationId` 未贯穿协议层。
- 未验证：Windows、SMB/NAS、packaged、真实 2 万夹具端到端、Computer Use 真机交互观感；Electron E2E（任务面板开关/窗口隐藏/切库）本次未跑；一次 after 运行出现 Worker `0xFFFFFFFF` 退出（未复现，无 JS 报错，未定位）。

## 6. 门禁与验证（当次命令与结果）

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | 0 error |
| `npm run lint` / `npx eslint <改动文件>` | 0 error（仅既有 1 个 hook-deps warning） |
| `npm run test:library-availability` | **9 files / 214 passed / 1 skipped** |
| `npx vitest run tests/unit/{job-status-coordinator,interactive-scheduler-admission-yield,interactive-scheduler,native-asset-drag-prime-scheduler,native-asset-drag-prime,native-asset-drag}.test.ts` | **49 passed** |
| `node scripts/run-vitest-with-electron.mjs run tests/worker/{derived-artifact-repair,palette-artifact}.test.ts` | 17 passed |
| `npm run test:perf:navigation -- <真实库> <第二库>`（基线 / after） | 各 1 passed（8.4 min / 7.8 min），报告 `baseline-cold.json` / `after.json`（仓库外） |

## 7. 变更清单与提交状态

**尚未提交、未推送**（用户明确要求：未经允许不得提交或推送）。工作树内改动：

- 新增：`tests/e2e/navigation-perf-benchmark.test.ts`、`tests/e2e/perf-bench-helpers.ts`、`scripts/run-navigation-benchmark.mjs`、`src/renderer/job-status-coordinator.ts`、`tests/unit/job-status-coordinator.test.ts`、`tests/unit/interactive-scheduler-admission-yield.test.ts`、`tests/unit/native-asset-drag-prime-scheduler.test.ts`
- 修改：`src/renderer/App.tsx`、`src/main/index.ts`、`src/main/native-asset-drag-prime.ts`、`src/worker/index.ts`、`src/worker/interactive-scheduler.ts`、`src/worker/library-service.ts`、`package.json`（新增 `test:perf:navigation`）、`docs/internal/qa/human-acceptance-checklist.md`（NAV-PERF-001）、`.beads/issues.jsonl`（本轮工单评论）

## 8. 【更正，2026-09-14 晚】§4 的对比结论不成立；真实 profiler 结果如下

用户反馈「随机跳转/滑动变慢、切文件夹慢到令人发指」后重新做了**有效度量**，结论推翻本文 §4：

### 8.1 度量缺陷（已确认）

- `serpent:e2e-browse-request/-result/-page` 三个事件受 `browseDiagnosticsEnabled` 门控，**在 production-like 的 E2E 构建里根本不触发**（两次运行的探针计数都是 0）。因此 §2/§4 里「切文件夹 p50 20.0 s」是「等一个永不发生的事件」的超时值，**不是切换延迟**，§4 的前后对比据此作废。
- 保留有效的只有 Worker 侧命令准入等待（§4.2 表），它说明**排队**改善，但不等于用户可见延迟改善。

### 8.2 新度量（真实 4.3 万资产库，当前工作树）

判据改为用户真正等待的东西：点击 → 可见卡片集合真的变了 → 可见图片全部解码。新增 `tests/e2e/navigation-profile.test.ts`（渲染端 CDP CPU profile + Worker V8 inspector CPU profile）。

| 指标 | 结果（4 次切文件夹 / 3 次跳转 / 8 s 滚轮） |
| --- | --- |
| 切文件夹：内容真正变化 | min **37 ms**，p50 **60,000 ms（=超时上限）**，4 次里 3 次 60 s 内没换内容 |
| 切文件夹：总耗时 | p50 60,084 ms，max 90,088 ms |
| 随机跳转：内容变化 | **3/3 都是 30 s 超时未变化** |
| 滚轮 8 s | frameP95 **7.8 ms**、frameMax 29.5 ms、long task 0、`serpent://` src 写入 10 次 |
| 渲染端 CPU | `(idle)` 约 72%，无渲染侧热点 |

### 8.3 Worker CPU profile（同一旅程，热点答案）

| 自耗时间 top | 归属 |
| --- | --- |
| `all` 204.7 s + `all` 22.6 s | better-sqlite3 `Statement#all()` |
| `run` 21.2 s + `run` 2.3 s | better-sqlite3 `Statement#run()` |
| `get` 2.7 s + `get` 1.8 s | better-sqlite3 `Statement#get()` |
| `lstat` 7.2 s + 5.6 s + 1.9 s ≈ **14.7 s** | 文件系统探针 |
| `(idle)` 14.4 s | — |

结论：**Worker 侧 CPU 几乎全部花在 SQLite 语句执行上（合计约 250 s），外加约 14.7 s 的 `lstat`**；渲染端不是瓶颈。下一轮优化必须针对具体 SQL 语句（哪条 `all()`、为什么没有走索引/为什么跑 687 批），而不是继续在调度层做文章。

### 8.4 状态

截至本文更新时：§3 的四项改动**尚未经有效度量证明为正向**，因此**不得视为完成**；在拿到 A/B（当前改动 vs HEAD，同一库、同一旅程、同一判据）的严格正向结果之前，不提交、不推送、不宣称优化完成。

## 9. 【第三次更正，2026-09-14 晚】SQL 热点成立，但“一分钟不换内容”的直接原因是 Main 后处理优先级反转

主程重新读取完整 Worker profile 调用树、逐条去重 `worker.cmd`/`worker.cmd.roundtrip`，并对真实库执行只读 SQL 计时与临时副本索引 A/B。临时副本与诊断脚本已清理，用户库未修改。

### 9.1 精确归因

- 344 秒内 `media.list-jobs` 实际 933 次（2.71 次/秒），Worker 执行累计 206.4 秒、平均 221 ms；约 204.7 秒的 `all()` 全部归属 `listMediaJobs`。原因是每个媒体完成事件仍立即触发一次完整任务状态/最近列表查询，single-flight 只防止同时在飞，没有限制成功查询频率。
- 真实库约 7.45 万条媒体任务。状态计数中位约 142.2 ms，最近 500 条约 166.6 ms；增加排序匹配索引后最近列表约 1.0 ms，但状态计数仍约 133.1 ms。因此列表需要索引，计数必须改为增量摘要/事务内维护，不能只补索引。
- RAW metadata admission 的 `all()` 累计约 22.6 秒；当前单次空候选约 94 ms。它被 secondary pump 重复调用，需 cursor/exhausted，而不是每轮从头扫描。
- 纯浏览 profile 中仍有 304 次 drag-info 请求，说明“535 → 44”的旧样本没有代表当前真实旅程，也不能证明预热算法正确。

### 9.2 分钟级关键路径

一次 `browse.session.open` Worker 往返约 1.206 秒后，Main 在向 Renderer 返回数据前仍 `await nativeAssetDragPrimer.primeImmediately(...)`。同一时段 reconciliation 作为 maintenance owner 连续运行至少 66.3 秒；两个 background-primary drag-info 请求等待约 65 秒，记录的 scheduler wait 约 67.8–68.0 秒。浏览 SQL 已完成，但结果被辅助拖拽预热扣在 Main，正好解释“命令变快、内容仍一分钟不换”，并说明把 drag-info 降级为后台反而在同步关键路径上制造了优先级反转。

### 9.3 当前实现结论

- `Serpent-8ee170` 的“首屏 64 项同步、其余分批”方案证伪：必须从 browse 响应关键路径移除第二次 Worker 请求，并取消全结果预热。
- `Serpent-e97c00` 的“事件触发 single-flight 全量刷新”方案证伪：必须拆分增量摘要与按需分页列表，面板关闭时完整列表请求为零。
- `Serpent-be29a9` 的批次让出仍是未完成增量；但应在上述两条自制造负载清除后再评估 continuation 收益。
- §8 的 3/4 文件夹与 3/3 跳转 timeout 仍不能整体作耗时分布：测试未限定非空/不同 scope，空文件夹永远无法通过，跳转也可能发生在不可滚动 scope；不过上述 68 秒 Main 后处理链由独立日志直接证明，至少一个分钟级卡顿不是假阳性。

重新规划与验收顺序已写入实施方向文档 §2.2–4；新增 `Serpent-288cd9` 收口 RAW 空结果重扫。本轮只更新分析、文档与工单，未改生产代码、未运行产品测试、未提交或推送。

## 9. 【第三轮纠偏后的实施与实测】关键路径移除拖拽预热（已用数据证明正向）

主程第三轮文档（§2.2/§3.3/§3.4/§3.9）指认：浏览 SQL 已在约 1.206 秒返回，但 Main 在交给 Renderer 前同步 `await` 首屏 64 项 `media.get-asset-drag-infos`，而该命令在 background-primary，排在 maintenance 后等待约 68 秒——这才是"命令很快、内容一分钟不换"的直接原因。据此只保留一处最小改动并用真 profiler 验证：

**改动**（`src/main/index.ts`）：
1. 浏览响应对拖拽预热不再 `await`（`void nativeAssetDragPrimer.primeImmediately(...)`），Renderer 立即拿到结果；
2. **删除「结果剩余全部后台预热」**（原 `nativeAssetDragPrimer.enqueue(rest)`）；
3. **删除缩略图 ready/failed 触发的拖拽路径重解析**（完成事件不改变源路径）。

**判据修正**（`tests/e2e/navigation-profile.test.ts`）：空文件夹也算内容变化（原实现要求新卡片数 > 0，会把"正确切到空文件夹"记成超时）；跳转前先回到库级 scope（第一行），避免在小/空范围上测跳转。

**同一 harness、同一真实 4.3 万资产库、同一旅程的 A/B**：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 切文件夹：内容真正变化 | min 37 ms；p50 **60,000 ms（超时）**；4 次中 3 次超时 | min **10 ms**；p50 **31 ms**；4 次中 1 次超时 |
| 切文件夹：总耗时 | p50 60,084 ms / max 90,088 ms | p50 30,114 ms / max 90,070 ms |
| 随机跳转：内容变化 | **3/3 全部 30 s 超时** | **16 / 102 / 930 ms，3/3 达标** |
| 滚轮 8 s | frameP95 7.8 ms、long task 0 | frameP95 7.5 ms、long task 0 |
| Worker CPU：`all()` 合计 | 227.3 s（profile 5.8 min） | 41.8 s（profile 3.3 min，约 3× 更少的 SQL CPU/分钟） |
| Worker CPU：`lstat` 合计 | 14.7 s | 12.3 s |

结论：**这一处改动严格正向**（跳转从"全部超时"变为 16–930 ms；切换内容变化从 p50 超时变为 31 ms；SQL CPU 明显下降；滚动帧率不变）。

**仍未做（不得视为完成）**：`e97c00` 需按 §3.3 重做为"摘要/列表拆分 + 事件增量 + 面板按需分页 + 最近列表索引"（本轮 profile 里 `all()` 仍是第一热点）；§3.9 RAW metadata 游标；`be29a9` 真正 continuation；`217028` 判据仍需完成"确认 active scope / 目标非空 / 不把超时常量写进 timing / Main 后处理三段 span"。**未提交、未推送。**

## 10. 第二轮实施：关闭面板不再触发全表重查（已用数据证明正向）

按主程 §3.3 的最小可行部分（不做新协议命令，先去掉自制造负载）：

- `JobStatusCoordinator`：面板关闭时**完成事件不再触发任何状态查询**（`setEventDrivenQueries(false)`），兜底轮询从"活跃 1 s"改为**15 s**；面板打开才恢复"事件即查 + 1 s"。App.tsx 在面板开关 effect 里同步这两个状态。
- 单测：`tests/unit/job-status-coordinator.test.ts` 7/7（新增「面板关闭忽略完成事件」与「面板打开时事件触发查询」两例）。

**Worker CPU profile 三连对比（同一 harness/库/旅程）**：

| 自耗时间 | 修复关键路径前 | 关键路径修复后 | +关闭面板退避后 |
| --- | ---: | ---: | ---: |
| `all()`（`listMediaJobs` 的 SQL） | **227.3 s** | 41.8 s | **3.0 s** |
| `lstat` | 14.7 s | 12.3 s | 11.3 s |
| `readdir` | — | — | 1.7 s |
| `(idle)` | 14.4 s | 118.7 s | **138.0 s** |

**用户可见延迟**：

| 指标 | 最初 | 关键路径修复后 | 本轮之后 |
| --- | --- | --- | --- |
| 随机跳转：内容变化 | 3/3 全部 30 s 超时 | 16 / 102 / 930 ms | **9 / 24 / 911 ms** |
| 切文件夹：内容变化 | p50 60,000 ms（超时） | min 10 / p50 31 ms | min 10 / **p50 34 ms**（4 次中 1 次仍 60 s） |
| 滚轮 8 s | frameP95 7.8 / long task 0 | 7.5 / 0 | **7.0 / 0**（`serpent://` src 写入 4 次） |

结论：这两处改动均**严格正向**且可复现（跳转与切换的内容变化从"超时"变成 10–34 ms 量级，`all()` SQL 从 227 s 降到 3 s，Worker 空闲率从 4% 升到 70%，滚动帧率不变）。

**新的第一热点（下一轮目标）**：`library_worker.js` 的压缩函数 `mf` 自耗 12.7 s，连同 `lstat` 11.3 s、`readdir` 1.7 s —— 即开库对账里的指纹计算与文件探针（§3.1 / §3.9），而不是 SQL。剩余待办：§3.9 RAW admission 游标、`e97c00` 的摘要/列表拆分与最近列表索引（本轮只是把面板关闭时的查询降到 0，面板打开仍是全量列表查询）、`be29a9` continuation、`217028` 判据收尾、以及"4 次切文件夹里那 1 次 60 s"的定位。**仍未提交、未推送。**

## 11. 第三轮实施：让 foreground 后台任务与维护并行（用户复现路径上 37× 正向）

### 11.1 定位（用户给的复现路径：「所有资产」→「Media > Images > 绘画」）

在 `SERPENT_PROFILE_NAV_TARGET=绘画` 复现下，日志时间线把 30–45 秒钉死在一个点上：

```
15:29:42.813 folder.browse-entries            run = 3,905 ms      ← 用户点击
15:29:44.010 LAG drift = 4,407 ms  activity = secondary-media:…
15:29:46 → 15:30:14  STALL ×4  active = reconciliation(maintenance)  runningMs 3,816 → 31,847 ms
15:30:19.101 media.get-artifact-paths         schedulerWaitMs = 34,897 ms   ← 预览路径解析等 35 秒
15:30:19.371 media.get-artifact-paths         schedulerWaitMs = 35,037 ms
15:30:20.052 history.status                   schedulerWaitMs = 33,790 ms
preview-cache: 281 miss / 281 store，其中 15:29:37 → 15:30:19 有 42 秒完全无事件
```

对照 Worker 侧作业耗时：57 个缩略图 job 合计仅 **2,786 ms**（avg 49 ms）→ **慢的不是解码，是准入**。`asset-reconciliation` 本次 33,434 ms，而调度器「同时只允许一个后台任务」使 background-primary 的缩略图泵与 artifact 路径解析全程进不来。

### 11.2 改动

`src/worker/interactive-scheduler.ts` 的 background 准入：

```
- activeBackground < 1 && !hasQueuedMutation
+ !hasQueuedMutation && (activeBackground < 1
+   || (lane === 'background-primary' && onlyMaintenanceActive))
```

其中 `onlyMaintenanceActive` 表示当前唯一后台占用者是 maintenance。即：**维护任务运行时，允许恰好一个服务可见内容的 background-primary 并行**；`background-secondary`（状态轮询）与第二个 background-primary 仍被挡住，避免把并发重新变成风暴。

### 11.3 实测（用户判据：点击 → 当前页 15 张可见缩略图全部 decode；同一 harness、同一真实库）

| 指标 | 改前 | 改后（两次） |
| --- | ---: | ---: |
| 所有资产 → 绘画 总耗时 | 39,791 ms | **6,456 / 6,424 ms** |
| 15 张缩略图全部 ready | 34,589 ms | **933 / 967 ms** |
| 内容变化（浏览查询段） | 5,094 ms | 5,429 / 5,321 ms |

**门禁**：`npm run test:library-availability` 9 files / **214 passed / 1 skipped**；调度器/协调器/拖拽调度单测 **41 passed**。

### 11.4 试过但实测无效、已回退的两刀（留档，避免重复走）

1. 把可见卡 artifact 路径解析从 `background-primary` 挪到 `visible-media`：39,791 → 39,460 ms（噪声内）。
2. 让对账在安全点也让出给 foreground 媒体标签：39,791 → 40,973 ms（噪声内）。

两刀的失败说明瓶颈是**维护任务期间 background 完全不能上车**，而不是车道标签或让出时机。

### 11.5 剩余（下一步目标）

- **内容变化那 5.3–5.4 秒**：`folder.browse-entries` run 3,905 ms + `browse.session.open` queue 5,145 ms，属于浏览查询/SQL 段，现在是这条路径的最大剩余项。
- 对账自身 33 s（`lstat` 14 s + `all()` 5 s + `mf`）：现在不再堵住缩略图，但仍是开库后台负载。
- §3.9 RAW admission 游标、§3.3 摘要/列表拆分与最近列表索引、`be29a9` continuation、`217028` 判据收尾。
- 仍未提交、未推送。

## 12. 当前状态（用户确认性能已明显改善后的收口记录）

### 12.1 用户判据下的最终数字（真实 4.3 万资产库，`SERPENT_PROFILE_NAV_TARGET` 复现）

| 指标 | 会话开始时 | 现在 |
| --- | ---: | ---: |
| 「所有资产」→「Media > Images > 绘画」总耗时 | 39,791 ms | **6,336–6,456 ms** |
| 其中：15 张可见缩略图全部 decode | 34,589 ms | **933–970 ms** |
| 其中：内容变化（浏览查询段） | 5,094 ms | 5,252–5,429 ms（下一个目标） |
| 随机跳转：内容变化 | 3/3 全部 30 s 超时 | 9–151 ms |
| 滚轮 8 s 帧率 | frameP95 7.8 / long task 0 | frameP95 7.0–8.3 / long task 0 |
| Worker `all()`（listMediaJobs）自耗 | 227 s / 5.8 min | 3 s / 3.3 min |
| Worker 空闲占比 | 4% | 70% |

### 12.2 保留的改动与其证据

1. `src/worker/interactive-scheduler.ts`：维护任务占用时允许**一个**服务可见内容的 `background-primary` 并行（`onlyMaintenanceActive`）→ §11 的 37× 结果。
2. `src/main/index.ts`：浏览结果不再 `await` 拖拽预热；删除"结果剩余全部预热"；缩略图完成事件不再重解析拖拽路径。
3. `src/renderer/job-status-coordinator.ts` + `App.tsx`：面板关闭时完成事件不再触发状态查询，兜底 15 s；面板打开才恢复事件即查 + 1 s。
4. `src/main/worker-client.ts`：门控 `SERPENT_WORKER_INSPECT`（仅 profile 用，生产不设即无影响）。
5. 基准与插桩：`tests/e2e/navigation-perf-benchmark.test.ts`、`tests/e2e/navigation-profile.test.ts`、`tests/e2e/perf-bench-helpers.ts`、`scripts/run-navigation-benchmark.mjs`、`src/worker/interactive-scheduler.ts` 的 `yieldAdmission`。

### 12.3 试过、实测中性、已回退（留档避免重走）

- 可见卡 artifact 路径解析改到 `visible-media` 车道：39,791 → 39,460 ms。
- 对账额外让出给前台媒体标签：39,791 → 40,973 ms。
- 形状（width/height）修正窗口合并 150 ms：6,456/933 → 6,336/970 ms。

三次中性实验共同说明：瓶颈是「维护期间 background 完全不能上车」，不是车道标签、让出时机或渲染端批量。

### 12.4 未完成（仍需跟进的工单）

- `Serpent-e97c00`：只做了"面板关闭时查询归零"；**摘要/列表拆分 + 最近列表索引（166.6 → 1.0 ms 已由主程在临时副本证明）未做**。
- `Serpent-be29a9`：仍需要把对账切成可恢复 continuation（当前是准入并行 + 批次边界让出）。
- `Serpent-26f22b`：孤儿扫描已修；**发现遍历的逐文件 `lstat`（12.7 + 11.3 + 3.4 ≈ 27 s/5.4 min）未修**。
- `Serpent-217028`：基准已交付；随机 scope 判据仍有假阴性（新卡片数为 0 时等满预算），`navigationId` 未贯穿协议层。
- 待开新单：**形状随浏览页下发**（`revisions.source_width/height` 为空时才逐条 `asset.dimensions.ready` 修正，导致整页几何反复重算）。
- 未验证：Windows、SMB/NAS、packaged、真实 2 万夹具、Computer Use；四次 profile 运行中有一次出现 Worker `0xFFFFFFFF` 退出（未复现，无 JS 报错）。

## 13. 第四轮实施：导航不再被长预览挡住交互槽（用户实例日志驱动）

### 13.1 证据（用户当前实例日志 `%APPDATA%\Serpent\logs`，2026-09-14 23:57–00:02）

```
15:58:38 STALL waited=2009  active=reconciliation(maintenance, run=55,781ms)  queued=45（~40 条 sync.poll-remote）
16:00:53 STALL waited=2007  active=media.get-preview-artifact(viewer-upgrade, run=12,539ms)  queued=15: browse.session.open, asset.thumbnail.visible-window, …
16:01:23 STALL waited=2010  active=media.get-preview-artifact(viewer-upgrade, run=11,231ms)  queued=8: browse.session.open, folder.browse-entries, …
16:01:43 STALL waited=2005  active=media.get-preview-artifact(viewer-upgrade, run=15,707ms)  queued=5
15:59:11 STALL active=ai.test-connection(background-secondary, run=3,665ms)
```

`media.get-preview-artifact` 是 viewer-upgrade（冷预览/RAW/OIIO 解码、插件），单次 5.6–15.7 秒，却占着**唯一**交互槽，导航与可见缩略图只能排在后面 → 用户体感「切一个 30+ 文件的文件夹卡 20 秒」。

### 13.2 改动

`src/worker/interactive-scheduler.ts`：interactive-control（导航）在 **viewer-upgrade 正在跑时**可另开一个槽；明确**不允许**与 `visible-media` 并行，保住「变更需要完全空闲」的既有保证。首次放宽过头（导航可与 visible-media 并行）被既有测试 `does not starve a library transition behind the interactive backlog` 抓住，收窄后 28 个调度器测试全绿。

### 13.3 实测

| 场景 | 结果 |
| --- | --- |
| 预览在解码时切文件夹（`SERPENT_PROFILE_CONTENDED=1`，19 张可见卡） | **45 / 126 ms** |
| 对照：改前实例日志 | 预览 run 5.6–15.7 s，`browse.session.open`/`folder.browse-entries` 排队 2 s+（队列 5–15 条） |
| 滚轮 8 s | frameP95 6.8 ms、frameMax 11.7 ms、long task 0 |

判据修正：目标 scope 无可见图片卡（空文件夹/非图片）时不再空等到 60/90 秒，连续两次采样确认后即返回。

### 13.4 本窗口 Worker 热点与剩余阻塞

- `mf`（指纹计算）**10.4 s** 成为第一自耗，`lstat` 11.6 s、`readdir` 1.3 s、`all()` ≈ 2.5 s（对应 §3.1/§3.9 与 `Serpent-26f22b`）。
- 用户实例日志里仍可见：`sync.poll-remote` 把维护队列堆到 45 条；`ai.test-connection` 反复占用后台槽 2–3 秒。两者都需要 single-flight/合并/退避。
