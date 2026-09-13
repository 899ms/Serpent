# 2026-09-13 CANVAS-038 几何一次播种 + 切换/侧栏缺陷修复 — 双轴代码审查

- 固定点：`570b3cfa`（当前 HEAD）
- 审查对象：工作区未提交改动（`git status --short --untracked-files=all` = 25 修改文件 + 2 未跟踪测试文件，`git diff --stat` = 25 files +695/−491）与未跟踪文件
  `tests/e2e/browse-nas-performance.test.ts`、`tests/e2e/library-switch-benchmark.test.ts`
- 模型：DeepSeek Harness（deepseek-flash）。一次审查同时覆盖 Standards 与 Spec 双轴。
- 规格来源：[`2026-09-13-canvas-038-browse-media-pipeline-redesign.md`](../development/2026-09-13-canvas-038-browse-media-pipeline-redesign.md)、
  [`2026-09-13-canvas-038-geometry-seeding-development-log.md`](../development/2026-09-13-canvas-038-geometry-seeding-development-log.md)、
  [`2026-09-13-library-switch-hang-and-sidebar-development-log.md`](../development/2026-09-13-library-switch-hang-and-sidebar-development-log.md)
- 上一轮审查：[`2026-09-13-canvas-038-geometry-seeding-review.md`](2026-09-13-canvas-038-geometry-seeding-review.md)（其 P1-1/P1-2 与 should-fix 的落盘情况逐条复核，见 §4）
- 规范来源：`AGENTS.md`、`CLAUDE.md`、`docs/internal/development-process.md`
- 本次审查为只读：未修改任何源码/测试/配置。唯一写入为本文件。未运行任何测试、未启动 Electron；仅实跑 `npx tsc --noEmit`（exit 0，`job pwsh-78`）。

## 0. 结论摘要

方向正确且比上一轮明显干净：分块几何协议**全链路删除且无残留引用**（全仓 grep `browse.session.geometry` 仅命中一处注释、`readBrowseSessionGeometry` 仅命中两处测试调用点）、
槽位身份改为 index-only 且虚拟路径不再渲染影子卡、`library.open` 的停机序列确实解掉了「切换永不完成」、侧栏守卫按库/视图代次判定（`isLibraryViewSession` 语义正确，无法跨库复活）。
`npx tsc --noEmit` exit 0。

但有 **1 个必须修的缺陷（P1）**，它落在本轮新增功能的正中央：

**P1 — 索引新增的 `mediaType` 只写不传，虚拟卡片的类型在摘要页到达后回退为 `other`。**
worker 写入侧正确（`library-service.ts:31762-31781`），但渲染侧三条把 `AssetSummary` 转回 `BrowseLayoutEntry` 的路径全部丢掉 `mediaType`：
`virtual-browse-layout.ts:35-53`（`layoutEntryFromAsset`）、`browse-window-slots.ts:150-175`（`layoutEntryFromLoadedAsset`）、
`use-virtual-browse-session.ts:177-188`（`begin` 的手写字面量）。而 `mergeVirtualSummaryPage`**就是用 `layoutEntryFromAsset` 覆盖索引条目**的，
于是「索引带 `mediaType`」只维持到该槽位的摘要页到达为止。这正是 `asset-types.ts:217-223` 注释与设计 §5 L2 明确要防的那句
「Without it a synthesized slot would have to guess `other` and change the card's appearance once the summary landed」——实现把要防的行为做出来了。
同一批遗漏还有 `evictVirtualSummaryPage`（`virtual-browse-layout.ts:277-290`）不保留 `mediaType`。

另有 **1 个必须修（合规）**：

**P1' — `tests/e2e/library-switch-benchmark.test.ts:28-31` 硬编码了开发机私有资源库绝对路径与个人目录名，且该文件在没有环境变量时也会用这些默认路径真跑。**
`DEFAULT_LIBRARIES = ["NAS 库", "本地大库"]`；跳过条件是 `libraryPaths.length < 2`（`:161`），而默认值本身就 ≥2，
所以 `npx playwright test`（playwright.config `testDir: 'tests/e2e'`）会直接打开作者的真实 NAS 库并驱动其媒体队列（按开发日志口径每次多产生 100+ 待办任务与库写入）。
这同时违反 `AGENTS.md`「隐私与本地环境信息（强制）」与「不污染用户工作区/临时产物有始有终」，并与任务说明里「both skip without env vars」不符。

`library.open` 修复本身**不阻断合并**（首开安全、无并发 close 时无竞态、停机序列与 `library.close` 的前半段逐行一致），但它是**复制粘贴**而非抽函数，且遗漏了 `library.close` 的 `drainLibraryMedia` 一步（见 Spec 轴 L-1/L-2）。
10 s 刷新间隔**不应以「已修复」身份保留**（见 Spec 轴 L-5）。

---

## 1. Axis 1 — Standards

