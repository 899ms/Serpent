# 2026-09-13 CANVAS-038 几何一次播种与槽位身份

- 分支：`codex/performance-20260913`
- 基线：`570b3cfa`（工作区相对该提交）
- 规格/设计：[`2026-09-13-canvas-038-browse-media-pipeline-redesign.md`](2026-09-13-canvas-038-browse-media-pipeline-redesign.md)
- 验收项：`docs/internal/qa/human-acceptance-checklist.md` **CANVAS-038**
- 状态：实现完成，自动化与真机度量已取，**待用户本人验收**
- 前置：上一轮（工作区未提交）改动已 `git stash` 存为
  `wip: CANVAS-038 midsize-browse partial fix (superseded by top-level redesign)`，
  本轮从干净 HEAD 重做。

## 现象（用户口径）

约 1000 项资产的资源库（网络盘）滚动时：滚动条拇指忽大忽小；已出现的卡片整张消失再出现；滑到约 15% 时全部卡片反复重新加载。上一轮用户明确不通过。

## 根因（详见设计文档 §3）

- **R2 几何增量供给（上一轮引入的回归）**：虚拟浏览用 128 行几何块渐进供给，几何在滑动中被修订约 12 次，每次修订重排槽位、重切窗口。1442 项的库正好落进被改动的 101–2000 区间。
- **R3 槽位身份翻转**：`asset ? renderCard(...) : renderLayoutPreview(entry)` 让占位影子卡与真实卡片互相替换，加上内层 `key={assetCardKey(libraryId, assetId)}`，每次身份到达都卸载重建媒体子树。
- 实测否证了上一轮「全量几何在网络盘更慢」：整个 1442 行索引一次查询 **217 ms 冷 / 4 ms 热**；12 个 128 行块的页读取量是整索引的超集，还要多付 12 次 IPC。
- R1（网络库 origin 无字节缓存 → 反复读 SMB）与 R4（任务抖动）已确证，但按用户决定**本轮不动封面路由（L3）**。

## 修改（旧行为 → 新行为）

| 位置 | 旧行为 | 新行为 |
| --- | --- | --- |
| `use-browse-pagination.ts` `beginPage` | 虚拟会话只发 128 行几何块；非虚拟会话才发一次 `layoutOnly` | 两种 scope 都只发一次 `layoutOnly` 完整索引；虚拟会话用它**一次播种**几何 |
| `browse/use-virtual-browse-session.ts` | 持有 `BrowseGeometryBlockCache`（LRU 24 块）、in-flight 表、`ensureRange` 逐块拉取并反复修订几何 | 删除上述全部；新增 `seedIndex`（一次提交）与 `noteVisibleRange`（只维护摘要页 LRU） |
| `browse/virtual-browse-layout.ts` | `mergeVirtualGeometryBlock` / `evictVirtualGeometryBlock` 按块增量修订 | 删除；新增 `createVirtualBrowseLayoutFromIndex`（整索引一次成型）与 `virtualIndexMatchesFirstPage` |
| `browse/virtual-browse-canvas.tsx` | 槽位 `key={\`${assetId}-${index}\`}`；占位渲染 `BrowseLayoutPreview` 影子卡 | 槽位 `key=virtualBrowseSlotKey(index)`（只由 index 决定）；身份未解析时**不渲染任何卡片**，解析后同一节点挂上真实卡片（`stableSlot: true`） |
| `App.tsx` `renderAssetCard` | 内层 `CardTag` 恒用 `key=assetCardKey(libraryId, assetId)` | 虚拟路径省略该 key（身份由外层槽位承担）；普通路径不变 |
| `browse-window-slots.ts` | `assetSummaryFromLayoutEntry` 只在有 displayName 时合成；虚拟槽位直接从 `assetById` 取 | 从索引身份合成完整首帧卡片（含 `previewKind`/`mediaType`）；新增 `virtualSlotAsset` 优先已加载摘要、否则合成、占位返回 undefined |
| `asset-types.ts` / worker `layoutOnly` | 索引行不含 `mediaType` | 新增 `mediaType`（worker 本已算出用于 source-direct 判定，几乎零成本），让索引身份足以渲染真实卡片 |
| `use-virtual-browse-session.ts` `begin` | 每次 begin 都用首页重建虚拟布局 → 后台刷新会把已提交索引打回 100 项前缀（估算高度），滚动条跳 ~20% | 首页 assetId 与已提交索引一致时**复用**已提交索引（`virtualIndexMatchesFirstPage`，按内容判定，不比较请求级字段） |
| `use-virtual-browse-session.ts` `applySummaryPage` | 每个摘要页到达都重建并发布全量物化数组（20k 时 O(n)） | 身份与几何未变时跳过重建与发布 |
| 分块几何协议 | `browse.session.geometry(.request)`、`browseGeometryEntry/Block` schema、preload `fetchBrowseSessionGeometry`、worker/main 转发、performance-contract 条目 | **全部删除**（用户决定直接删除分块路径） |

