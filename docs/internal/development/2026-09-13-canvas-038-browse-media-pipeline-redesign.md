# 2026-09-13 CANVAS-038 顶层分析：中等规模浏览的几何供给与画布媒体

- 状态：**已按 L1+L2+L4 实施**（L3 封面路由按用户决定缓一轮）；结果与残余问题见
  [`2026-09-13-canvas-038-geometry-seeding-development-log.md`](2026-09-13-canvas-038-geometry-seeding-development-log.md)
- 分支：`codex/performance-20260913`
- 基线：工作区相对 `570b3cfa`
- 验收项：`docs/internal/qa/human-acceptance-checklist.md` **CANVAS-038**
- 度量库：`NAS 库`（SMB 网络库，`NAS 共享`）

## 0. 结论摘要

1. **用户新报的「滑到约 15% 时全部卡片反复重载」是上一轮改动引入的回归，不是遗留问题。** 上一轮把 101–2000 项区间的几何供给从「一次性完整索引」换成「128 行增量几何块」。本库 1442 项，正好落进这个区间：几何在滑动过程中被修订约 12 次，每次修订都会重排槽位、翻转槽位身份，把已挂载的媒体子树卸载重挂。约 15% ≈ 第 2 个 128 边界。
2. **缩略图直出（`previewKind: source`）在网络库上的真实危害不是「显示 origin」，而是「origin 抑制了缩略图生成」。** 只要缩略图永不生成，封面路由就永远停在 origin，重挂一次读一次，永远不收敛。本库有 **296** 个卡片处于这个状态。
3. **上一轮判断「全量几何在网络盘上更慢」不成立。** 实测：整个 1442 行索引一次查询 **217 ms（冷）/ 4 ms（热）**；12 个 128 行块的合计页读取与整索引相同（5 ms），另付 12 次 IPC 往返。分块方案在任何缓存状态下都不可能比整索引更省。
4. 因此设计方向是**回到一次播种**，并把槽位身份与封面路由收成不变量，而不是继续在增量块上打补丁。

## 1. 实测基线（2026-09-13 15:47–15:57）

### 1.1 库画像（`)` 只读打开 NAS `library.db` 统计）

| 指标 | 值 |
| --- | --- |
| live 资产（available 且未删除） | **1442** |
| 其中 linked 文件夹下的资产 | **1429**（另 13 在一个 managed 文件夹） |
| 有 ready 缩略图 / 视频海报 | 1104（76.6%） |
| **没有 ready 缩略图** | **338（23.4%）** |
| 已知 source 宽高（`extracted_metadata`） | **1442（100%）** |
| 按策略可 source-direct 的图片 | **767（53.2%）** |
| **可 source-direct 且没有缩略图** | **296（20.5%）** |
| 这 296 个的文件体积合计 | **201.1 MiB** |
| 源文件总体积 / 中位 / p90 / max | 8.33 GiB / 667 KiB / 10.85 MiB / 515 MiB |
| 待办任务 | `generate_thumbnail` queued **197**、`extract_palette` queued 42 |

关键点：本库 **100% 的资产都有已知宽高**。因此「未知行估高」这类问题在本库根本不适用——几何是完全可知的，只是当前管线没有一次取全。

### 1.2 成本测量

| 测量 | 结果 |
| --- | --- |
| 单个 origin 文件全量读（≤2 MiB 图，冷） | 中位 **22.7 ms**，p90 50.2 ms |
| 同一批文件重复读（SMB 客户端缓存命中） | 中位 **1.1 ms** |
| 完整 1442 行几何索引（含 artifacts 子查询） | **217 ms 冷 / 4 ms 热** |
| 12 × 128 行分块（首次之后的块） | 合计 5 ms，单块 0–1 ms |
| 只读打开 NAS `library.db` | 不产生 `-wal`/`-shm`/`-journal` 侧文件（`journal_mode=delete`） |

测量方法：`better-sqlite3` 只读打开 NAS 库 + `fs.readFileSync` 顺序读源文件；脚本为本机一次性探针，未写入仓库。冷值基于当时本机 SMB 客户端缓存状态，**结论对缓存状态不敏感**：分块方案的总页读取量是整索引的超集，还要多付 12 次 IPC，不存在更快的情形。

### 1.3 画布行为基线（真机旅程，约 25 秒）

`tests/e2e/browse-nas-performance.test.ts`（新增度量工具，非门禁）：真 Electron + 该库 + 隔离 userData + **生产态预览镜像**（`SERPENT_PREVIEW_CACHE_FORCE=1`，否则 `SERPENT_E2E=1` 会关掉镜像，见 `src/main/index.ts:589`）。固定旅程「打开 → 停 4s → 滚到 15% 停 4s → 回顶停 2s → 再滚到 15% 停 4s → 回顶停 2s」，100 ms 采样。

