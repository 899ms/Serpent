# 2026-09-13 CANVAS-038 几何一次播种 — 双轴代码审查

- 固定点：`570b3cfafa23f379d136c1a26801dd37a2a302d1`
- 审查对象：工作区未提交改动（`git diff 570b3cfa`，24 文件 +444/−473）与未跟踪文件 `tests/e2e/browse-nas-performance.test.ts`
- 模型：DeepSeek Harness（deepseek-flash）。一次审查同时覆盖 Standards 与 Spec 双轴。
- 规格来源：[`2026-09-13-canvas-038-browse-media-pipeline-redesign.md`](../development/2026-09-13-canvas-038-browse-media-pipeline-redesign.md)、[`2026-09-13-canvas-038-geometry-seeding-development-log.md`](../development/2026-09-13-canvas-038-geometry-seeding-development-log.md)
- 规范来源：`AGENTS.md`、`CLAUDE.md`、`docs/internal/development-process.md`
- 本次审查为只读：未修改任何源码/测试/配置。唯一写入为本文件。

## 0. 结论摘要

**没有发现会让改动「不安全」的阻断缺陷（P0）。** 方向是对的，且优于上一轮：分块几何协议被彻底删除、槽位身份改为 index-only、校验没有被削弱、没有残留临时文件。

但发现 **1 个必须修的语义缺陷（P1）**：`applySummaryPage` 用「`entries.size` + `geometryRevision` 未变」推断「物化数组逐字节等价」，这个推断在当前实现下**不成立**（`evictVirtualSummaryPage` 会改写 `entries` 内容而不改变 size）。它会让 `browseLayout` 与虚拟索引静默发散。

以及 **1 个规格要求未落实（P1）**：设计文档 §6「10k+ 还要一并改的测试语义（不是删测试）」明确要求在同一次变更里改写 `tests/e2e/large-library-scroll-benchmark.test.ts` 的 `is-layout-preview` / `is-browse-placeholder` 断言——该文件**一个字节都没动**，那些断言现在恒真、判别力被静默清空。

另需注意：清单里写的「`scrollHeight` 波动…降到 **0%**」与开发日志自述的「16.6%」「一次性高度变化仍在（约 20%）」互相矛盾，且受采样时机支配，属**不可复现的度量表述**。

---

## Axis 1 — Standards