## 测试变更（旧断言 → 新断言，不是删测试消失败）

| 测试 | 处理 |
| --- | --- |
| `tests/unit/virtual-browse-session.test.ts` | 删除被测行为已消失的 `BrowseGeometryBlockCache` / `geometryBlockStartsForRange` / 块 LRU 三个用例；新增：`shouldUseVirtualBrowseLayout` 门槛、整索引一次提交（无占位残留、摘要 patch 不动几何）、截断索引保留 COUNT 与占位尾巴、`virtualIndexMatchesFirstPage` |
| `tests/unit/browse-window-slots.test.ts` | 新增 `virtualSlotAsset`：占位→undefined、真实身份→合成卡片、已加载摘要优先 |
| `tests/unit/browse-pagination.test.ts` | 无新增（曾短暂加入定义比较用例，改为内容比较后移除） |
| `tests/unit/protocol.test.ts` | 几何块协议往返用例改为 `browse.session.ids` 往返（能力已删除，非失败掩盖） |
| `tests/unit/native-asset-drag-prime.test.ts` | 「非卡片响应不预热拖拽」的夹具从已删除的 `browse.session.geometry` 换成 `browse.session.ids`，意图不变 |
| `tests/unit/interactive-scheduler.test.ts` | 浏览读不抢占缩略图工作的夹具换成 `browse.session.page` |
| `tests/e2e/asset-pagination.test.ts` | 新增：虚拟槽出现后滑到 15%，`scrollHeight` 不得塌缩/暴涨、卡片数不得归零（CANVAS-038 回归门禁） |

## 自动化结果（当次命令）

| 命令 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npm run test:unit` | **461 files / 3418 passed / 5 skipped** |
| `npm run test`（Electron runner，全量） | 548 files / **4777 passed** / 3 failed（见下「未解决」） |
| `npm run test:library-availability` | **9 files / 211 passed / 1 skipped**（干净通过） |

## 真机度量（`NAS 库`，SMB 网络库，1442 项）

工具：`tests/e2e/browse-nas-performance.test.ts`（默认 skip，需 `SERPENT_E2E_NAS_LIBRARY_PATH`）。同库、同旅程（打开 → 停 4s → 滚到 15% 停 4s → 回顶 2s → 再滚 15% 停 4s → 回顶 2s），100 ms 采样。

| 指标 | 回归态 运行1 | 回归态 运行2 | 本轮 |
| --- | --- | --- | --- |
| 首张卡片 | 2063 ms | 3667 ms | 2154–3604 ms |
| 槽位真实创建 / 卸载 | 1015 / 1009 | 935 / 929 | **795 / 789** |
| 媒体元素创建 | 140 | 154 | **120** |
| 媒体 `src` 写入 / 冗余 | 290 / 250 | 318 / 262 | **250 / 200** |
| 每阶段 `distinctHeights` | 3–4（随滚动位置漂移） | 3–4 | **全部 5 个阶段均为 1** |
| 滚动时段高度波动（`scrollingSpreadPct`） | 8.7–13% | 8.7% | **0%** |
| 打开时索引到达的一次性变化 | 有（前缀→全量） | 有 | **仍在，见下** |

`scrollHeight` 的正确读法（审查后修正）：

- **度量口径**：`heightStability` 只统计**滚动时段**（`dwell15a`/`backTop`/`dwell15b`/`settleTop`），把首个 `settle` 阶段单独报告为 `openIndexTransition`。此前版本把 `settle` 并入 min/max，导致 `spreadPct` 完全取决于「索引是否在首次采样前到达」——同一构建两次运行分别得到 0% 与 16.6%，不可复现。**任何报告都只应引用逐阶段 `distinctHeights`，不得引用旧的全程 spreadPct。**
- 回归态是**每个滚动阶段都在变**（3–4 个不同高度，随滚动位置漂移）——即用户报的「滚动条忽大忽小」。
- 本轮**所有 5 个阶段的 `distinctHeights` 均为 1**，滚动时段波动 **0%**。
- **剩余问题**：打开时由「100 项估算前缀」切换到「完整索引」的那一次高度变化（本库 57999 ↔ 69561，约 20%）仍然存在，只是采样是否覆盖到它取决于就位时机（最近一次运行索引在采样前就位，`openIndexTransition.changed = false`）。该变化在设计文档中声明为可接受的一次性就位，**不是滚动过程中的抖动**；用户复验时需单独确认它是否可接受。

Main 侧（同一次旅程）：

| 指标 | 回归态 | 本轮 |
| --- | --- | --- |
| `serpent-protocol.source-request`（唯一 origin 读） | 12 / 44 | 24 |
| 预览镜像命中 `preview-cache hit` | （计数器失效）/ 54 | 40 |
| `worker.media-job.interrupted` | 0 | 0 |
| `serpent://source` 写入次数 | 96 / 100 | 96 |