| 指标 | 值 |
| --- | --- |
| 首张卡片出现 | 2063 ms |
| **槽位真实创建 / 真实卸载**（已排除 DOM 重排移动） | **1015 / 1009** |
| DOM 移动（不算重挂） | 109 |
| 媒体元素创建 | 140 |
| 单个元素被重复写 `src` 的最大次数 | 2 |
| 媒体 `src` 写入 | 290 次，但只有 **40** 个不同 URL → **250 次冗余** |
| 其中 `serpent://preview` / `serpent://source` | 194 / 96 |
| Main 侧唯一 origin 请求 | 12 |
| `scrollHeight` 波动 | 61205 – 69021 px（**±13%，且随滚动位置变化**） |

要点：

- 槽位创建/卸载是**真实重挂**（移动已单列且仅 109），说明卡片确实在被销毁重建，不是度量假象。
- 媒体抖动的主形态是**元素级 churn**（140 个元素、单元素最多写 2 次），即每次重挂新建 `<img>`，而不是同一节点被反复改 `src`。
- `scrollHeight` 在 4 秒窗口内有 3–4 个不同取值、跨阶段差 13%，**方向取决于当前加载到哪个几何块** → 直接对应「滚动条拇指忽大忽小」。

### 1.4 用户真实会话日志（最强的现场证据）

用户本机 `%APPDATA%\Serpent\logs` 中两个会话：

| 会话 | 事件 | 计数 |
| --- | --- | --- |
| `serpent-20260913T134635.log`（363.7 KiB） | `serpent-protocol.source-request` | **1292** |
| | 去重后的资产数 | **266** |
| | **冗余 origin 读（去掉首次）** | **1026（79%）** |
| | 单个资产被请求最多次数 | **14** |
| | 被请求 ≥10 次的资产 | 54 |
| | 被请求 ≥5 次的资产 | 98 |
| `serpent-20260913T153538.log`（24.5 KiB，27 行） | `worker.media-job.interrupted` | **19 / 27 行** |

解读：

- 266 个资产被读 1292 次，去掉首次仍有 **1026 次重复 origin 读**。`serpent://source` 没有字节缓存，每一次重复都是真读 SMB。这与用户「所有资产卡片都在反复重新加载」在数量级上完全吻合。
- 15:35 那次失败会话里 27 行日志有 19 行是媒体任务被取消（`cancelled while waiting for a decoder` / `after image decoding` / `before thumbnail generation` / `after palette decoding`），且同一 `assetId` 反复出现（如 `cf5cd236…`、`6c98858d…`、`f6e47255…` 各出现两次）→ 渲染端反复请求同一张卡，把在跑的产物任务反复打断。这是「反复加载」的 Worker 侧副作用。


### 1.5 20k 大型库基线（`仓库外的临时夹具目录`，本地盘）

夹具：`version 3`、20,000 资产（18,200 图 / 1,000 视频 / 200 模型）、160 文件夹、50 合集、39,295 文件 / 29.3 GB。

`npm run test:perf:large-library`（worker 层，in-process，无 IPC）：

| 指标 | 值 | 门禁 |
| --- | --- | --- |
| **`layoutMs`（完整 20k 索引 `layoutOnly`）** | **115 ms** | < 5000 ms |
| `browseSessionOpenMs` | 30.6 ms | < 5000 ms |
| `browseSessionGeometryMs`（128 行块） | 3.3 ms | < 5000 ms |
| `browseSessionPageMs` | 2.3 ms | < 5000 ms |
| `collectionRecursiveLayoutMs` | 95.2 ms | < 5000 ms |
| `allBrowseMs` / `searchMs` | 13.4 ms / 18.8 ms | — |

**结论：L1 在 20k 上的查询成本完全可接受（115 ms，门禁的 2.3%）。** 但必须注意：worker 层测量**不含** IPC 序列化、Zod 校验与 Renderer 布局构建——**20k 行索引经 IPC 送达 Renderer 这条路在现有产品里没有先例**（20k 库在回归前走的是 `total > 2000` 的虚拟分块路径）。L6 里列的三项风险（IPC 载荷 / Map 构建 / O(n) 重物化）必须由真机基准来收口，不能靠 worker 数字外推。

**一次疑似 flaky（已复现检验，结论：不归因于代码，未关闭）**：

首次在**刚生成的 20k 夹具**上跑 `npm run test:perf:large-library` 时，「records the 20k remote metadata cache cold/hot browse baseline」失败：