| # | 项 | 判定 | 证据 | 处置 |
| --- | --- | --- | --- | --- |
| S1 | **跨进程不变量：删除协议面是否彻底** | 通过 | `browse.session.geometry(.request)`、`browseGeometryEntry/Block` schema、preload `fetchBrowseSessionGeometry`、worker case、main 转发、`performance-contract` 条目全部删除；全仓 grep 无残留引用（`src/`+`tests/` 零命中）。`browse.session.ids` 的 `z.strictObject` 与 `response` 校验（`responses.ts:1161-1170`，`assetIds` 上限 100 000）未被放宽 | note |
| S2 | **worker 侧几何能力成为生产死代码** | 发现 | `src/worker/library-service.ts:31024` `readBrowseSessionGeometry` 已无任何生产调用点，仅剩 `tests/worker/browse-session.test.ts:53`、`tests/worker/large-library-performance.test.ts:229` 调用。协议已删，该方法不可达 | should-fix：要么删除（连带改写那两个测试），要么在注释里写明它是 >50k 降级路径的保留能力（设计文档 §5 L1 说「协议与 worker 能力可保留」——那就必须把「保留原因 + 无调用点」写清楚，否则下一位读者会当作漏删） |
| S3 | **测试迁移纪律：`virtual-browse-session.test.ts`** | 通过（有缺口） | 删除的 3 个用例（`geometryBlockStartsForRange` 块对齐、`BrowseGeometryBlockCache` LRU、`mergeVirtualGeometryBlock` 摘要保字段）对应的**产品行为已删除**，不是掩盖失败；新增 4 个用例覆盖 `shouldUseVirtualBrowseLayout` 门槛、整索引一次提交、截断索引保留 COUNT、`virtualIndexMatchesFirstPage`。但 `applySummaryPage` 的跳过重发布分支（本轮唯一有语义风险的改动点）**零覆盖** | should-fix：补 `applySummaryPage` 的直接用例（见 Axis 2 的 B1 与「覆盖缺口」） |
| S4 | **测试迁移纪律：`protocol.test.ts`** | 部分回退 | 原用例同时往返 `browse.session.geometry.request` 的 renderer 请求、worker command **与 worker response** 三层；迁移后（`tests/unit/protocol.test.ts:291-305`）只剩 `.ids.request` 的 renderer 请求 + worker command，**丢掉了 worker response 往返这一层** | should-fix：补一条 `browse.session.ids` 的 `parseWorkerResponse` 往返断言，保持与原用例同等的「三层」覆盖深度 |
| S5 | **测试迁移纪律：`native-asset-drag-prime` / `interactive-scheduler`** | 通过 | 两处都是「换夹具、意图不变」：`native-asset-drag-prime.test.ts:101` 换成 `browse.session.ids`（仍是「成功但非卡片响应不预热」），`interactive-scheduler.test.ts:95` 换成 `browse.session.page`（仍是「浏览读不抢占可见缩略图工作」）。等价，无覆盖损失 | note |
| S6 | **巨型文件纪律（`App.tsx` 14 545 行）** | 通过 | 本轮 `App.tsx` 净改动为 **+2/−1**（`renderOptions.stableSlot` 类型 +3 行、`key` 三元 −1/+2），逻辑外迁到 `browse-window-slots.ts`（`virtualSlotAsset`）、`virtual-browse-canvas.tsx`（`virtualBrowseSlotKey`）、`use-virtual-browse-session.ts`（`shouldUseVirtualBrowseLayout`、`seedIndex`、`noteVisibleRange`）。方向是**把逻辑移出巨型文件**，符合验收纪律第 8 条 | note |
| S7 | **数据兼容性：`mediaType` 只加不改** | 通过 | `src/shared/asset-types.ts` 中 `browseLayoutEntrySchema` 仍是 `z.strictObject`，`mediaType` 为 `.optional()` 枚举（`asset-types.ts:202-224`），worker 写入侧恒有值（`library-service.ts:31746-31765`）。旧库/旧客户端缺失该字段时 Zod 仍通过，不会引入迁移；未触碰 `MIGRATIONS` | note |
| S8 | **先复用后新建** | 通过 | 复用了既有 `layoutOnly` 全量索引机制（`fetchBrowseLayout` 未新造查询）与既有 `PreviewCache`；未新增任何协议命令、未新增缓存层。新增的 4 个导出函数都是对既有 `VirtualBrowseLayout` 的纯函数扩展 | note |
| S9 | **磁盘与工作区洁净** | 通过 | `git status --untracked-files=all` 仅 `tests/e2e/browse-nas-performance.test.ts` 一个未跟踪文件；无 `test-results/`、无 `tmp/`；`.vite/` 已被 `.gitignore` 覆盖。度量工具用 `mkdtempSync(tmpdir())` 隔离 userData 并在 `finally` 里 `rmSync(..., maxRetries: 20)`（`browse-nas-performance.test.ts:320-341, 464-473`），**全部路径来自环境变量，无硬编码本机绝对路径**，不违反隐私条款 | note |
| S10 | **新交互逻辑的 prop 残留（死代码）** | 发现 | `VirtualMasonryColumns` / `VirtualJustifiedAssetRows` 已删除 `renderLayoutPreview` 形参（`virtual-browse-canvas.tsx:810-823, 959-970`），但 `App.tsx:13167-13188` 与 `13211-13231` 仍在给 `MasonryColumns` / `JustifiedAssetRows` 传这个 prop。`props.virtualLayout` 存在时组件在 `masonry-columns.tsx:77-88` / `justified-asset-rows.tsx:90-100` 提前 return，该 prop **在虚拟会话下永不执行**。它不是类型错误（prop 在父组件类型上仍是可选声明），所以 typecheck/lint 不会报 | should-fix：虚拟路径下不要构造 `renderLayoutPreview`（或删除该 prop 的父层构造分支），避免每次渲染白造两个 `<BrowseLayoutPreview>` 元素与「这段代码在跑」的错觉 |
| S11 | **误导性注释（度量工具）** | 发现 | `browse-nas-performance.test.ts:14-24` 写「It is skipped otherwise so the default `npm run test:e2e` list never touches a real user library」。实际上 `playwright.config.ts` 的 `testDir: 'tests/e2e'`：直接跑 `npx playwright test` / `playwright test tests/e2e/` 会**收集**该文件（只是 `test.skip` 后不启动）。「never touches」是由「执行 `npm run test:e2e`（文件白名单）」而非「收集」保证的 | note：注释改成「由 `npm run test:e2e` 的白名单排除；直接 `playwright test` 会收集但跳过」 |
| S12 | **类型检查** | 通过 | 本次复审实跑 `npx tsc --noEmit` → exit 0。与开发日志一致 | note |