| # | 项 | 判定 | 证据 | 处置 |
| --- | --- | --- | --- | --- |
| S1 | 跨进程不变量：删除协议面是否彻底 | 通过 | `src/main/index.ts`（删 `browse.session.geometry.request` 转发）、`src/preload/index.ts:1397-1425`（删 `fetchBrowseSessionGeometry`）、`src/shared/protocol/requests.ts`（renderer request + worker command 两处 discriminatedUnion 成员）、`src/shared/protocol/responses.ts`（`assetOperationSuccessSchemas` 成员 + import）、`src/shared/asset-types.ts`（`browseGeometryEntrySchema`/`browseGeometryBlockSchema`）、`src/shared/library-api.ts`、`src/shared/performance-contract.ts:337-340`（`NON_PREEMPTIVE_MEDIA_COMMANDS`）、`src/worker/index.ts` case 全部删除。全仓 grep `browseGeometryEntry\|browseGeometryBlock\|fetchBrowseSessionGeometry\|geometryBlockStartsForRange\|BrowseGeometryBlockCache\|ensureVirtualGeometryRange\|mergeVirtualGeometryBlock\|evictVirtualGeometryBlock` → **0 命中**；`browse.session.geometry` → 仅 `library-service.ts:31030` 一处注释 | note |
| S2 | 校验未被削弱 | 通过 | 保留的 `browse.session.ids` 请求/命令/响应 schema 未改；`browseLayoutEntrySchema` 仍是 `z.strictObject`（`asset-types.ts:202`），`mediaType` 为 `.optional()` 枚举（`:223`），旧库/旧客户端缺该字段仍通过；未触碰 `MIGRATIONS`；worker 对 `mediaType` 只写合法枚举（`library-service.ts:31762` 走 `toSummaryMediaType`） | note |
| S3 | **`mediaType` 只加不改，但只写不传（渲染侧三条路径丢字段）** | **发现** | ① `src/renderer/browse/virtual-browse-layout.ts:35-53` `layoutEntryFromAsset` 返回对象**不含** `mediaType`，而它正是 `mergeVirtualSummaryPage`（`:212-226`）每次摘要页到达时用来**覆盖**索引条目的构造函数；② `:277-290` `evictVirtualSummaryPage` 重建 geometry 条目时同样不保留 `mediaType`；③ `src/renderer/browse-window-slots.ts:150-175` `layoutEntryFromLoadedAsset` 的 `Pick<>` 里没有 `mediaType`；④ `src/renderer/browse/use-virtual-browse-session.ts:177-188` `begin` 手写字面量也没有。消费侧确实会因此变色：`assetSummaryFromLayoutEntry`（`browse-window-slots.ts:128`）回落 `entry.mediaType ?? "other"`，而 `App.tsx:12597`（`shouldShowExtensionBadge`，`asset-card-badges.ts:47-51` 对 `mediaType !== "image"` 为真）与 `App.tsx:12602`（`shouldShowDurationBadge`）都直接吃这个字段 | **must-fix**：`layoutEntryFromAsset` 补 `mediaType: asset.mediaType`，`evictVirtualSummaryPage` 保留 `mediaType`，`layoutEntryFromLoadedAsset` 的 `Pick<>` 加 `mediaType`，`begin` 的非虚拟字面量同步补齐；并把 `browse-window-slots.test.ts:118-149` 的 `virtualSlotAsset` 用例扩到「摘要合并后 `mediaType` 仍在」 |
| S4 | **测试文件硬编码私有资源库绝对路径** | **发现** | `tests/e2e/library-switch-benchmark.test.ts:28-31`：`"NAS 库"`、`"本地大库"`。对比仓库既有约定：`tests/unit/path-utils.test.ts:34-35`、`tests/unit/file-clipboard.test.ts:72` 用的是 `C:\Libraries\Foo` 这类占位路径。`AGENTS.md`：「任何提交文件（源码、测试、开发日志、文档、工单和截图 fixture 等）都不得包含开发机器的本地绝对路径、个人目录或资源库名称」 | **must-fix**：删除 `DEFAULT_LIBRARIES` 兜底，改为「未配置 `SERPENT_E2E_SWITCH_LIBRARIES` 即 `test.skip`」；作者真机命令写进开发日志（日志里已有 `NAS 库`，但日志是内部文档且既有先例如此——测试文件不应承担这个） |
| S5 | **基准默认会真跑真实库（与任务说明/注释不符）** | **发现** | `:161` `test.skip(libraryPaths.length < 2, ...)`；`configured.length >= 2 ? configured : DEFAULT_LIBRARIES`（`:36`）→ 无环境变量时仍为 2 条 → **不跳过**，随后 `electron.launch`（`:186`）+ 打开 pathA（`:212`）。`browse-nas-performance.test.ts:336-339` 是正确写法（`test.skip(!libraryPath)`），说明作者知道该模式 | **must-fix**（与 S4 同一处修复）：并把注释里「Skips when neither is configured」改成实际语义 |
| S6 | **`library.open` 停机序列与 `library.close` 不同：缺 `drainLibraryMedia`** | **发现** | `src/worker/index.ts:2071-2081`（新块）与 `:2133-2141`（`library.close`）逐行比对：新块**有** `cancelDeferredStartupThumbnailScene`/`cancelAutomaticMediaForLibrary`/`cancelMediaResourceRetry`/`cancelVisibleWindowDimensionProbes`/两个 `lastVisibleWindow*` delete/`cancelJobs`/`publishAiProgress`/`aiJobAbortRegistry.abort`，**没有** `await libraryService.drainLibraryMedia(libraryId)`（`library.close:2151` 经 `closeLibraryAsync` → `library-service.ts:46475` 间接执行）。而注释（`:2068-2070`）写的是「Stop the outgoing work **exactly as `library.close` does**」——措辞与事实不符。`libraryService.cancelJobs`（`library-service.ts:19970-19986`）只是 `UPDATE jobs SET status='cancelled' WHERE status IN ('queued','paused','running')`，**不 abort 正在跑的 decoder** | should-fix：注释改准；并考虑补 `await drainLibraryMedia(outgoingLibraryId)`（至少给一个 bounded timeout），因为「降低切换延迟」的论证前提是「离场库不再占着解码器」 |
| S7 | 巨型文件纪律 | **部分** | `App.tsx` 本轮 +~60 行（`NETWORK_LIBRARY_RELOAD_INTERVAL_MS` 注释 20 行 + `isCurrentLibraryNavigation`/`applyNavigationSummary` 约 27 行），其中「把重复的 9 个 setter 收敛成一个函数」是**正面**外提；`src/worker/index.ts` 新增 19 行，是 `library.close` 已有 9 行序列的**复制**。验收纪律第 8 条（新增内联 > ~60 行先拆分 / 先复用后新建）与 AGENTS「先复用后新建：项目里是否已有等价物」：这里已有等价物（`library.close` 的序列），却复制了一份 | should-fix：把停机序列抽成 `function stopAutomaticWorkForLibrary(libraryId: string): void`（或 `stopAutomaticWorkForLibraries(ids: readonly string[])`），`library.close`、`library.delete-from-disk`、`library.open` 三处共用；`worker/index.ts` 已 5041 行 |
| S8 | 临时/调试残留 | 通过 | `git status --short --untracked-files=all` 仅两个新基准文件；`tests/e2e/nas-scope-diagnostic.test.ts`、`tests/worker/tmp-navigation-summary-probe.test.ts` 在树内 grep 无命中（`glob tests/**/*nav*` 也不含它们）；`SERPENT_CLOSE_TRACE` 默认关（`library-service.ts:46446-46458` 提前 return），不是「默认写日志」 | note |
| S9 | 磁盘与工作区洁净 | **部分** | `test-results/` 只有 `.last-run.json`（45 B）且被 `.gitignore:16` 覆盖；`out/`、`.vite/` 亦被忽略；未发现 `tmp/` 残留。但 `library-switch-benchmark.test.ts` 默认会打开**真实可写库**并驱动其媒体队列（`browse-nas-performance.test.ts` 的同类副作用已在开发日志声明且用户同意），代码里**没有任何「确认这是可写/可污染库」的显式开关**（上一轮审查 B9 已提过，本轮仍未加） | note（同 S5 修复后自然缓解；建议加显式确认变量） |
| S10 | `readBrowseSessionGeometry` 死代码的处置 | 通过（已闭环） | `library-service.ts:31024-31039` 方法注释已写明：生产不可达、是 `browseSessionGeometryMs` 基线接缝、不得未恢复身份保证就接回渲染路径。调用点仅 `tests/worker/browse-session.test.ts:53`、`tests/worker/large-library-performance.test.ts:229`。上一轮 S2 的 should-fix 已按「保留+注明」处置并给理由 | note |
| S11 | `listOpenLibraryIds` 的正确性与用法 | 通过（有边界） | `library-service.ts:46425-46435` 返回 `[...this.openById.keys()]`；`openById` 在 `openLibraryPrimary` 成功后才写入（`:44255-44256` 通过 `openIdByPath` 复用），`closeLibrary` 里删除 → 枚举结果与「当前真正打开」一致，**首开时为空数组、无副作用**。唯一瑕疵：`library.open` 对**已经打开的那个库**也会执行停机序列（`openLibraryPrimary:44255-44256` 对同一 canonicalPath 是幂等 early return），即「重新打开当前库」会把自己的队列全部标 cancelled、再原样返回 | note：建议 `library.open` 里跳过「这次要打开的那个 path 对应的 libraryId」，或在 `openIdByPath` 里解析后排除 |
| S12 | `useVirtualBrowseSession` 的参数面收窄 | 通过 | 删掉了 `api` 参数（`use-virtual-browse-session.ts:66-69`）→ 该 hook 不再持有任何 worker 能力，纯状态机；`use-browse-pagination.ts:368-371` 同步更新 | note |
| S13 | 无残留 prop / 死代码（上一轮 S10） | 通过（已修） | 虚拟分支不再构造 `renderLayoutPreview`：`masonry-columns.tsx:77-88`、`justified-asset-rows.tsx` 的 virtual 分支不再传该 prop（`git diff` 可见）；dense 分支 `masonry-columns.tsx:335`、`justified-asset-rows.tsx:224` 仍在使用，非死代码。上一轮判定「App 白造两个 `<BrowseLayoutPreview>` 元素」已消除 | note |
| S14 | 类型检查 | 通过 | `npx tsc --noEmit` → exit 0（本机实跑）。注意这是**唯一**被实跑的门禁；未跑 lint | note |