```
AssertionError: expected false to be true
  at tests/worker/large-library-performance.test.ts:373  (cachedSamples.primaryBrowseStatements.every(...))
```

当时 `snapshotBuildMs = 141320 ms`、`cachedBrowseStatements = [2,2,2,2,2,2,2]`。

**复现检验（2026-09-13，已 stash 到干净 HEAD `570b3cfa` 后重跑同一用例）**：

```
snapshotBuildMs = 18476 ms，cachedBrowseStatements = [0,0,0,0,0,0,0]，cachedHit = true
✓ records the 20k remote metadata cache cold/hot browse baseline  19857ms
```

结论：**在干净 HEAD 上通过，且原始失败无法复现**，因此**不得**归因为「既有代码失败」，也**不得**归因于上一轮工作区改动（`library-service.ts` 当时与 HEAD 逐字节相同）。可疑方向是首次冷启动的远端元数据快照构建（141 s vs 18.5 s，7.6×）与用例内时序耦合。

按验收纪律第 6 条：重跑通过**不构成关闭**，此条记为**「疑似 flaky，未定位时序耦合，未关闭」**。本轮实施后必须重跑并给出结论；若稳定通过则记录为冷启动相关，不得写成「已修复」。


### 1.6 20k 真 Electron 滚动基准（当前工作区）

`npm run test:e2e:large-library-benchmark`、10 次随机滚动跳转、观测窗口 5000 ms、严格门禁 `all-images`：

| 指标 | 值 |
| --- | --- |
| `passed`（严格 500 ms 全图解码） | **0 / 10** |
| `strictAllImagesWithinTarget` | 0 |
| `p50Ms` / `p95Ms`（全部可见图解码完成） | 1833 ms / 2882.9 ms |
| **`firstVisualWaveP50Ms` / `p95Ms` / `max`** | **321.4 ms / 553.7 ms / 553.7 ms** |
| `eventualCompleteCount`（5 s 内最终补齐） | 10 / 10 |

解读（作为基线，不作为待修项）：

- 20k 本地盘上**首波视觉目标 p50 321 ms 达标，p95 553.7 ms 略微越线**；严格全图 500 ms 从未达成（p50 1.8 s）。
- 这与代码注释一致：该基准把「严格全图」与「首波渐进」当成两个指标，产品主门禁是首波。
- **本轮不得把这 10 项 `passed` 写成由我们修复**；只要求实施后不劣化。



## 2. 现状架构

### 2.1 几何供给：两条互斥分支

`src/renderer/use-browse-pagination.ts` → `beginPage`（403–481）：

```
virtualized = shouldUseVirtualBrowseLayout({sessionId, total, firstPageCount})
  = sessionId && firstPageCount < total          // 当前工作区：101–2000 项也会成立
  = sessionId && total > 2000                    // HEAD（上一轮之前）

if (virtualized)  → ensureVirtualGeometryRange(...)    // 128 行分块，异步、可多次、会修订几何
else              → fetchBrowseLayout({layoutOnly:true}) // 一次返回整个 scope 的索引
```

- 非虚拟分支：`layoutOnly` 一次拿到全部轻量行（上限 `BROWSE_SCOPE_MAX_ASSETS = 50_000`，`src/shared/browse-scope.ts` 注释即「One query returns every lightweight row for the current scope」）。返回后 `setBrowseLayout(layout)`，几何此后**不再变化**。
- 虚拟分支：`BrowseGeometryBlockCache`（LRU 24 块）+ `mergeVirtualGeometryBlock` 反复修订 `VirtualBrowseLayout`，每次真实宽高到达都让 `geometryRevision` 递增（`virtual-browse-layout.ts:114-124`）。

`layoutOnly` 行携带的字段（`src/worker/library-service.ts:31757-31772`）：`assetId / width / height / previewArtifactId / displayName / relativeFilePath / previewKind / previewRevisionId / byteSize / modifiedAt / rating`。**除 `mediaType` 与派生字段外，足以渲染一张真实卡片。**

### 2.2 封面路由

`resolveAssetCardCoverUrl`（`src/renderer/asset-card-hover-preview.ts:101-133`）优先级：

```
1. thumbnailStatus === 'ready' && artifactId      → serpent://preview/<lib>/<artifactId>
2. layoutPreviewArtifactId                        → serpent://preview/<lib>/<artifactId>
3. mediaType==='image' && previewKind==='source'  → serpent://source/<lib>/<assetId>?revision=…
4. 都没有                                          → null（渲染图标占位）
```

### 2.3 缓存语义（决定重挂代价）