---

## Axis 2 — Spec

先给设计文档 §4 六条不变量的逐条核对（**只写实现与设计的偏差，不复述设计已声明的结论**）：

| 不变量 | 实现核对 | 判定 |
| --- | --- | --- |
| I1 `layout.total` 首帧即 COUNT 且不变 | `createVirtualBrowseLayout` 即用 `safeTotal(total)`（`virtual-browse-layout.ts:142`）；`begin` 复用分支保留 `previous.total` | 满足 |
| I2 几何只提交一次 | `seedIndex` 一次成型（`use-virtual-browse-session.ts:171-183`）；但**仍有两条路径可在种子后改高**：① `mergeVirtualSummaryPage` 在索引宽高为 null 而摘要宽高非 null 时递增 `geometryRevision`（即设计所允许的「修正」）；② `applyGeometryPatches`（`use-virtual-browse-session.ts:266-278`，由 `App.tsx:4278` 的缩略图补丁 effect 驱动，**可在滚动过程中触发**）。代码与设计不冲突，但 §2 的「几何提交后不再修订」表述需要收紧成「只允许来自宽高修正，且每次修正都会触发 `useVirtualScrollAnchor` 补偿」 | 满足（表述需收紧） |
| I3 槽位身份只由 index 决定 | `virtualBrowseSlotKey(index)`（`virtual-browse-canvas.tsx:110-116`）+ `stableSlot` 时内层 key 为 `undefined`（`App.tsx:12645-12647`） | 满足 |
| I4 媒体只在首次进入可见窗口时附上且本挂载周期不撤销 | 未见新增的粘性保证；`loadImmediately` 仍由 `itemIntersectsVisibleRange` 每帧计算并透传（`virtual-browse-canvas.tsx:920-940`），但同 key 同组件下只改 props，不会卸载子树 | 满足（依赖同 key 不换组件这一前提，未加自动化断言） |
| I5 网络库封面收敛到产物 | **本轮明确不做（L3 未落地）**，开发日志「未解决 4」已声明；实测每旅程仍有 24–96 次 `serpent://source` 写入 | 未满足（已声明为范围外，非缺陷） |
| I6 索引提交后 `geometryRevision` 为常量 | 同上，见 I2 的两条例外 | 满足（同上收紧） |

### 设计核心经验主张的核验

设计主张：**旧的 128 行分块几何是 churn 的成因，一次 `layoutOnly` 修复它**。我逐条追了所有能改 `virtualLayoutRef` 的调用点：

