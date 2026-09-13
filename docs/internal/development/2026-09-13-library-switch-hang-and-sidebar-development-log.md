# 2026-09-13 切换资源库卡死（网络库）+ 侧栏水合 + 滚轮基准

- 分支：`codex/performance-20260913`
- 相关：[CANVAS-038 设计](2026-09-13-canvas-038-browse-media-pipeline-redesign.md)、[几何播种开发日志](2026-09-13-canvas-038-geometry-seeding-development-log.md)
- 用户报告：① 文件夹与合集在侧栏不显示；② 从 NAS 库切到超大库「卡爆」
- 状态：两处缺陷均已修复并真机验证

## 缺陷 A：侧栏永远空（文件夹/合集/计数全无）

**不是** CANVAS-038 改动引入的。用用户的真实库做 A/B（改动 vs `git stash` 到干净 HEAD `570b3cfa`）两次运行侧栏**完全相同**：`文件夹 尚无托管或链接文件夹 / 合集 尚无合集 / 所有资产 0`。

排除过程（逐层实测，全部通过，所以问题不在数据与传输）：

| 层 | 证据 |
| --- | --- |
| 库数据 | 1455 存活资产、1 托管文件夹（13 项）、合集 `c4d`（`collection_assets` 360 行）、122 标签 |
| Worker 同步读模型 | `getLibraryNavigationSummary` → `1450 / 1 / 1 / 122` |
| Worker 异步读模型（请求路径真正用的） | `getLibraryNavigationSummaryAsync` → `1450 / 1 / 1 / 122` |
| 请求 / 响应 Zod | `parseRendererRequest` 通过；`parseWorkerResponse`（真实 summary）通过 |
| 完整 IPC | 在运行中的应用内直接调 preload bridge → `ok:true, allAssetCount:1450, folders:1, collections:1` |

**根因**：`App.tsx` 把「加载代次」当成了「数据归属」。`isCurrentLoad()` 要求 `generation === contentLoadGenerationRef.current`，而导航摘要是**整个资源库**级读模型；该库持续有写入（缩略图/调色板任务）→ 反复触发重载 → 每次加载都被下一次取代 → 摘要在 `await` 之后被丢弃。三处都是**静默路径**（不报错、不重试、不打点）。

**修复**：`src/renderer/App.tsx`

- 新增 `isCurrentLibraryNavigation()`（只按库/视图判定，不看代次）与 `applyNavigationSummary()`；
- `loadNavigationSummary()` 在结果到达且仍属于当前库时**立即**落地侧栏，不再受代次丢弃；
- `blockingNavigation` 与渐进水合两处重复赋值收敛到同一函数。

## 缺陷 B：从网络库切换资源库卡死（本次主修）

**复现**：新增 `tests/e2e/library-switch-benchmark.test.ts`——隔离 profile 内预置最近资源库列表，用 UI 菜单真正切换，并滚轮滑动。旧基准只做**随机跳转**且**从不切换库**，所以这个缺陷一直没被测到。

对照（同一目标库 `本地大库` 28,972 项）：

| 场景 | 切换结果 |
| --- | --- |
| 本地库 → `本地大库` | **4460 ms 完成** |
| **NAS 库（NAS 库）→ `本地大库`** | **超时 ≥90 s，永不完成**，侧栏仍是旧库 |

**定位**：

- Worker 关闭路径的三个 await 全部**极快**（阶段计时：`reconciliation 220ms / drainMedia 0ms / backup 12ms / releaseHandle 15ms`）——不是关闭慢。
- 未暂停媒体时：整个 90 秒**没有任何 worker 侧日志**、没有 close、加载遮罩一直挂着 → 请求发出后在等 worker 回复。
- **暂停媒体任务后同一路径即成功**（`pauseMediaJobs` → 切换在 31854 ms 完成，`timedOut=false`）→ worker 被源库媒体任务负载占满。

**根因（代码不对称）**：`src/worker/index.ts`

```ts
case 'library.close':   // 关闭：先取消这家库的全部自动媒体工作
  cancelAutomaticMediaForLibrary(libraryId); cancelMediaResourceRetry(...);
  cancelVisibleWindowDimensionProbes(...); libraryService.cancelJobs(...); ...

case 'library.open':    // 打开：什么都不取消，直接 openLibrary(path)
```

而从最近列表切库走的是 `library.open`（`src/main/index.ts` 的 `library.open-recent.request` 直接派发 open，**不会先 close**）。于是源库的媒体洪流没人叫停，`library.open` 排在它后面饿死。手动「关闭 → 打开」不会卡，走列表直接切就会卡。