- `serpent://preview`：Main 在首次服务时把产物镜像进 userData（`PreviewCache`，`src/main/index.ts:7830-7875`；注释明确「Chromium 不持久化自定义协议响应」，该缓存正是为远程库而建）。**重复挂载走本机镜像。**
- `serpent://source`：只有 `SourcePathCache`（只缓存“路径解析”，不缓存字节），响应体每次从 origin 流式读出（`src/main/index.ts:7682-7812`）。**重复挂载 = 重复读 origin。**

这就是两条路由的本质差别：Route A 收敛，Route B 不收敛。

### 2.4 槽位渲染

`src/renderer/browse/virtual-browse-canvas.tsx:990-992`：

```jsx
<div key={virtualBrowseSlotKey(index)} data-layout-index={index}>
  {asset ? renderCard(asset, {loadImmediately})
         : renderLayoutPreview?.(entry, {loadImmediately})}
</div>
```

`asset = virtualSlotAsset(assetById, entry)`。槽位要变成「真实卡片」需要**两个独立渐进源同时就位**：摘要页（每页 100，`assetById`）与几何块（每块 128，`entry`）。这解释了为什么翻转恰好发生在 128 边界附近。

## 3. 根因

### R1 网络库的 origin 路由永不收敛（`sourceDirect` 抑制了产物生成）

`isSourceDirectPreview` 在 worker 有 8 处调用（`library-service.ts` 16522 / 24304 / 24428 / 29334 / 29966 / **31748（layoutOnly 索引）** / 32852），**没有任何一处传入 `networkStorage`**。`src/shared/preview-policy.ts:50` 新增的 `networkStorage` 短路因此是死代码。

后果链：网络库仍被判定为 source-direct → `admitArtifactJob({sourceDirect:true})` 不排 `generate_thumbnail` → `previewArtifactId` 永远为 null → 封面路由永远落在第 3 条 origin → 每次重挂重新读 origin。本库 296 个卡片、201 MiB。

证据：新增的 worker 测试（`tests/worker/thumbnails.test.ts`「queues a thumbnail for a bounded image when the library is on network storage」）当前**失败**：

```
AssertionError: expected 'source' not to be 'source'   tests/worker/thumbnails.test.ts:795
```

### R2 增量几何供给（上一轮引入的回归）

虚拟分支用 128 行块渐进供给几何，几何在滑动中被修订约 12 次；`geometryRevision` 每次递增都会：触发 `useVirtualScrollAnchor` 锚点补偿、重算 `visibleWindow`、把不同 index 的槽位换入换出。约 15% 正落在第 2 个块边界。

上一轮日志的依据是「后台 `layoutOnly` 全量几何在网络盘上更慢」。实测否证（§1.2）：整索引 217 ms 冷，且分块必然更贵。

### R3 槽位身份在几何到达时翻转

1. `renderCard` 内部 `CardTag` 仍带 `key={assetCardKey(libraryId, assetId)}`（`src/renderer/App.tsx:12645`，函数定义在 12548，虚拟路径与普通路径共用）。占位槽的合成 `assetId` 是 `__geometry__:<index>`（`virtual-browse-layout.ts:215-219`），几何到达后换成真实 id → 内层节点 key 变化 → 媒体子树卸载重挂。
2. 组件类型也会翻转：占位走 `BrowseLayoutPreview`（`aria-hidden` 的轻量影子卡），就位后走 `CardTag` 真实卡片（`virtual-browse-canvas.tsx:990-992`）。React 视作不同组件 → 整棵子树重建。
3. 审查文档 `docs/internal/reviews/2026-09-13-virtual-browse-cover-identity-review.md` 第 22 行记「虚拟路径省略该 key / 几何身份到达即 `virtualSlotAsset` 合成 summary」为「已改」；核对工作区：`App.tsx`、`BrowseLayoutPreview.tsx`、`library-service.ts` **与 HEAD blob 逐字节相同**（545817 / 4556 / 1851662 B），改动并未落盘。

这一条是用户看到的「整张卡片闪没再出现」的直接原因：`BrowseLayoutPreview` 与 `AssetCardMedia` 之间的切换在视觉上就是卡片先消失、再重新出现。

### R4 背压：缩略图任务与滚动争抢同一条 SMB 链路，且任务在被反复取消

197 个 `generate_thumbnail` 待办 + 网络库批大小已降到 16（`library-service.ts:42685`）。在没有视口优先保证的前提下，滑到哪儿都可能被后台波次淹没。

**新增实测证据（任务抖动）**：两次度量旅程（共约 50 秒）前后对比同一库的 `jobs` 表：

| kind / status | 度量前 | 度量后 |
| --- | --- | --- |
| `generate_thumbnail` queued | 197 | **269（+72）** |
| `extract_palette` queued | 42 | **99（+57）** |
| `generate_thumbnail` succeeded | 19 | **19（+0）** |
| `extract_palette` succeeded | 280 | 281（+1） |