| 调用点 | 能否改高度 | 是否在滚动中发生 | 判断 |
| --- | --- | --- | --- |
| `seedIndex`（`use-virtual-browse-session.ts:171`） | 能（整体替换，把估算高换成真实高） | 是，但每次会话只发生一次，且通常早于用户滚动 | **合理**，正是设计要的那一次提交 |
| `begin` 复用分支（`:133-134`） | 复用旧索引 → 不改高度；不复用时 `createVirtualBrowseLayout` 把 100 项外的槽位打回估算高 | 是（刷新时一次） | **合理**，且复用分支正是为了消掉这次变化 |
| `applySummaryPage`（`:191-228`） | 能：索引宽高为 null 而摘要非 null 时 `mergeLayoutEntries` 递增 `geometryRevision` | 是，滚动时每页都调 | **潜在**：20k 夹具的 `layoutOnly` 与摘要同源于 `extracted_metadata`，正常不会不一致；但代码没有断言这一点，设计文档也未记录这个前提 |
| `removeEntries`（`:251`） | 能（删除后 `total` 减、`geometryRevision` 递增） | 用户删除资产时，非滚动 | **合理** |
| `applyGeometryPatches`（`:266`） | 能（实时宽高回填） | **是，可滚动中由缩略图补丁触发** | **合理但需披露**：设计 §4 说「真实宽高修正只允许来自用户可见的元数据回填」，而 `App.tsx:4249-4280` 的补丁源是缩略图/元数据管线，不限于用户操作 |
| `restoreLocalState`（`:239`） | 能（换回快照） | 导航/预览往返 | **合理** |

结论：**设计主张成立**——没有任何调用点会像旧分块路径那样「每 128 行修订一次几何」。滚动期间唯一可能的几何变动来自宽高修正（摘要或补丁），量级是单个槽位而非整段区间，且都会走 `useVirtualScrollAnchor` 补偿。**这不是反例，但设计文档 §4/§5 的「提交后不再修订」需要按上表收紧措辞**，否则把「0 次」写成了绝对事实。