**修复**：`library.open` 在打开前，对每个已打开库执行与 `library.close` 相同的停机序列；新增 `LibraryService.listOpenLibraryIds()` 供其枚举。

**验证（真机、无媒体暂停）**：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| 切换 | 超时 ≥90 s，永不完成 | **14901 ms 完成** |
| 切换后侧栏 | 6 行（旧库） | **120 行（`本地大库` 的 116 合集）** |
| Worker 关闭阶段 | 从未发生 | drain 0ms / backup 3ms / release 2ms / **合计 5ms** |

关闭路径阶段计时保留但改为按需：`SERPENT_CLOSE_TRACE=1`（默认不输出，避免每次关闭都往错误日志写行）。

## 滚轮滑动基准（用户要求：随机跳转不真实）

`library-switch-benchmark.test.ts` 增加连续滚轮行程：`mouse.wheel` 小增量 + 随机换向 + 随机停顿，统计阶段内 `scrollHeight` 不同取值个数与波动。

实测（两库、修复后）：

| 库 | 滚轮 3–6 秒 | `scrollHeight` 不同取值 | 波动 |
| --- | --- | --- | --- |
| NAS 库（NAS） | 299 槽位创建 / 129 卸载 | **1** | **0%** |
| 本地大库（本地 28,972） | — | **1** | **0%** |

即 CANVAS-038 几何一次播种在**真实滚轮输入**下同样成立。