即：旅程**新增了 129 个待办任务，却几乎没有产出任何产物**。结合用户会话日志里 27 行有 19 行是 `worker.media-job.interrupted`（同一 `assetId` 反复出现），可以确认存在「渲染端反复请求 → 任务反复入队/取消」的抖动环。这条**不是**几何问题的副作用，而是独立缺陷，必须与 L1/L2 一并处理，否则改了几何仍会有任务抖动。


### R5 估高波动（本库不适用，但设计要一并处理）

`meanKnownPreviewAspect` / `unknownPreviewFromKnownGeometry` 用**不断增长**的 `geometryEntries` 计算未知行高度，每个几何块到达都会改变所有未知行的高度 → 又一次全画布几何变更。本库 100% 已知宽高，不会触发；缺尺寸的库会与 R2 叠加。整索引播种后该机制自然失去意义。

## 4. 设计目标与不变量

**目标**：约 1000 项量级的库（含网络盘）在滚动与回滚时——滚动条按 COUNT 稳定、已出现卡片不整张闪没、视口卡片不进入重复加载循环；且**不得比现状更差**（首帧、内存、滚动流畅度）。

**不变量**

| # | 不变量 |
| --- | --- |
| I1 | `layout.total` 从第一帧起等于 COUNT，且此后不变。 |
| I2 | 一个浏览会话的几何**只提交一次**；提交后不再修订（真实宽高修正只允许来自用户可见的元数据回填，且必须保持槽位身份）。 |
| I3 | 槽位身份只由 `index` 决定。`assetId`、组件类型、内层 key 都不得随几何/摘要到达而改变。 |
| I4 | 媒体 URL 只在槽位首次进入可见窗口时附上；附上后在本挂载周期内不因 `loadImmediately` 抖动而撤销。 |
| I5 | 网络库的封面必须**收敛到产物**：origin 可以作为首帧回退显示，但必须同时确保产物被生成并最终替换。 |
| I6 | 分块/估算等启发式不得在滑动过程中改变几何；`geometryRevision` 在索引提交后为常量。 |

## 5. 设计

### L1 几何供给：一次播种，取消分块（对应 I1/I2/I6）

- 虚拟会话改为消费 `fetchBrowseLayout`（既有 `layoutOnly`，一次返回整个 scope 索引，上限 50k），把它一次性转换并提交为 `VirtualBrowseLayout`：所有 index 一次性获得 `assetId / width / height / previewArtifactId / displayName / relativeFilePath / byteSize / modifiedAt / rating / mediaType`。
- `geometryRevision` 在本次提交中递增一次，此后为常量。
- 删除虚拟会话对 `ensureVirtualBrowseGeometryRange` / `BrowseGeometryBlockCache` / `mergeVirtualGeometryBlock` 的依赖（协议与 worker 能力可保留，作为超过 50k 上限时的降级路径，但不再是默认路径）。
- `unknownPreviewFromKnownGeometry` 只在索引确有缺失尺寸时作为一次性估计使用（提交时算一次），不再随时间漂移。
- 索引到达前：`total` 已知（COUNT），槽位按估算高度渲染**卡片外壳、不挂媒体**。因此索引到达时只是几何一次性就位，没有任何媒体需要拆除（配合 L2）。

风险与门槛：需在真机确认整索引在 NAS 上的端到端时延（§7 会给出实测）。若某库超过 `BROWSE_SCOPE_MAX_ASSETS`，回退到分块路径，但此时必须同时禁用槽位身份翻转（L2），使分块退化为「补几何」而不是「换身份」。

### L2 槽位身份：index-only，虚拟路径不再换组件（对应 I3）

- 虚拟路径统一渲染真实卡片组件；占位槽渲染同组件的**无媒体外壳**（几何/摘要缺失时显示骨架/图标，不显示 `BrowseLayoutPreview` 影子卡）。索引到达只是给同一个节点补几何与 `src`。
- 内层 `CardTag` 在虚拟路径下**省略 `assetCardKey`**（key 由外层 `virtualBrowseSlotKey(index)` 承担）；普通（非虚拟）路径保持原样，避免影响既有列表语义。
- 为让合成 summary 足以渲染真实卡片，`BrowseLayoutEntry` 增加 `mediaType`（worker 在 `layoutOnly` 分支已算出该值用于 source-direct 判定，几乎零成本）。

### L3 封面路由：产物优先 + origin 仅作首帧回退 + 必须并行生成产物（对应 I5）

**关键区分**（这是上一轮文档混淆的地方）：