| # | 项 | 判定 | 证据 | 处置 |
| --- | --- | --- | --- | --- |
| B1 | **`applySummaryPage` 的「内容等价」推断不成立 → `browseLayout` 静默发散** | **发现（P1）** | `use-virtual-browse-session.ts:213-226`：注释断言「slot identity set and the geometry are unchanged, so the compact array … is byte-for-byte equivalent」，并用 `next.entries.size !== current.entries.size \|\| next.geometryRevision !== current.geometryRevision` 判定。但 `evictVirtualSummaryPage`（`virtual-browse-layout.ts:262-303`）会**原地改写 `entries` 的内容而不改变 size**（把 `displayName` 剥掉、缺失几何的行整条 delete，见 `:275-300`）；`mergeLayoutEntries` 也会同帧改写内容。因此「size 不变 + revision 不变」≠「内容不变」，存在**假阴性**（该发布而未发布）与**假阳性**（无变化仍重建 20k 数组）两个方向 | **must-fix** |
| B1-a | 影响面（`browseLayout` 消费者枚举） | 发现 | `src/renderer` 内真实消费者只有四处：`App.tsx:1944`（`syncCardAssetIds`，只取 id，发散无害）、`App.tsx:2322-2329`（`selectedLayoutEntry` **优先取 `browseLayout`**，只在 miss 时才回落 `virtualLayoutEntryForAsset`，而这正是发散时会命中 stale 副本的地方）、`App.tsx:2413-2415`（`visibleBrowseLayout`，虚拟路径下 `masonry-columns.tsx:77` / `justified-asset-rows.tsx:90` 提前 return，**不读**）、`App.tsx:4653`（有 `virtualLayout` 时置空，**不读**）。所以可观察缺陷限于：Inspector 首帧/`thumbnailStatus`/`previewArtifactId` 取到旧副本；以及每帧白跑一次 `shuffleBrowseItems` | must-fix（低影响但不该存在） |
| B2 | **设计 §L6 要求的基准测试改写未落实（断言判别力被静默清空）** | **发现（P1）** | 设计文档 §5 L6 原文：「**必须在同一次变更里把断言改写成新不变量**…不得为了绿灯删断言」。实际 `tests/e2e/large-library-scroll-benchmark.test.ts` 未出现在 diff 中：`:174`、`:208`、`:442` 仍用 `.asset-card:not(.is-layout-preview)` 过滤，而虚拟路径**已不再渲染任何 `is-layout-preview` 节点**（`virtual-browse-canvas.tsx:939-941`/`1093-1095` 为空渲染）→ 该过滤器恒真；`:450-453` 仍统计 `is-browse-placeholder` / `__pending:` → 恒 0；`:489` 的 `layoutPreview` 字段恒 false。基准的 `passed` 指标是被开发日志引用的对比数字来源，其口径已悄悄改变而无人记录 | **must-fix（文档/测试同步）** |
| B3 | **虚拟画布对未解析槽位渲染 `null` —— 与设计 §L2 不符，且丢掉了 `aria-hidden`** | 发现 | 设计 §L2 原文：「占位槽渲染同组件的**无媒体外壳**（几何/摘要缺失时显示骨架/图标，不显示 `BrowseLayoutPreview` 影子卡）」。实现是**什么都不渲染**（`virtual-browse-canvas.tsx:939-941, 1093-1095`）。连带后果：(a) 101–2000 项这一档（本轮新纳入虚拟化的区间）在 `layoutOnly` 到达前会出现空白格——旧行为是 `BrowseLayoutPreview` 影子卡，属**视觉回退**；(b) masonry 路径的槽位 div **没有 `aria-hidden`**（对比 justified 路径 `:1082` 有 `aria-hidden={asset ? undefined : true}`），空槽仍暴露给无障碍树；(c) `.masonry-card-slot` / `.justified-card-slot`（`styles.css:9915`、`:9844`）没有 `pointer-events: none`——旧代码靠 `.asset-card.is-layout-preview { pointer-events: none }`（`styles.css:9927`）挡住命中，现在空槽仍参与命中测试（焦点顺序与框选落点） | should-fix（实现与设计二选一：补齐无媒体外壳，或把设计文档改成「渲染空槽」并补 `aria-hidden` / 命中策略） |
| B4 | **`begin` 复用路径的前 100 项比较：失败模式与严重度** | 通过（有边界缺口） | `virtualIndexMatchesFirstPage`（`virtual-browse-layout.ts:197-209`）逐位比较 `offset..offset+n-1` 的 `assetId`。若刷新后**整体重排**，`firstPage.items` 的顺序与已提交索引不同 → 比较失败 → 不复用，行为正确。若重排后**恰好**前 100 位与索引 0–99 逐位相同而 100+ 已变，则会复用，此时 `indexByAssetId` 指向的资产/缩略图与真实顺序不符——但这要求「前 100 位重排后完全不动」，实际排序变化不可能满足（前 100 同日期的文件在重排下几乎必然换序） | note：**严重度低，实测不可达**；但 `begin` 复用分支**本身**（`:124-138`）没有直接测试，只测了纯函数 |
| B5 | **`begin` 复用保留 `previous.total`** | 通过 | `sessionRef.current.total` 取新值、`virtualLayoutRef.total` 暂留旧值（`use-virtual-browse-session.ts:117-139`）。滚动条按旧 COUNT 短暂不动，待新索引到达再修——这正是复用分支想要的效果，且 `beginPage` 的 `generation` 守卫（`use-browse-pagination.ts:450`）保证种子不会跨 scope 落地 | note |
| B6 | **`beginPage` 对每个 scope（含超大 scope）都发 `fetchBrowseLayout`：并发/失败/过期** | 通过 | 失败：`fetchBrowseLayout` 返回 null，`:456` 的守卫 `!layout` 直接 return，虚拟布局停在首帧前缀（估算高），不崩、不擦除既有几何。过期：`:450` 的 `generation !== generationRef.current` 守卫丢弃，且 `seedIndex` 只在 `sessionRef.current.virtualized` 为真时生效（`use-virtual-browse-session.ts:175-176`），scope 切换后 `begin` 已重置该标志。不解析（永不 resolve）：`fetchBrowseLayout` 内部 `await api.searchAssets`，协议层有 request 超时/失败路径，最坏是永久停在估算高。**`layoutHydrationCompleteRef` 现在对所有 scope 都在 `beginPage` 第 424 行提前置 true——这是既有的 Serpent-9cfc8c 行为，非本轮回归**，且对 compact scope 而言 `layoutRef` 已等于完整首页，语义成立 | note（无新增风险） |
| B7 | **度量指标口径：「滚动期间 0% spread」是否公允** | 发现 | `heightStability`（`browse-nas-performance.test.ts:293-312`）把**全部阶段**的 `scrollHeight` 合成一个 min/max，`spreadPct = (max-min)/max`。`settle` 阶段紧随首帧（`:362`）开始采样，若 `layoutOnly` 尚未到达，`max` 会包含索引到达前的高估算前缀。这解释了两个 run 的 `spreadPct` 分别是 `0`（索引先到）与 `16.6%`（索引后到）——**该指标受采样时机支配，本身不是稳定指标**。逐阶段的 `distinctHeights` 确实支撑「索引到达后各滚动阶段高度恒定」这一较弱但更可信的结论 | should-fix：报告只引用 `distinctHeights`，或让采样等到种子完成再开始计 spread；**不要**把 `0%` 当成可复现结论 |
| B8 | **一次性索引到达高度变化（约 20%）的披露** | 发现（文档不一致） | 开发日志「未解决 2」正确披露（57999 ↔ 69561，约 20%），设计 §7 判据 3 也允许「索引提交时的一次性变化」。但 `docs/internal/qa/human-acceptance-checklist.md` CANVAS-038 行写「`scrollHeight` 波动由 8.7–13% 降到 **0%**（全程恒定 57999px）」——**「全程恒定」与开发日志自述的 16.6% 直接冲突**，而清单是给人看的验收依据 | should-fix：清单改为「滚动阶段高度恒定；打开时索引到达有一次约 20% 的一次性变化（已声明可接受）」 |
| B9 | **度量工具未声明/未强制的副作用：会写真实库** | 发现 | 工具打开的是真实库（`SERPENT_E2E_OPEN_LIBRARY_PATH`），会驱动 worker 处理待办 `generate_thumbnail` / `extract_palette` 并写 `.serpent/artifacts` 与 `library.db`（设计 §7 与开发日志「副作用」都已如实记录，且用户已同意）。但代码层面**没有任何「我确认这是可写库」的显式开关**，唯一的门槛是路径 env 存在 | note（建议加一个显式确认变量，避免日后误指到不该写的库） |
| B10 | **最强的现场证据未被收进结果表** | 发现 | 工具的 `mainLog.sourceRequests`（`:451`）与 `mediaJobInterrupted`（`:452`）才是「视口卡片不重复加载」的直接证据，但开发日志的对比表只列了渲染端 `src` 写入/冗余，没有列 `sourceRequests` 的前后值，也没有列 `mediaJobInterrupted` | should-fix：把这两个值补进度量表；否则「不重复加载」的结论只有间接证据 |
| B11 | **`tests/e2e/asset-pagination.test.ts` 新增断言的判别力** | 部分 | 新断言（`:90-118`）检查「滚到 15% 时 `scrollHeight` 在 85%–125% 内且 `.asset-card` 数 > 0」。它的对照基准是**本进程自己**在 15% 之前的 `scrollHeight`，因此对「索引到达后不再变化」有判别力，但对「首帧到索引到达」这一段（正是 20% 一次性变化所在）无判别力；且 `mid.cards > 0` 对「每张卡重挂」这一症状**无判别力**（重挂后卡片数依然 > 0）。E2E 里也没有重挂/媒体请求计数 | should-fix：断言里加入「阶段内 `scrollHeight` 不变 + 同一 asset 不重复写 `src`」，或明确标注该 E2E 只覆盖「画布不塌缩」，重挂计数由 NAS 度量工具承担 |
| B12 | **`virtualSlotAsset` 的摘要优先语义** | 通过 | `browse-window-slots.ts:143-148`：已加载摘要优先，否则由索引合成，占位符返回 undefined。新增用例（`tests/unit/browse-window-slots.test.ts` CANVAS-038 用例）覆盖了三条分支。注意合成摘要的 `mediaType` 在 `evictVirtualSummaryPage` 之后会丢（该函数 `virtual-browse-layout.ts:277-290` 不保留 `mediaType`）→ 合成卡短暂回落为 `other`；但被淘汰的槽位通常已离开视口 | note |