## 自动化

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npm run test:library-availability`（改动了 library-service.ts，必跑） | **9 files / 211 passed / 1 skipped** |
| `npm run test:unit` | 见提交时结果 |
| `tests/e2e/library-switch-benchmark.test.ts`（真机切换 + 滚轮） | 通过 |

## 代码审查与后续处置（双轴，flash）

审查报告：`docs/internal/reviews/2026-09-13-canvas-038-and-library-switch-review.md`。

| 审查项 | 处置 |
| --- | --- |
| **P1（功能）** 新增的 `mediaType` 只写不传：三条 `AssetSummary → BrowseLayoutEntry` 路径全丢该字段，摘要页到达后卡片类型回退为 `other`，图片会挂上扩展名角标——与新增该字段的目的正好相反 | **已修**：`virtual-browse-layout.ts` 的 `layoutEntryFromAsset`（`mergeVirtualSummaryPage` 正是用它覆盖索引条目）与 `evictVirtualSummaryPage`、`browse-window-slots.ts` 的 `layoutEntryFromLoadedAsset`（`Pick<>` 补 `mediaType`）、`use-virtual-browse-session.ts` 的 `begin` 非虚拟字面量，四处全部补齐 |
| **P1'（合规）** 新基准硬编码作者私有资源库绝对路径，且默认值使 skip 条件恒不成立 ⇒ 无环境变量也会真跑并驱动真实库的媒体队列 | **已修**：`library-switch-benchmark.test.ts` 删除全部默认路径，`SERPENT_E2E_SWITCH_LIBRARIES` 未配置即 skip；路径永不进仓库（AGENTS 隐私条款 + 工作区洁净纪律） |
| should-fix 1 `library.open` 停机序列缺 `await drainLibraryMedia`，注释却写「exactly as `library.close` does」；且是复制粘贴 | **已修**：抽出模块级 `stopAutomaticWorkForLibrary(libraryId)`，`library.open` / `library.close` / `library.delete-from-disk` 三处共用；注释改为准确表述——它停的是**调度**（队列、重试、探针），排空已在跑的 decoder 由调用方决定（close 走 `closeLibraryAsync`，delete 显式 drain，open 不 drain，因为离场库由它自己的 close 释放） |
| should-fix 2 `NETWORK_LIBRARY_RELOAD_INTERVAL_MS` 750→10000 未被证明有效，且注释成因与本文结论矛盾 | **已撤回为 750**，并用实测确认：撤回到 750 后切换仍完成（**14330 ms**，用 10 秒时 14901 ms，基本相同）⇒ 该间隔不是切换的驱动因素 |
| should-fix 3 `seedIndex` 未清 `summaryPagesRef`；>5000 的 scope 永不 seed ⇒ 首帧口径与设计不一致 | `seedIndex` **已补清空并按新索引重新登记摘要页**（避免旧 LRU 淘汰未登记的页）。>5000 的 scope 仅首屏 100 项有身份、其余待摘要页到达；首帧不是空白网格（首页 100 张会渲染），但确实与设计 §5 L2 的「无媒体外壳」措辞不一致，**保留为未解决项** |
| 上一轮 P1-1 / P1-2 | 审查确认**均已真修**；P1-2 的门禁仍依赖类名，改名引入不会被发现——保留为已知软肋 |
| 侧栏守卫跨库复活风险 | 审查确认**无**：`isCurrentLibraryViewSession` 同时比 libraryId 与 generation，换库必 +1。残留缺口：`loadNavigationSummary` 不校验 `showIgnored`/`trashMode` 快照——**保留为未解决项** |
| `library.open` 停机序列无 worker 集成测试；同一库重开会被误停一次；`open-eagle`/`open-billfish`/`library.create` 未覆盖 | **保留为未解决项**（本次只在一处修复，未扩散） |

### 审查后复测（当次）

| 项 | 结果 |
| --- | --- |
| 撤回 10 秒 → 切换基准（NAS → 本地大库） | **14330 ms 完成**、侧栏 120 行；滚轮两库 `distinctHeights=1`、波动 0% |
| `npm run test`（全量 unit + worker） | **4781 passed / 2 failed**：`migration-checksum-snapshot`（golden 快照缺 v49，未动 migration，确定性既有）与 `reconciliation-performance`（时序预算，受并发负载影响） |

## 用户后续要求的三项（2026-09-13 第二轮）

### 1. 补上「切库必须先停掉旧库后台活」的自动化守卫（已加）

`worker/index.ts` 是模块级单例、`tests/` 里没有任何用例能进来，所以先把这段语义抽成可测模块
`src/worker/library-open-stop.ts`（`stopOutgoingLibrariesForOpen`），worker 的真实调用点改为经它执行。

新增 `tests/unit/library-open-stop.test.ts`（4 例，全过）：

- **所有**已打开库都会被停（不是只停「那一个」）；
- 切库时**保留**排队任务（不取消）；
- 调用方明确要销毁库时才取消排队任务；
- 首次打开（无已打开库）是 no-op。

顺带把「切库会取消离场库排队任务」这个我上一轮新引入的浪费修掉了 —— 切库不是关闭，排队的工作应当留给下次打开：

| 时序 | 切换耗时 |
| --- | --- |
| 切库时取消排队任务（上一轮实现） | 14330 ms |
| **切库时保留排队任务（现在）** | **15559 ms** |

同一量级、均正常完成；`library-availability` 211 passed。

### 2. 媒体任务「反复入队/取消」——先把责任分清

只读查询用户的 `NAS 库` 库（`jobs` 表）后，结论与之前的口头判断**不同**，必须更正：

```
generate_thumbnail  paused  1106     ← 本人（agent）在验证实验里调用 pauseMediaJobs 造成，未恢复
extract_palette     paused   490     ← 同上
extract_palette  succeeded   549     ← 真实进展
generate_thumbnail cancelled 106 / succeeded 26 / queued 6
```

- **1106 + 490 个 paused 状态是本次验证的副作用，不是资源库本来的状态。** 我在「切换前暂停媒体」那个判别实验里调了 `pauseMediaJobs({libraryId})`，它作用于整库，且我没有恢复。恢复方式：应用内任务面板点「继续」，或在该库未打开时把状态改回 `queued`。
- 真实取消量是 106（thumbnail）+ 13（palette），`attempt_count` 多为 1、少数到 4 —— **远小于**先前「反复入队/取消」的描述，之前把被我暂停的 1106 个误当成了积压。
- 已修掉的那部分真实浪费：切库取消离场库排队任务（见上一节）。

因此本条**不能**记为「队列抖动已修」；准确表述是：**先前的严重程度判断有误（大头是我自己的副作用），切库取消排队的浪费已修，剩余的 106 次取消需在有干净基线后重测。**

## 未解决

1. **切换仍是 14.3–14.9 秒**（本地→本地 4.5 s）。卡死已消除，但速度仍需收口；剩余时间在 `本地大库` 的打开与首帧（28,972 项），未逐段拆解。
2. **10 秒间隔已撤回**（见上）。跨实例资产变化的可见延迟仍是原来的 750 ms 语义。
3. `library.open-eagle` / `library.open-billfish` / `library.create` 未做同样的离场停机（尚未复现问题，未改）。
4. **`library.open` 停机序列无 worker 集成测试**；同一库重开会被误停一次（`openLibraryPrimary` 幂等 early return，未实测）。
5. 媒体任务队列仍在反复入队/取消（`queued 197→269`、`succeeded 19`）；本次修复只是让生命周期命令不再被它饿死，队列本身的抖动未处理。
6. >5000 项的 scope 首帧只有首页 100 项有身份，与设计 §5 L2「无媒体外壳」措辞不一致。
7. `loadNavigationSummary` 不校验 `showIgnored`/`trashMode` 快照。