- ❌ 错误理解：「网络库禁止显示 origin」。后果是首帧卡片长时间空白，**比现状更差**。
- ✅ 正确设计：「网络库的 `sourceDirect` **不得抑制缩略图生成**」。origin 仍可作为首帧回退显示（冷读中位 22.7 ms，可接受），产物就绪后在同一节点上换 `src`（同 key、同组件 → 不卸载），此后所有重挂走 userData 镜像。

落地面：

1. `library-service.ts` 8 处 `isSourceDirectPreview` 调用统一传入 `openLibrary.summary.networkStorage`；网络库上一律 `sourceDirect=false` 用于**入队判定**，从而恢复产物生成。
2. `previewKind: 'source'` 是否继续下发给 Renderer，按「首帧回退是否有价值」单独决定；若保留，则 `resolveAssetCardCoverUrl` 的 `networkStorage` 短路应移除（现状是「产物优先、origin 回退」，已正确）。**此条在实施前用 NAS 实测（§7）比较两个变体的首帧与重复挂载指标后定论，不凭直觉。**
3. 渲染端 `networkStorage` 必须真正接到 `AssetCardMedia` / `AssetPreviewModal` / 序列帧（当前 `App.tsx` 一处都没传，整条纵深防御是死代码）。

#### L3 的三个候选（待定，需用户决策）

| 候选 | 做法 | 优点 | 代价 |
| --- | --- | --- | --- |
| **L3-A 恢复产物生成**（上一轮原意） | 网络库不再 source-direct → 296 张卡生成缩略图 | 最终一致：封面变成小产物，镜像后长期最省 | 一次性 201 MiB SMB 读 + 生成突发；`.serpent/artifacts` 在 NAS 上增长；产物就绪前得靠 origin 兜底，否则空白 |
| **L3-B 把 origin 字节也纳入本机镜像**（新增，**推荐**） | 扩展 `PreviewCache` 覆盖有界的 `serpent://source`（同既有 `serpent://preview` 机制），带 Range/视频不缓存 | 不写 NAS、不生成产物、不动 worker 策略；重挂立刻变本机读（实测热读 1.1 ms）；改动最小、风险最低 | userData 增长（本库上限 201 MiB，受 2 GiB LRU 预算约束）；镜像被淘汰后首读仍需 origin |
| **L3-C 两者都做** | B 先落地（立刻止血），A 以低优先级后台补齐 | 首帧快 + 长期最省 | 复杂度最高；需先证明 A 的额外 SMB 开销值得 |

**倾向 L3-B**，理由：问题的可观测症状是「重复挂载重复读 origin」，而根因是 origin 路由**没有缓存**。把 origin 纳入既有镜像机制，直接消灭症状且不引入 NAS 写入与生成突发；A 是「换一条路由」，副作用更大、且仍要处理产物就绪前的空白期。若 L3-B 落地后实测首帧仍慢，再补 A。

> 注意：上一轮新增的 worker 测试 `tests/worker/thumbnails.test.ts`「network storage 必须排队缩略图」是按 L3-A 的前提写的，当前为**红灯**。若采纳 L3-B，该测试的前提与断言都要改写（改为断言有界 origin 读被镜像），而不是删掉它。


### L4 背压与优先级

- 网络库：视口可见的封面请求走既有 cover 档（400）压过可见波（350）与变更波（300）；后台缩略图波次对网络库限流，避免与滚动争抢。
- 索引播种后不再有几何请求，滚动期间 Worker 只服务摘要页与产物，竞争面收窄。

### L5 观测

- 复用既有诊断事件（`serpent:e2e-browse-request` / `-result` / `-page`，由 `SERPENT_E2E=1` 打开）。
- 度量必须包含：`scrollHeight` 序列、`serpent://source` 与 `serpent://preview` 请求计数（按 asset 去重）、槽位挂载/卸载计数、首帧时间、15% 停留期间的新请求数。

### L6 大规模库（10k+）的额外约束（用户 2026-09-13 追加要求）

**必须先复用既有 10k+ 基础设施，不要另起炉灶：**

| 能力 | 入口 |
| --- | --- |
| 生成确定性 20k 夹具（默认 `LARGE_LIBRARY_ASSET_COUNT = 20_000`，含 150+ 文件夹 / 50+ 合集 / 混合媒体） | `npm run large-library:generate -- --output <dir> [--assets N]` |
| Worker 侧 20k 计时（含 `layoutOnly`，当前门禁 < 5 s） | `npm run test:perf:large-library -- <dir>`（→ `tests/worker/large-library-performance.test.ts`） |
| 真 Electron 20k 滚动基准（10 次随机跳转、500 ms 首波门禁、long task、逐跳资源计时、占位卡计数） | `npm run test:e2e:large-library-benchmark -- <dir>`（→ `tests/e2e/large-library-scroll-benchmark.test.ts`） |