---

## 2. Axis 2 — Spec

### 2.1 设计 §4 六条不变量：逐条核对（只写偏差）

| 不变量 | 实现核对 | 判定 |
| --- | --- | --- |
| I1 `total` 首帧即 COUNT 且不变 | `createVirtualBrowseLayout`/`createVirtualBrowseLayoutFromIndex` 都用 `safeTotal`；`begin` 复用分支保留 `previous.total`；>5000 的 scope 由 `createVirtualBrowseLayout(input)` 以 `input.total` 建出全范围占位 | 满足 |
| I2 几何只提交一次 | `seedIndex`（`:200-213`）一次成型；`applySummaryPage` 在宽高真变时仍会经 `mergeLayoutEntries` 递增 `geometryRevision`（`virtual-browse-layout.ts:94-104`），`useVirtualScrollAnchor`（`virtual-browse-canvas.tsx:858/1008`）按 revision 补偿 | 满足（>5000 的 scope 例外：几何由摘要页逐页补入，见 L-3） |
| I3 槽位身份只由 index 决定 | `virtualBrowseSlotKey(index)`（`virtual-browse-canvas.tsx:110-116`）+ 虚拟路径 `stableSlot: true` → 内层 `key` 为 `undefined`（`App.tsx:12683-12685`）；未解析槽位渲染 `null`（`:939-941`、`:1093-1095`） | 满足 |
| I4 媒体附上后本挂载周期不撤销 | 同 key 同组件 → 只改 props；无新增粘性断言 | 满足（无自动化） |
| I5 网络库封面收敛到产物 | 本轮仍未做（开发日志「未解决 5」已声明）；每旅程仍有 24–96 次 `serpent://source` 写入 | 未满足（范围外，非缺陷） |
| I6 提交后 `geometryRevision` 为常量 | `seedIndex` 时 `geometryRevision = entries.length`（每条都是 `identityChanged`），随后只在真实宽高修正时增长；设计把 revision 次数当「提交次数」读会读错 | **表述需收紧**：revision 是「几何条目变动计数」，不是「提交次数」；`seedIndex` 的初值等于索引长度（≤5000） |