---

## 阻断缺陷（Blocking defects）

**没有会让改动「不安全合并」的 P0。** 具体地：

- 跨进程能力边界**收紧**而非放宽（删除协议面、未削弱任何保留的 Zod 校验）；
- 数据兼容为纯增量（`mediaType` 可选、`strictObject` 保持、未动 `MIGRATIONS`）；
- 磁盘/工作区无残留，度量工具默认不执行且路径全来自环境变量；
- `npx tsc --noEmit` exit 0。

以下两项虽不构成「不安全」，但**在修掉之前我不建议标记该验收项为完成**：

1. **P1 — `applySummaryPage` 的内容等价推断不成立**
   `src/renderer/browse/use-virtual-browse-session.ts:213-226` 的判据（`entries.size` + `geometryRevision`）无法覆盖 `evictVirtualSummaryPage`（`src/renderer/browse/virtual-browse-layout.ts:262-303`）对 `entries` 内容的原地改写，也与该处注释自述的「byte-for-byte equivalent」不符。后果是 `browseLayout`（`src/renderer/App.tsx:744`）与 `virtualLayoutRef.entries` 静默发散，`src/renderer/App.tsx:2322-2329` 的 `selectedLayoutEntry` 会优先取到 stale 副本。
   建议：把判据换成「`next.entries !== current.entries` 引用比较」（`mergeLayoutEntries` 在无有效更新时返回原对象，见 `virtual-browse-layout.ts:68`；有更新时必返回新对象）——这一条同时消掉假阴性与假阳性，且比 size 比较更便宜。