`source` 写入次数未变符合预期——封面路由（L3）本轮按用户决定未动，origin 仍无字节缓存。用户本机历史会话的同类计数为 **1292 次请求 / 266 个资产 / 1026 次冗余（79%）**，是「反复重新加载」最有力的现场证据。

## 20k 大型库度量（`仓库外的临时夹具目录`）

夹具：20,000 资产（18,200 图 / 1,000 视频 / 200 模型）、160 文件夹、50 合集。

| 指标 | 改动前 | 中间态（含 P1-1 缺陷） | **最终** |
| --- | --- | --- | --- |
| 严格 500ms 全图解码 `passed` | 0/10 | 0/10 | **6/10** |
| 全图解码 p50 | 1833 ms | 2305.5 ms | **398.9 ms** |
| 全图解码 p95 / max | 2882.9 ms | 5004.3 ms（触顶） | **1159.3 ms** |
| 首波 p50 | 321.4 ms | 219.5 ms | **335.5 ms** |
| 首波 p95 | 553.7 ms | 1218.5 ms | **1159.3 ms（仍差于改动前，见下）** |
| 每跳请求波次 | 2–4 | 4–42 | **2–9** |
| 5 s 内最终补齐 | 10/10 | 9/10 | **10/10** |

`test:perf:large-library`（worker 层）基线：`layoutMs`（完整 20k 索引）**115 ms**，门禁 < 5000 ms。

**基准口径已修正（审查 P1-2）**：该基准原先用 `.asset-card:not(.is-layout-preview)` 与 `is-browse-placeholder`/`__pending:` 过滤影子卡与占位卡；虚拟路径现在**不再渲染这两类节点**，过滤器因此恒真、计数恒 0 —— 数据来源的口径被静默改变。现已在跳转前把「影子卡数 = 0、占位卡数 = 0」纳入门禁条件（`large-library-scroll-benchmark.test.ts` 的 `layoutReady` 判定），若将来重新引入这两类节点，门禁会失败而不是继续静默计错。上表「最终」一列即在该更严格口径下测得，`passed` 反而由 5/10 升到 6/10。

**性能与正确性的取舍过程（值得记录）**：审查指出 `applySummaryPage` 用 `entries.size`/`geometryRevision` 推断「内容等价」不成立（`evictVirtualSummaryPage` 会原地改写 entry 内容而 size 不变）→ 我先改成 `next.entries !== current.entries` 引用比较，正确性恢复，但**每个摘要页又都触发 20k 条物化 + 壳层重渲染**，p50 从 401 ms 退化到 2461 ms、每跳波次回到 4–30。最终方案两者兼顾：**只有槽位身份变化（`assetIdsByIndex` 引用变化）才发布 `browseLayout` 状态并重渲染；纯内容变化只置脏标记，由 `getLayout()` 按需重建**（`layoutDirtyRef`）。这样既不会让 `browseLayout` 与虚拟索引静默发散，也不再把 O(n) 重发布放在热路径上。

`npm run test:e2e` 全量未执行；本轮只跑了受影响的 `asset-pagination` 与大型库基准。

## 代码审查与后续处置（双轴，deepseek-flash）

审查报告：`docs/internal/reviews/2026-09-13-canvas-038-geometry-seeding-review.md`。结论：**无 P0**；协议删除无残留引用、`mediaType` 为纯增量且未放宽 `z.strictObject`、未动 `MIGRATIONS`、`App.tsx` 净改动 +2/−1。