### 2.2 能改 `virtualLayoutRef` 的调用点全枚举（回答 Spec 问 1）

| 调用点 | 改身份 | 改高度 | 何时 | 判断 |
| --- | --- | --- | --- | --- |
| `seedIndex`（`use-virtual-browse-session.ts:200`） | 是（0→全量） | 是（估算→真实，一次） | 索引到达，每 scope 一次 | 合理，设计要的那一次 |
| `begin` 复用分支（`:156-166`） | 否 | 否 | 每次静默刷新 | 合理（复用正是为了消掉这次变化） |
| `begin` 不复用分支（`:161-167`） | 是 | 是 | scope 真变化 / 首帧 | 合理 |
| `applySummaryPage`（`:221-263`） | 否（同 index 同 id） | 若摘要宽高与索引不同则改单槽 | 滚动中每页 | 合理，但 >5000 时它是**唯一**的几何来源 |
| `removeEntries`（`:294-306`） | 是（删除） | 是 | 用户删除 | 合理 |
| `applyGeometryPatches`（`:310-323`） | 否 | 是 | 缩略图/元数据补丁，**可滚动中** | 合理；注意它**每次都全量重发** `setBrowseLayout(materialize(...))`（`:322`），20k 下这个 O(n) 逃过了 `applySummaryPage` 的优化 |
| `restoreLocalState`（`:281-287`） | 是 | 是 | 预览/导航往返 | 合理 |

结论：**没有任何调用点会像旧分块路径那样「每 128 行修订一次几何」**，I2/I6 的实质成立。

### 2.3 关键缺陷与判断