2. **P1 — 设计 §5 L6 强制要求的基准断言改写缺失**
   设计文档原文：「必须在同一次变更里把断言改写成新不变量…不得为了绿灯删断言」。`tests/e2e/large-library-scroll-benchmark.test.ts` 未被改动，其中 `.asset-card:not(.is-layout-preview)`（`:174`、`:208`、`:442`）、`is-browse-placeholder` / `__pending:`（`:450-453`）、`layoutPreview`（`:489`）在虚拟路径已经不再渲染这些节点后**全部恒真/恒 0**，基准的 `passed` 口径已静默改变——而该口径正是开发日志 20k 对比表的数字来源。

---

## 覆盖缺口（Coverage gaps）

| 缺口 | 说明 |
| --- | --- |
| `applySummaryPage` 的跳过重发布分支 | 无任何测试。纯函数测试只覆盖 `createVirtualBrowseLayoutFromIndex` / `virtualIndexMatchesFirstPage` / `mergeVirtualSummaryPage`，`useVirtualBrowseSession` 这个 hook 本身全仓**零测试**（`grep seedIndex\|noteVisibleRange\|applySummaryPage` 在 `tests/` 无命中） |
| `begin` 的复用分支 | `virtualIndexMatchesFirstPage` 有测试，但 `begin` 里 `reusable` 为真时的实际效果（保留 `previous.total`、跳过 `summaryPagesRef.clear()`、跳过 `registerSummaryPages`）无测试 |
| 虚拟画布「空槽」渲染 | `tests/unit/virtual-browse-canvas.test.ts` 只测几何纯函数；`VirtualMasonryColumns` / `VirtualJustifiedAssetRows` 的渲染分支（含 `virtualSlotAsset` 返回 undefined 时渲染 `null`、`aria-hidden` 差异）无组件测试 |
| `mediaType` 端到端 | 无测试断言 `layoutOnly` 响应包含 `mediaType`，也无测试断言合成卡片的 `mediaType`/徽章与摘要到达后一致（`tests/` 中 `renderLayoutPreview`、`layout.*mediaType` 零命中） |
| I4「媒体附上后不撤销」 | 无自动化断言；只能靠肉眼或 NAS 度量工具 |
| 首波 p95 回归 | 开发日志「未解决 1」自述 20k 首波 p95 由 553.7 ms 劣化到 1063.9 ms（10 跳中 3 跳约 1 s）。本轮**没有**为该劣化建立门禁或回归测试，「不劣化」这一判据（设计 §5 L6 判据）未达成自动化 |
| 20k 全量 `test:e2e` | 开发日志明示「`npm run test:e2e` 全量未执行」，只跑了 `asset-pagination` 与大型库基准。按 AGENTS.md 核心体验回归门禁（触及浏览主路径）应重跑真实 Electron E2E |
| `test:library-availability` | 开发日志称跑过 211 项通过（含 1 次 teardown `EPERM` 疑似 flaky）；本轮改动触及 `library-service.ts`，该门禁为强制项，但结果未被独立复核 |
| Computer Use / packaged / macOS | 未执行（开发日志已声明） |