> 夹具默认输出目录 `tmp/` **未被 gitignore**，会污染工作区；本轮把它生成到仓库外的本地盘目录。

**L1 在 10k+ 上的四个风险（必须实测，不能假设）**

| 风险 | 说明 | 若超预算的处置 |
| --- | --- | --- |
| 索引查询成本 | 1442 行实测 217 ms 冷；20k 行约 14×。当前 `layoutOnly` 每行带 3 个相关子查询（`thumbnail` + `extracted_metadata` ×2）≈ 6 万次子查询执行 | 改为 LEFT JOIN 形状（纯查询改写，语义不变）；必要时分列输出 |
| IPC 载荷 | 20k 条 × ≈180 B ≈ **3.6 MB** JSON，两端 Zod 校验 + structured clone | 列式数组传输；或只播种「身份 + 几何」，`displayName/relativeFilePath` 留给摘要页 |
| Renderer 布局构建 | `VirtualBrowseLayout` 持有 4 个 Map（`entries` / `geometryEntries` / `assetIdsByIndex` / `indexByAssetId`）≈ 8 万条目 | 可接受；但见下一条 |
| **每次 patch 的 O(n) 重物化** | `materializeVirtualLoadedEntries()` 有 **5 个调用点**（`use-virtual-browse-session.ts:212/254/315/349/365`），每次都产出全量数组并 `setBrowseLayout(...)`。20k 下每个摘要页 patch 都要重建 2 万条数组 + 触发 React 状态更新 | 虚拟路径不再向后发布物化数组（App 在 `virtualBrowseLayout` 存在时本来就不使用 `browseLayout`，见 `App.tsx:4653`），或只发布有界前缀 |

**决定性结论：让 10k+ 安全的是 L2，不是 L1。**

L1 只在 scope ≤ `BROWSE_SCOPE_MAX_ASSETS`（50k）时能拿到完整索引；超过上限 worker 会截断，身份就无法覆盖全部索引，渐进几何必然回归。因此：

- **L2（槽位身份只由 index 决定、虚拟路径不换组件/key、身份未知时不挂媒体）是无论库多大的承重不变量。** 有了它，>50k 的降级路径最多是「几何渐进到达」，而**不可能**出现身份翻转与媒体拆除。
- L1 是 ≤50k 的优化：把 12 次渐进修订压成 1 次提交。

**10k+ 还要一并改的测试语义（不是删测试）**

`tests/e2e/large-library-scroll-benchmark.test.ts` 的门禁按当前架构写成：

- `layoutReady` 要求 `placeholders === 0` 且每个可见 `[data-layout-asset-id]` 都被 `.asset-card:not(.is-layout-preview)` 覆盖（441-543 行）；
- 注释明确写着「layout previews … intentional before the summary page arrives」（204-207 行）。

L2 之后虚拟路径不再产生 `is-layout-preview` / `is-browse-placeholder` 影子卡，这些断言的前提消失。**必须在同一次变更里把断言改写成新不变量**（例：首帧起每个可见槽位就是真实卡片、且媒体元素数量与可见槽位数一致、无整批卸载），并在开发日志记录「旧行为 → 新行为」，不得为了绿灯删断言。

**10k+ 度量与判据**

- 度量前：`test:perf:large-library` → 记 `layoutMs`（门禁 < 5 s）；`test:e2e:large-library-benchmark` → 记 `passed` / `p50Ms` / `p95Ms` / `firstVisualWaveP50Ms` / `longTaskMaxMs`；结果用 `SERPENT_LARGE_LIBRARY_E2E_RESULT_PATH` 落盘。
- 度量后：同夹具、同 `SERPENT_LARGE_LIBRARY_E2E_REUSE_LIBRARY`（避免重复克隆、保持同一热状态）重跑对比。
- 判据：`layoutMs` 不得越过 5 s 门禁且不得比基线更差；首波 p50 目标 ≤ 500 ms；`longTaskMaxMs` 不劣化；`passed` 不减少。

## 6. 取舍与被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| A. 网络库完全禁用 origin 显示 | 首帧卡片空白期变长，单看「卡片可见」比现状更差；且解决不了「产物从未生成」的根因。 |
| B. 保留 128 行分块，只让占位携带真实 `assetId` | 占位携带真实 id 就必须先知道全部 id，等于要求整索引；分块的渐进性没有换来任何东西。 |
| C. 小库取消虚拟化、全量 DOM | 1442–2000 张卡片常驻 DOM + 媒体节点，内存与解码代价高；且不能推广到 50k。 |
| D. 只在渲染层加 `keepAttached` 粘性 | 只能减轻 `loadImmediately` 抖动，挡不住 key/组件翻转导致的卸载（R3）。 |