| # | 项 | 判定 | 证据 | 处置 |
| --- | --- | --- | --- | --- |
| L-1 | **`library.open` 停机序列遗漏 `drainLibraryMedia`，与注释自述不符** | 发现（非阻断） | `worker/index.ts:2071-2081` vs `:2133-2151` + `library-service.ts:46475`。`cancelJobs` 只改 DB 状态（`:19970-19986`），不动在跑的 decoder；`suspendAutomaticMediaForInteractive`（`:1182-1202`）只 abort 队列 controller，也不保证解码器立刻停。实测「修复后 14901 ms / worker close 5 ms」是**真机数字**，但它证明的是「不再饿死」，不等于「离场库媒体工作已停」 | should-fix（改注释 + 评估补 bounded drain）。**不阻断**：即使离场解码器继续跑完当前一批，命令不再饿死这一点已被真机验证 |
| L-2 | **对「所有已打开库」停机是否正确 / 边界** | 发现 | 首开：`listOpenLibraryIds()` 为空 → 不执行，`openLibrary` 正常。同一库重开：`openLibraryPrimary:44255-44256` 幂等返回，但停机序列已把该库队列清空（见 S11）。并发 `library.close`：两个 case 都跑在 `handleRequestWithoutWriteLease`，`library.close` 会在 `closeLibraryAsync` 的 await 点让出，因此 `library.open` 的 cancel 可能先于 close 的 drain/release 发生，随后 `closeLibrary`（`:46523`）对同一 id 再 `cancelJobs` → `cancelJobs` 用的 SQL 是 `WHERE status IN ('queued','paused','running')`，已 cancelled 的行不再匹配，**幂等无害**；最坏是 `openById` 已删而 close 的 `requireOpenLibrary` 抛 `LIBRARY_NOT_OPEN`（与本次改动无关的既有竞态）。`open-eagle`/`open-billfish`/`library.create`/`sync.open-remote-library` 未处理 → 未覆盖，作者已在开发日志「未解决 3」声明 | note：① 用 `openIdByPath` 解析本次目标并排除；② 这些 open 变体仍会在离场库繁忙时饿死，抽成 `stopAutomaticWorkForLibraries()` 后一并接上成本极低 |
| L-3 | **>5000 的 scope：虚拟槽位默认全空，且 `summaryPagesRef` 未随 seed 重置** | 发现 | `use-browse-pagination.ts:452` 直接 `return` → `seedVirtualBrowseIndex` 永不调用 → `virtualLayoutRef` 停留在 `createVirtualBrowseLayout(input)`（只有 100 项摘要 + 其余几何占位），占位槽位渲染 `null`（`virtual-browse-canvas.tsx:939-941`）。即 20k/29k 库首帧是**空白网格 + 滚动条按 COUNT**，卡片随摘要页到达逐格长出。开发日志口径是「slots stay keyed by index, so nothing remounts — only the still-unmeasured tail keeps its estimated height」，没写「首帧是空的」；设计 §5 L2 写的是「占位槽渲染同组件的**无媒体外壳**（几何/摘要缺失时显示骨架/图标）」——实现是渲染 `null`，两处文档都与实现不一致。另 `seedIndex:200-213` **没有** `summaryPagesRef.current.clear()`（对照 `begin:160` 在非复用时会清），若某 scope 先 `begin`（注册首页）再 `seedIndex`，则 registry 中可能残留不属于本索引的页偏移 | should-fix：① 把「>5000 首帧空白」写进开发日志与 CANVAS-038 验收预期（或补无媒体外壳）；② `seedIndex` 里清 `summaryPagesRef` 并重注册首页；③ 注意这条路径**没有** `drain`/`assetIdsByIndex` 保底，任何「首页只有 100 项就当作完整身份」的新代码都会在这里破 |
| L-4 | 侧栏守卫能否为「被取代的库」为真 | 通过 | `isCurrentLibraryNavigation`（`App.tsx:3823-3825`）判 `isCurrentLibraryView(viewSession) && (opts?.navigationIsCurrent?.() ?? true)`；`isCurrentLibraryViewSession`（`library-view-session.ts:35-43`）同时比 `libraryId` **与** `generation`，而 `activateLibraryView`（`App.tsx:1284-1295`）每次换库/失效都 `generation + 1`（`beginLibraryTransition:1278-1283` 亦 +1）。因此**同一库跨会话**（关掉再开）也会 generation +1 → 旧摘要被拒。跨库不可能为真。`setFolders`/`setLinkedFolders`/`setAllAssetCount` 等的写入点只有 `applyNavigationSummary:3826-3836` 与 `clearLibraryScopedView:8581-8600`（换库时清空），无第二种可写路径 | 满足 |
| L-5 | **侧栏摘要不校验「这份摘要是用哪套 scope 参数取的」** | 发现 | `loadNavigationSummary`（`:3837-3849`）把 `includeIgnored`（`showIgnoredItems`）与 `trashMode` 打包进请求；`.then` 里只校验库/视图，不校验这两个参数是否仍是当前值。若用户在一次导航的中途切换「显示忽略项 / 回收站」，先发的那份摘要（旧 `showIgnored`/`trashMode`）仍可落地，`trashedFolders` 会与页面不一致。窗口 = 一次 worker 往返（开发日志自测 `1450/1/1/122` 级读模型，网络库上更宽）。`App.tsx:8565-8567` 的既有注释正是这条纪律（「直到延迟到达的导航摘要到达，侧栏会谎报活动数据库」） | should-fix：把 `includeIgnored`/`trashMode` 一起纳入守卫（比较请求时快照），或让 `isCurrentLibraryNavigation` 也校验 scope key |
| L-6 | `applySummaryPage` 懒重建：React 消费者能否观察到旧数据 | 发现（非阻断） | `use-virtual-browse-session.ts:250-261`：身份没变时只 `layoutDirtyRef.current = true`，**不** `setBrowseLayout`。`getLayout`（`:266-272`）只刷新 `layoutRef`（imperative），React 消费者读的是**已发布的 state**：`App.tsx:2344-2349`（`selectedLayoutEntry = browseLayout.find(...)`，Inspector 的 `thumbnailStatus`/`previewArtifactId`/caption 来源）、`:2513`（scroll→rank 表）、`:4683`（`browseLayout.length > 1200` 的缓存护栏）。注释「imperative readers must not observe a stale copy」是对的，但「Slot identity is the only thing the compact array's consumers act on」不成立。实际可观察面被 `virtualSlotAsset`（`assetById` 优先于索引）与 `:12641-12664` 的 `layoutThumbnailArtifacts` 兜住大部分，量级是「Inspector 首帧字段可能滞后」，**不是**我能在静态阅读下证实的用户可见回归 | should-fix（低）：要么在 `getLayout` 被调用时同步一次发布，要么把 `selectedLayoutEntry` 改成虚拟索引优先；至少把注释改准 |
| L-7 | 10 s 刷新间隔是否该留 | **发现（建议撤出本变更）** | `NETWORK_LIBRARY_RELOAD_INTERVAL_MS`（`App.tsx:567`）+ `scheduleNetworkLibraryReload`（`:9790-9807`）。它确实对用户可见：`shouldRefreshContentForLibraryChange`（`library-change-refresh.ts:1-6`）对 `networkStorage === true` 恒真 → 网络库每次 `library.changed` 都走这条路径，10 s 是**跨实例资产变化的可见延迟上限**（另一台电脑新增资产，本机最多 10 s 才出现）。作者自述「未被证明有效（非导入场景下无可测量差异）；真凶是 B」。而新代码注释（`:543-566`）把这个改动写成「sidebar never filled / switching never completed」的成因之一，与开发日志的结论（真凶是 `library.open` 未停机）**互相矛盾**，下一位读者会据此判断该值已被证明必要 | should-fix→若无法补测则**撤出**：它属于「未被证明有效的行为变更」，按验收纪律第 9 条不能以修复身份合并。若担心 750 ms 确实太密，正确做法是单列一个工单 + 在 NAS 库上记录「跨实例可见延迟」前后值，而不是夹带 |
| L-8 | 20k 基准口径（上一轮 P1-2）是否真的解决 | 通过（有保留） | `large-library-scroll-benchmark.test.ts:204-222` 新增 `shadowCardCount === 0 && placeholderCardCount === 0` 作为 `layoutReady` 门禁条件。但 `.asset-card:not(.is-layout-preview)`（`:174`/`:219`）与 `data-asset-id^='__pending:'` 这些**消费者**仍在——新增的条件让「过滤器恒真」变成「门禁断言」，方向正确；只是断言依赖的类名（`.is-layout-preview`、`.is-browse-placeholder`）在虚拟路径上已无生产者，若将来有人改名，`querySelectorAll` 依旧返回 0 而门禁**不会**失败。作者在开发日志的说法（「若将来重新引入这两类节点，门禁会失败而不是继续静默计错」）对「重新引入同类名节点」成立，对「换名引入」不成立 | note：可接受；建议把「虚拟路径不得产出影子/占位卡」下沉为组件测试（对 `VirtualMasonryColumns` 断言 DOM 中不存在 `.asset-card` 的这两种类），而不是靠全局选择器计数 |
| L-9 | 度量工具能否支撑「滚轮下 `scrollHeight` spread 0%」 | 通过（口径已正确） | `library-switch-benchmark.test.ts:129-154` 的 `wheelScroll` 在 8 s（`SERPENT_E2E_SWITCH_WHEEL_MS` 默认 8000）内每 60–150 ms 采样一次 `canvas.scrollHeight`，返回 `distinctHeights` 与 `spreadPct`；`browse-nas-performance.test.ts:303-321` 的 `heightStability` 已按上一轮 should-fix 改成**只统计滚动时段**（`dwell15a/backTop/dwell15b/settleTop`），把 `settle` 单独报为 `openIndexTransition`（`:324-333`）。`perPhaseDistinctHeights`（`:472-477`）是可信指标，「每阶段取值个数 1」支撑得住 | note：清单/日志应只引用逐阶段 `distinctHeights`，不要引用旧 `spreadPct`（开发日志第 75 行已自觉写了这一条，但 checklist CANVAS-038 行的正文仍在混用「滚动期间取值个数」与历史 `8.7–13%` 口径——可读性瑕疵） |
| L-10 | 「切换 14901 ms」测的是什么 | 发现（表述需收紧） | `library-switch-benchmark.test.ts:259-271`：`switchToSidebarMs` 是**从点击到「目标库标题可见 + 首卡可见 + 导航行 > 4」全部成立**的总耗时，不是「首帧」或「关闭」单独耗时；`switchFirstCardMs`（`:264`）才是首卡。超时分支（`:269-271`）只把 `switchTimedOut = true`，`wheelB/probeB` 变 null，**测试仍会通过**（无 `expect` 约束切换时长） | must-fix（文档口径）：开发日志/清单统一写成「切换端到端（点击→目标库侧栏+首卡就绪）14901 ms」；`switchFirstCardMs` 若已测得应一并记录 |
| L-11 | 「5 ms worker close」的测量基础 | 通过 | `library-service.ts:46443-46482` 的 `markPhase` 仅在 `SERPENT_CLOSE_TRACE === '1'` 时 `process.stderr.write`，阶段名 `reconciliation/drainMedia/backup/releaseHandle/total` 与日志表一一对应；数值真实但**只在打开 trace 的那次运行**成立（默认运行不产生该行，也无法事后核对） | note |
| L-12 | 「媒体队列仍在抖动」是否被本次修复掩盖 | 通过（已声明） | 开发日志「未解决 4」明确写「本次修复只是让生命周期命令不再被它饿死，队列本身的抖动未处理」。代码侧 `library.open` 的 `cancelJobs` 会**再增加一次** cancelled 记录（同一库重开时尤甚），但 `admitArtifactJob`（`artifact-policy.ts:357-394`）的 `activeJob` 只认 `queued/running/paused`（`library-service.ts:24239-24342` `enqueuePaletteJob` 同款查询），因此 cancelled 行不永久阻塞重新入队——不是我最初担心的「永久丢工作」，但会放大 churn | note：开发日志保留即可；建议顺手记录「cancelled 行是否会被后续 enqueue 覆盖」这一结论，免得下一位读者重复推断 |
| L-13 | 20k 首波 p95 劣化（上一轮「未解决 1」） | 未处置 | 开发日志仍写 553.7 → 1159.3 ms（三次复现），无门禁、无回归测试 | note（已声明，非本轮引入） |