| 审查项 | 处置 |
| --- | --- |
| **P1-1** `applySummaryPage` 用 size/revision 推断内容等价不成立（eviction 原地改写 entry，size 不变）→ `browseLayout` 与虚拟索引静默发散 | **已修**：改为「身份变化才发布状态 + 内容变化置脏由 `getLayout()` 按需重建」；新增单测钉住「eviction 改变 entries 引用但不改 size/revision」这一前提 |
| **P1-2** 20k 基准断言未随架构改写，`.is-layout-preview` / 占位卡过滤器恒真 | **已修**：把「影子卡=0、占位卡=0」纳入门禁条件并重跑，数据口径已恢复有效 |
| should-fix 1 清单文案与开发日志矛盾、`spreadPct` 不可复现 | **已修**：清单改写为逐阶段 `distinctHeights` 口径并披露一次性变化；`heightStability` 只统计滚动时段，新增 `openIndexTransition` 与 `perPhaseDistinctHeights` |
| should-fix 2 未解析槽位渲染 `null`、masonry 空槽无 `aria-hidden`、空槽命中测试 | **部分处置**：masonry 空槽补 `aria-hidden`（与 justified 路径一致）。`pointer-events` 未改：空槽内无节点、无事件处理器，点击/框选事件冒泡到画布；`.asset-card` 选择器不受空槽影响，未发现实际缺陷，不为猜测改命中行为。App 传 `renderLayoutPreview` 并非死代码——同一 prop 由 dense 路径消费，仅虚拟分支不使用 |
| should-fix 3 `useVirtualBrowseSession` 无测试、`protocol.test.ts` 丢一层、`sourceRequests` 未进表 | **部分处置**：恢复 `browse.session.ids` 的 worker response 往返层；新增 `virtualIndexMatchesFirstPage`、`virtualSlotAsset`、整索引播种、eviction 语义四组单测。Hook 级端到端仍缺直接用例（见「未解决」） |
| 次要 `readBrowseSessionGeometry` 成生产死代码 | **保留并注明原因**：它是 20k worker 基线 `browseSessionGeometryMs` 的测量接缝，删除会连带作废已记录的基线数值；已在方法上写明「生产不可达、仅为基线接缝、不得未经身份保证重新接回渲染路径」 |
| 次要 度量工具注释对 `playwright test` 的表述不准 | **已修**：明确它不在 `npm run test:e2e` 清单内，且无环境变量时在 `tests/e2e` 下也会 skip |

## 未解决 / 未验证

1. **首波 p95 在 20k 上仍差于改动前**（553.7 → 1159.3 ms，三次运行 1063.9 / 1218.5 / 1159.3 一致复现，10 跳中约 2–3 跳接近 1 s；`p95 == max` 说明是少数跳）。p50（335.5 vs 321.4）与总体解码（p50 398.9 ms，快 4.6×）都大幅改善，但这一档百分位未达标，**不得写成已达标**。未定位到具体跳的成因。
2. **打开时索引到达的一次性高度变化**仍在（本库 57999 ↔ 69561，约 20%）。可用首页已知宽高的均值改善估算精度（上一轮尝试过），本轮未做。
3. **Hook 级端到端仍无直接用例**：`useVirtualBrowseSession` 的 `seedIndex` / `begin` 复用分支 / 脏标记按需重建只有其依赖的纯函数级单测（`virtualIndexMatchesFirstPage`、eviction 语义、整索引播种），hook 本身零测试。`asset-pagination.test.ts` 的新断言只覆盖「不塌缩 + 卡片数>0」，对「卡片是否重挂」无判别力；真机度量工具里的元素级重挂指标没有进 E2E 门禁。
4. `npm run test` 有 3 个与本轮无关的失败：`migration-checksum-snapshot`（golden 快照缺 v49，确定性既有）、`reconciliation-performance`（时序预算 124 ms > 75 ms，受并发负载影响）、`library-availability` 的 **teardown** `EPERM` 清理（隔离重跑 211 项全绿）。后者按纪律记为**疑似 flaky、未定位时序耦合、未关闭**。审查后又改动了 renderer 侧文件与 `library-service.ts` 的**注释**，未改 worker 行为，故未重跑 `test:library-availability`；重跑前的 211 项通过记录仍是有效依据，但严格说这是「同功能代码、不同提交」。
5. L3 封面路由未动：`serpent://source` 仍无字节缓存。真机度量显示本库每个旅程仍有 24–96 次 source 写入；用户已决定本轮不做。
6. Computer Use、packaged、macOS 未执行。真机数字由我采集，用户尚未本人复验。

## 现场证据（用户本机会话日志，只读）

| 会话 | 事件 | 计数 |
| --- | --- | --- |
| `serpent-20260913T134635.log` | `serpent-protocol.source-request` | **1292** |
| | 去重资产数 / 冗余 origin 读 | **266 / 1026（79%）** |
| | 单资产最多被读 | **14 次** |
| `serpent-20260913T153538.log` | `worker.media-job.interrupted` | **19 / 27 行** |

## 副作用与清理

- 真机度量的副作用（用户已同意）：打开该库使 `generate_thumbnail` queued 197 → 269、`extract_palette` queued 42 → 99，产物几乎零新增（这本身是 R4 的证据）。ready 缩略图 1104 与 source-direct 无缩略图 296 **不变**，故前后对照仍可比。无删除、无数据丢失。
- 本轮创建的测试产物：`仓库外的临时夹具目录`（20k 夹具 28.6 GiB + 基准副本 28.7 GiB，仓库外）、`test-results/`（已删）。夹具在后续 10k+ 复测前保留。