---

## 明确未能核验（Explicitly unverified）

1. **真机 NAS 度量数字**：`NAS 库` 与 `仓库外的临时夹具目录` 均不在本次审查可访问范围，开发日志表中所有「本轮」数字（795/789 槽位创建/卸载、250/200 媒体写入、20k `passed` 5/10、首波 p95 1063.9 ms 等）**只能复核其口径，无法复核其值**。工具本身（`browse-nas-performance.test.ts`）我逐行读过并可确认：默认 `test.skip`、userData 隔离、临时目录回收、路径全来自环境变量。
2. **未运行任何测试**：本次为只读审查，未执行 `npm run test:unit` / `test` / `test:library-availability` / `test:e2e`。仅实跑了 `npx tsc --noEmit`（exit 0）。因此「461 files / 3418 passed / 5 skipped」「4777 passed / 3 failed」等断言未经复核。
3. **`is-layout-preview` 恒真后基准是否仍绿**：我确认了断言的判别力被清空，但未运行 `test:e2e:large-library-benchmark`，故不能断言它现在是红的还是「恰好仍绿」。
4. **`.masonry-card-slot` 空槽的实际指针/焦点行为**：我核对了 CSS（无 `pointer-events: none`）与 DOM（masonry 路径无 `aria-hidden`），但未在真实 Electron 中实测框选、Tab 顺序、屏幕阅读器输出。
5. **`use-browse-pagination.ts` 中 `fetchPageAt` 的 `useCallback` 依赖是否完整**：本轮从 `ensureVisibleRange` 的依赖数组里删掉了 `fetchPageAt`，该数组现在不含它。ESLint 的 `react-hooks/exhaustive-deps` 对 `useCallback` 依赖的判断依赖被调函数是否在组件作用域内定义；我未运行 `npm run lint` 确认，也未逐行核对整个 hook 的依赖图。
6. **Windows / packaged 行为**：未执行，无法核验 `scrollHeight` 差异或压缩路径。
7. **`library-service.ts` 的 `layoutOnly` 与摘要页是否真能给出不一致的宽高**（B/I2 的前提）：需要真实库数据验证，未执行。