---

## 3. 阻断缺陷（Blocking defects）

**有两项我不建议在修复前合并；都不是「数据不安全」类，而是「功能与合规」类。**

1. **P1（功能）— `mediaType` 只写不传，虚拟卡片的类型字段会在摘要页到达后回退为 `other`，与本次新增该字段的目的直接相反。**
   - `src/renderer/browse/virtual-browse-layout.ts:35-53` `layoutEntryFromAsset` 不返回 `mediaType`；该函数是 `mergeVirtualSummaryPage`（`:212-226`）覆盖索引条目的唯一构造器。
   - `src/renderer/browse/virtual-browse-layout.ts:277-290` `evictVirtualSummaryPage` 重建条目时丢弃 `mediaType`。
   - `src/renderer/browse-window-slots.ts:150-175` `layoutEntryFromLoadedAsset` 的 `Pick<>` 不含 `mediaType`。
   - `src/renderer/browse/use-virtual-browse-session.ts:177-188` `begin` 的非虚拟字面量同样缺失。
   - 消费端证据：`browse-window-slots.ts:128`（`entry.mediaType ?? "other"`）→ `App.tsx:12597` / `asset-card-badges.ts:47-51`（`other ≠ image` → 图片也会挂扩展名角标）→ `App.tsx:12602`（视频/音频时长角标）。
   - 与规格冲突的原话：`src/shared/asset-types.ts:217-223`（「Without it a synthesized slot would have to guess `other` and change the card's appearance once the summary landed」）与设计 §5 L2。
   - 无任何测试覆盖：`grep 'mediaType.*layout|layout.*mediaType' tests/` → 0 命中；`tests/unit/virtual-browse-session.test.ts` 新用例只断言 `displayName`/`geometryRevision`（`:117-141`）。