## 7. 度量方案（NAS 真机）

**目标**：为「是否更差」提供可复现判据，而不是感觉。

- 载体：真 Electron + Playwright，`SERPENT_E2E=1`、隔离 `SERPENT_E2E_USER_DATA_PATH`、`SERPENT_E2E_OPEN_LIBRARY_PATH` 指向 NAS 库；脚本对同一库执行固定旅程：打开 → 等首帧 → 缓慢滚到 15% → 停留 → 回顶 → 再来一次。
- 采集：Playwright `page.on('request')` 统计 `serpent://` 请求（区分 preview/source，按 asset 去重、计重复）；页面内 `MutationObserver` 统计 `[data-layout-index]` 挂载/卸载与 `.asset-thumbnail` 的 `src` 变更；定时采样 `scrollHeight`、`.asset-card` 数量。
- 对照：同一脚本跑「HEAD（上一轮之前）」/「当前工作区（回归态）」/「设计实施后」三个状态。
- 通过判据（相对回归态，全部需同时成立）：
  1. 15% 停留期间的重复媒体请求数显著下降（目标：同一 asset 不再重复请求）；
  2. 槽位卸载/重挂计数在 15% 停留期间≈0；
  3. `scrollHeight` 采样在首帧后不再随加载变化（允许索引提交时的一次性变化）；
  4. 首帧时间不劣化（这是「避免更差」的核心护栏）；
  5. 滚动期间无 `worker.media-job.interrupted` 激增。

**待用户确认的前置副作用**：打开该库会让 Serpent 处理其待办缩略图任务并写入 `.serpent/artifacts` 与 `library.db`。会改变库状态并影响后续对照的可比性。用户已同意直接对真实库执行（2026-09-13）。

已发生的实际副作用（两次基线旅程，用户已同意）：

- `generate_thumbnail` queued 197 → 269；`extract_palette` queued 42 → 99（净增 129 个待办任务，见 R4）。
- 产物产出几乎为零（`generate_thumbnail` succeeded 19 → 19）。
- ready 缩略图 1104 不变、source-direct 无缩略图 296 不变 → **基线人群结构稳定，前后对照仍可比**。
- 无删除、无数据丢失；新增的只是队列行与 1 个 palette 产物。

**已冻结的基线数值（实施后须逐项对比，任一项变差即视为回归）**

| 指标 | 运行 1 | 运行 2 |
| --- | --- | --- |
| 首张卡片 | 2063 ms | 3667 ms |
| 槽位真实创建 / 卸载 | 1015 / 1009 | 935 / 929 |
| 媒体 `src` 写入 / 不同 URL / 冗余 | 290 / 40 / 250 | 318 / 56 / 262 |
| `scrollHeight` 波动 | 61205–69021（±13%） | 63009–69021（8.7%） |
| Main 侧唯一 origin 请求 | 12 | 44 |
| 预览镜像 hit / miss / store | （计数器有缺陷） | **54 / 34 / 34** |
| `media-job.interrupted` | 0 | 0 |

> 预览镜像 hit=54 是关键前提验证：**同机制已经能把重复挂载变成本机读**。这正是 L3-B 可行的依据。

## 8. 影响面与风险

- 触及 worker 产物准入（`isSourceDirectPreview` 全部调用点）→ 必须完整跑 `npm run test:library-availability`。
- 触及 `BrowseLayoutEntry` 协议（新增 `mediaType`）→ Zod 双向校验与旧库兼容（迁移只加不改）。
- 触及浏览分页与虚拟画布渲染主路径 → 需要真实 Electron E2E，不能只靠单测。
- 网络库产物生成的额外 SMB 读：一次性 201 MiB（本库），换取此后所有重挂走本机镜像；限流与视口优先必须同批落地，否则可能短期变差。

## 9. 验收映射（CANVAS-038）

| 需求条目 | 实现位置 | 自动化测试 | 人工/平台证据 |
| --- | --- | --- | --- |
| 滚动条按 COUNT 稳定 | 待实施（L1） | 待补 | NAS 真机旅程待执行 |
| 卡片不整张闪没 | 待实施（L2） | 待补 | NAS 真机旅程待执行 |
| 视口卡片不重复加载 | 待实施（L1+L3） | `tests/worker/thumbnails.test.ts`（已红） | NAS 真机旅程待执行 |

> 说明：本文为设计，尚未实施，故上表按「待实施/未验证」填写，不得写成通过。