2. **P1'（合规）— 新基准硬编码私有资源库绝对路径，且无环境变量时会真跑。**
   - `tests/e2e/library-switch-benchmark.test.ts:28-31`、`:32-36`、`:161`。
   - 违反 `AGENTS.md`「隐私与本地环境信息（强制）」；违反「不污染用户工作区」（该库会被驱动媒体队列并写 `library.db`/`.serpent/artifacts`，作者在开发日志中承认每次 197→269 queued）。
   - 与任务说明「both skip without env vars」不符：`browse-nas-performance.test.ts` 会 skip，`library-switch-benchmark.test.ts` **不会**。

其余（`library.open` 的 `drainLibraryMedia` 遗漏、复制粘贴、10 s 间隔、侧栏 scope 守卫、懒重建消费者）我判定为 **should-fix，不阻断**，理由分别见 S6/S7/L-1、L-5、L-6、L-7：

- `library.open` 的修复方向与真机证据（≥90 s 卡死 → 14901 ms 完成、侧栏 120 行）是可信的；
- 首开（`openById` 为空）、无并发 close 时无竞态；
- `cancelJobs` 只标 cancelled、不删数据，`admitArtifactJob` 会重新放行，因此不构成「用户工作永久丢失」。

---

## 4. 上一轮审查遗留项复核

| 上一轮项 | 本轮状态 | 证据 |
| --- | --- | --- |
| P1-1 `applySummaryPage` 用 size/revision 推断内容等价 | **已修**（改引用比较 + 脏标记），并新增「eviction 改内容不改 size/revision」单测 | `use-virtual-browse-session.ts:250-261`；`tests/unit/virtual-browse-session.test.ts:170-196` |
| P1-2 20k 基准过滤器恒真 | **已修**（把影子/占位计数纳入门禁），但类名依赖仍在（见 L-8） | `tests/e2e/large-library-scroll-benchmark.test.ts:204-222` |
| should-fix 1 清单文案/`spreadPct` 不可复现 | **已修**：`heightStability` 只统计滚动时段 + `openIndexTransition` + `perPhaseDistinctHeights`；清单改为逐阶段口径 | `browse-nas-performance.test.ts:295-333`、`:470-477`；`human-acceptance-checklist.md:58` |
| should-fix 2 未解析槽渲染 `null` / masonry 无 `aria-hidden` / 指针 | **部分修**：masonry 空槽补 `aria-hidden`（`virtual-browse-canvas.tsx:928`）；`null` 渲染**未改**（本轮 L-3 再次指出其与设计 L2 不符）；`pointer-events` 未改（作者给了理由，我认可「空槽内无节点、无处理器」） | `virtual-browse-canvas.tsx:928`、`:939-941` |
| should-fix 3 hook 无测试 / `protocol.test.ts` 丢一层 / `sourceRequests` 未进表 | **部分修**：`protocol.test.ts:291-317` 恢复三层往返（含 worker response）；新增 `virtualSlotAsset`、整索引播种、截断索引、eviction 语义四组单测；**hook 级仍零测试**（作者已在开发日志「未解决 3」承认） | `tests/unit/protocol.test.ts:291-317`；`grep 'seedIndex\|noteVisibleRange\|applySummaryPage' tests/` → 0 命中 |
| 次要 `readBrowseSessionGeometry` 死代码 | **已按保留+注明处置**（S10） | `library-service.ts:31024-31039` |
| 次要 度量工具注释不准 | **已修**（`browse-nas-performance.test.ts:22-25` 明确「不在 `npm run test:e2e` 清单内、无环境变量也会 skip」） | 同上 |

---

## 5. 覆盖缺口（Coverage gaps）

| 缺口 | 说明 |
| --- | --- |
| **`mediaType` 端到端** | 无任何测试断言「worker 返回的 `layoutOnly` 行含 `mediaType`」，也无任何测试断言「摘要页合并后索引条目仍带 `mediaType`」。这正是 P1 的成因 |
| **`useVirtualBrowseSession` 本体** | `seedIndex` / `begin` 复用分支 / `applySummaryPage` 懒重建 / `summaryPagesRef` 生命周期仍**零 hook 级测试**（全仓 grep 无命中）。`tests/unit/virtual-browse-session.test.ts` 只覆盖被它调用的纯函数 |
| **>5000 的降级路径** | `shouldFetchCompleteBrowseIndex` 有纯函数测试（`virtual-browse-session.test.ts:196-206`），但「真跑一个 >5000 的 scope 会得到什么首帧」没有任何测试或真机数字 |
| **`library.open` 的停机序列** | 无 worker 集成测试断言「`library.open` 会 cancel 其他已打开库的媒体队列」。`tests/` 中 `listOpenLibraryIds` → 0 命中；这是本轮最risky的改动却只有真机一次性证据 |
| **`isCurrentLibraryNavigation` 的新语义** | 无单测覆盖「库/视图代次正确但摘要过期」的两条分支（接受的路径与拒绝的路径）；侧栏修复的回归保护为零 |
| **重挂/媒体请求计数未进门禁** | 真机工具里的元素级重挂指标（`browse-nas-performance.test.ts` 的 `slotCreated/slotRemoved/maxSrcWritesOnOneElement`）只落盘报告，`asset-pagination.test.ts:90-118` 的 E2E 断言只检查「`scrollHeight` 不塌缩 + 卡片数 > 0」，对「卡片重挂」无判别力（开发日志「未解决 3」已承认） |
| **切换速度无门禁** | `library-switch-benchmark.test.ts` 只在 90 s 超时（`expect` 超时）时失败，对 14.9 s、4.5 s 这类「慢但可完成」没有断言 |
| **`test:library-availability` / 全量 `test:e2e`** | 开发日志称跑过 211 项通过；本轮审查未复核（按要求未跑测试）。核心体验回归门禁要求「触及 library-service 必跑」——该要求已由作者执行，但改动在审查之后又落了注释编辑，严格说证据对应的是「同功能、不同提交」 |
| Computer Use / packaged / macOS / Windows | 未执行（作者已声明） |

---

## 6. 明确未能核验（Explicitly unverified）

1. **真机 NAS 度量数字**：`NAS 库`、`本地大库`、`仓库外的临时夹具目录` 均不在本次审查可访问范围。开发日志与清单里所有「本轮」数字（795/789 槽位、250/200 媒体写入、`distinctHeights=1`、14901 ms、5 ms close、20k `passed 6/10`、首波 p95 1159.3 ms）**只能复核口径，无法复核取值**。工具代码逐行读过：userData 隔离（`library-switch-benchmark.test.ts:163-165,193`）、临时目录回收（`:335-341`）、probe 语义（`:58-95`）可确认。
2. **未运行任何测试**：未执行 `test:unit` / `test` / `test:library-availability` / `test:e2e` / 两个新基准，也未启动 Electron（按指令避免干扰并行测试）。因此「461 files/3418 passed」「211 passed」「asset-pagination 2 passed」等断言未经复核。仅实跑 `npx tsc --noEmit` → exit 0。
3. **`library.open` 修复在真机上到底停住了什么**：我无法区分「命令不再被媒体任务饿死」与「离场库媒体工作真的停了」——两者都能解释 14901 ms 的成功。要区分需要 worker 侧在 `library.open` 前后打点（现有 `SERPENT_WORKER_CMD_LOG=1` 的 `queueMs` 字段可用，但未见使用记录）。
4. **`.is-layout-preview` / `.is-browse-placeholder` 的实际生产者**：我确认虚拟路径不产出这两类节点，但未逐一定位所有非虚拟分支（trash/文件夹分组）是否会产出，因此 L-8 的门禁是否在任何状态下都可能被触发，未核验。
5. **`library.open` 与并发 `library.close` 的实际交错**：我按代码路径推断 `cancelJobs` 幂等无害，但未在真实 Worker 上制造该竞态（需要 ≥2 个已打开库 + 并发命令），因此「无竞态」是**阅读结论**而非实测结论。
6. **`SERPENT_E2E_SWITCH_WHEEL_MS` 默认 8 s 与开发日志「滚轮 3–6 秒」的口径差异**：日志表头写 3–6 s，代码默认 8000 ms。可能是当次用环境变量缩短，我无法确认当次实际取值，故「0% spread」对应的采样窗口长度未核验。
7. **Windows / packaged / 多屏 / DPI 行为**：未执行。
8. **`npm run lint`**：未跑（`use-browse-pagination.ts` 的 `useCallback` 依赖数组本轮又改了一次，`ensureVisibleRange` 的依赖从 `ensureVirtualGeometryRange` 换成 `noteVirtualVisibleRange`——需要 lint 确认 `react-hooks/exhaustive-deps` 无新告警）。

---

## 7. 建议的最小修复集（按优先级）

1. `layoutEntryFromAsset` / `evictVirtualSummaryPage` / `layoutEntryFromLoadedAsset` / `begin` 手写字面量补齐 `mediaType`（4 处），并加一条「摘要合并后 `mediaType` 不变」的单测。
2. 删除 `library-switch-benchmark.test.ts` 的 `DEFAULT_LIBRARIES`，改成无 env 即 skip；注释同步改准。
3. 把 `library.open` 的停机序列抽成共用函数，与 `library.close` / `library.delete-from-disk` 同源；注释里去掉「exactly as `library.close` does」，并决定是否补 `drainLibraryMedia`。
4. `NETWORK_LIBRARY_RELOAD_INTERVAL_MS` 要么撤出本变更，要么补「跨实例资产变化可见延迟」的前后实测与单列工单。
5. `seedIndex` 清 `summaryPagesRef`；把「>5000 首帧为空白网格」写进开发日志与 CANVAS-038 的验收预期。
6. 侧栏守卫纳入 `showIgnored`/`trashMode` 快照比较。
