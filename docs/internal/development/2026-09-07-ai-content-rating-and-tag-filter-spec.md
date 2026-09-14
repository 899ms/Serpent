# Serpent-450a22 实施规格：AI 内容（评分/标签）纳入筛选与排序 + 「包含 AI」过滤开关

> 状态：**实现完成，待人类验收**（本文件同时保留决策、实现锚点与验收证据，关联工单
> `Serpent-450a22`）。
> 日期：2026-09-07。 范围：评分(rating)、标签(tags) 两个发现维度的**过滤**语义 + 按评分**排序**语义。

---

## 0. 快速结论（实现者先读）

| 项 | 结论 |
|---|---|
| P0 bug | 顶部评分筛选只查人工 `asset_metadata.rating`，AI 评分存 `ai_content`，只被 AI 评过分且无人评分的资产筛不出来 |
| 修复语义 | **默认**把 AI 层与人工层“一起”计入评分过滤/排序；另提供「包含 AI 内容」开关，**只对过滤有效**，默认开 |
| 涉及维度 | 星级(rating) + 标签(tags) 两个维度的**过滤**；按评分**排序**默认含 AI |
| 实现点 | Worker `buildFilterWhere` 的 `case 'rating'`/`case 'tag'` + rating 排序分支；共享 `FilterClause` 加可选 `includeAi`；Renderer 状态/浮层开关 |
| 智能合集 | 复用同一 `buildFilterWhere`，**自动跟随，无需单独改**（验证即可） |
| 预置先例 | 标签过滤**已经** UNION 人工+AI 标签（`library-service.ts:29604-29635`，注释 Serpent-5cvr）→ 语义一致标杆 |

---

## 1. 背景与根因（Serpent-450a22）

- 顶部筛选栏 `DimensionFilterBar` 把过滤条件编码为 `FilterClause[]`，Worker 端
  `src/worker/library-service.ts` 的 `buildFilterWhere(filters)` 把它拼成 SQL WHERE。
- **评分存储分两层**：
  - 人工评分：`asset_metadata.rating`（INTEGER，0 表示未评）— `m.rating`。
  - AI 美学评分：`ai_content` 表 `field_name='rating'`，`value` 为 TEXT 整数串（如 `'5'`）— 写入路径
    `library-service.ts:18673-18723`（事务内 DELETE 旧行 + INSERT，正常单写者下每资产 ≤1 行；
    表索引 `ai_content_asset_field(asset_id, field_name)` 存在，见 `1722`）。
  - Inspector 展示语义（`InspectorPanel.tsx:1301-1338`）：**有人工分用人工分，否则用 AI 分并带 AI 角标**。
- **评分筛选 bug 本体**（`library-service.ts:29637-29646`）：
  ```ts
  case 'rating': {
    const clause = filter.exclude
      ? `COALESCE(m.rating, 0) NOT IN (${phs})`
      : `COALESCE(m.rating, 0) IN (${phs})`;
  ```
  只认 `m.rating` → 仅 AI 评分（人工=0）的资产在 `m.rating` 是 0，永远筛不出。**这就是用户看到的 P0。**

---

## 2. 产品意图与语义决定

用户口径（2026-09-07 口头确认）：
> 「所有筛选、排序都默认把 AI 和人类一起进行过滤、排序；但提供一个选项用来『排除/只看 AI 内容』，
> 该选项**只对过滤有效**。例如我筛 4★ 资产，默认要能筛到 AI 打的 4★；可关掉后只留人工 4★。」
> 「影响星级、标签的『过滤』」。

### 2.1 评分过滤：effective rating（默认包含 AI）【D-1，推荐；见 §8 待确认】
- 定义每资产的 **有效评分** = `人工>0 ? 人工 : (AI ?? 0)`（即 `COALESCE(NULLIF(m.rating,0), ai, 0)`）。
  - 与 Inspector 星标完全一致（有把握不引入“显示 5★ 却被 3★ 筛中”的反直觉）。
  - 对人工已评分的资产**行为不变**，只修正“仅 AI 评分”这类资产 —— 最小变更达成修复。
- 「包含 AI」开关 **开（默认）**：过滤按上述有效评分命中。
- 「包含 AI」开关 **关**：过滤只按人工评分（`COALESCE(m.rating,0)`）命中 —— 即**现在线上行为**，
  人工=0 且只有 AI 的资产会落入“未评分(0)”。
- `未评分(0)`：开=人工 0 且无 AI；关=人工 0（忽略 AI）。

行为矩阵（H=人工，A=AI，∅=无）：

| H | A | 筛 N(开) | 筛 N(关) | 筛 未评分0(开) | 筛 0(关) |
|---|---|---|---|---|---|
| 0 | ∅ | — | — | ✓ | ✓ |
| 3 | ∅ | 3✓ | 3✓ | — | — |
| 0 | 3 | 3✓ | 0✓（退回未评分） | — | ✓ |
| 3 | 5 | 3✓（人工优先） | 3✓ | — | — |
| 5 | 3 | 5✓（**不**命中 3） | 5✓ | — | — |
| 0 | 0(不存在,AI∈1..5) | — | — | — | — |

排除(排除/`excludeRatingFilter`)语义：对上述命中集合取 `NOT`（开/关各自基于其命中集）。

### 2.2 标签过滤
- 现状：`case 'tag'`（`29604-29635`）**已** UNION `human_asset_tags` + `ai_asset_tags`。
- 「包含 AI」开关 **开（默认）**：保持现有 UNION（行为不变）。
- 「包含 AI」开关 **关**：只用 `human_asset_tags`。
- 标签的排除逻辑沿用现有分支，仅把子查询从 UNION 换成单人工源。

### 2.3 按评分排序（默认含 AI，不受开关影响）【D-2；见 §8】
- `library-service.ts:30117-30121` 现为 `COALESCE(m.rating, 0)`。
- 改为按**有效评分**排序：`COALESCE(NULLIF(m.rating,0), <ai评分>, 0)`。
  → “仅 AI 评分”的资产不再统一垫底。
- 用户明确：排除-AI 开关“只对过滤有效” → **排序不做开关**，始终含 AI 兜底。

---

## 3. 现状代码锚点（file:line）

| 位置 | 说明 |
|---|---|
| `src/shared/asset-types.ts:403-415` | `categoricalFilterClauseSchema`（field ∈ format/tag/rating/favorite/source_url/availability/color；`strictObject`） |
| `src/worker/library-service.ts:29527-` | `buildFilterWhere(filters)`；`case 'tag'` ~29604；`case 'rating'` ~29637；别名 `a`(assets)/`m`(asset_metadata) 在全部调用者 FROM 中可用 |
| `src/worker/library-service.ts:29637-29646` | 评分过滤（主 bug） |
| `src/worker/library-service.ts:29604-29635` | 标签过滤（人工+AI UNION，先例） |
| `src/worker/library-service.ts:30117-30121` | 按评分排序（同源） |
| `src/worker/library-service.ts:18673-18723` | AI 内容写入（rating → ai_content，DELETE+INSERT） |
| `src/worker/library-service.ts:1722` | 索引 `ai_content_asset_field(asset_id, field_name)` |
| `src/renderer/App.tsx:1040` | `ratingFilter` 等发现状态 useState |
| `src/renderer/App.tsx:5751-5831` | 发现过滤 → `FilterClause[]` 构建（rating ~5826、tag 的 tag 分支） |
| `src/renderer/DimensionFilterBar.tsx` | 顶部筛选栏；rating 浮层 ~811-856；tags 浮层 ~712-750（各含 `dimension-filter-check` 排除勾选） |
| `src/renderer/active-discovery-filters.ts:13-33` | `DiscoveryFilterSnapshot` 类型 + 活动 chips |
| `src/renderer/InspectorPanel.tsx:1301-1338` | 有效评分展示（语义基准） |

---

## 4. 改动方案

### 4.1 共享 schema（可选字段，向后兼容）
`asset-types.ts` `categoricalFilterClauseSchema` 增加：
```ts
includeAi?: boolean; // undefined ⇒ true（默认包含 AI 内容）
```
- 旧调用方/MCP/插件不传 ⇒ `undefined ⇒ true`，行为不变。
- 仅 tag/rating 消费该字段；format/color/favorite/source_url/availability 无视它。
- 不向 Worker 回写对象；避免破坏按输入对象深比较的既有测试。

### 4.2 Worker — 评分过滤（核心修复）
`case 'rating'` 改为按开关选择表达式后 IN/NOT IN：
```ts
const aiRating = (/* 每资产 ≤1 行；ORDER BY rowid 兜底异常多行取最新 */
  `(SELECT CAST(value AS INTEGER) FROM ai_content`
  + ` WHERE asset_id = a.asset_id AND field_name = 'rating'`
  + ` ORDER BY rowid DESC LIMIT 1)`);
const effective = `COALESCE(NULLIF(m.rating, 0), ${aiRating}, 0)`; // includeAi(默认)
const human     = `COALESCE(m.rating, 0)`;                          // includeAi=false
const col = filter.includeAi === false ? human : effective;
clause = filter.exclude ? `${col} NOT IN (${phs})` : `${col} IN (${phs})`;
```
参数仍 push `Number(v)`。值集含 `0` 与 `5..1`，语义见 §2.1 矩阵。

> 性能：相关子查询复用 `(asset_id, field_name)` 索引，每行一两次点查；同函数 `case 'tag'`
> 已用引用 `a.asset_id` 的子查询（UNION），有先例。实现后必须跑 `search/rating` 定向 + 大库
> 性能测试；若 20k/100k 回归明显，改用 LEFT JOIN（见 §6 备注，会侵入多个查询 FROM，非首选）。

### 4.3 Worker — 标签过滤（加开关）
`case 'tag'` 的 `taggedAssetsSubquery` 增加 `includeAi` 分支：`false` 时只保留
`human_asset_tags` 子查询，去掉 UNION `ai_asset_tags` 段；`true/undefined` 维持现状。

### 4.4 Worker — 评分排序
`case 'rating'` 排序（`30117`）：
```ts
orderBy = `COALESCE(NULLIF(m.rating,0), ${aiRating}, 0) ${dir}, a.asset_id ASC`;
```
（`aiRating` 表达式与 4.2 同；排序**无**开关，始终含 AI 兜底。）

### 4.5 Renderer — 状态/快照/浮层
1. `App.tsx` 新增两个发现状态：`includeAiRatingFilter`、`includeAiTagFilter`（默认 `true`），
   与既有发现过滤状态并列（走既有防抖 `runSearch` 依赖列表与 `clearDiscoveryFiltersOnly`；
   开关本身不触发清空其它过滤，改状态即触发重新搜索）。
2. `DiscoveryFilterSnapshot`（`active-discovery-filters.ts:13`）补两个 `includeAi*` 布尔；
   相应更新构建处（`App.tsx ~5752` filtersState、DimensionFilterBar 快照 props）。
3. `DimensionFilterBar.tsx`：
   - rating 浮层加 `dimension-filter-check` 复选框「包含 AI 评分」（默认勾选），开关状态经 props 传入；
   - tags 浮层加「包含 AI 标签」复选框（同上）。
   - 复用既有 `dimension-filter-check` 样式，**禁止自造新样式/token**（CLAUDE.md 标准化 UI 纪律）。
4. `App.tsx` 把 `FilterClause` 的 tag/rating 两条分别带 `includeAi: includeAiTagFilter` /
   `includeAi: includeAiRatingFilter`。
5. AI 开关采用紧凑的 `AI` 辅助标识（通过 `filter.ai` i18n key），与参考 UI 保持一致；
   排除开关继续使用现有 `filter.exclude` 文案，避免在面板中重复解释筛选语义。
6. `plugin-context-state.ts`（`DiscoveryFilterSnapshot` 消费方）类型随快照扩展；描述文本可选择性附带
   `含AI/仅人工` 标记（低优先，可不做——保持最小，若做需更新其测试）。
7. 活动 chips（`buildActiveFilterChips`）：开关不是“激活的过滤”，默认不加 chip。若实现侧希望
   关掉时有可见提示，可在 rating/tag chip detail 追加「仅人工」——**建议不做**，开关自身已可见。

### 4.6 智能合集
复用 worker `buildFilterWhere` ⇒ 评分/标签过滤语义与开关自动跟随；无需单独改动，验证存量的
“rating=4 的智能合集”展开即可。

---

## 5. 待确认决策点汇总（实现前请 PM/负责人拍板，默认取左侧）

1. **双评分并存时评分过滤的命中口径**【默认 D-1 人工优先/有效分；备选：并集(任一命中)]
   - D-1：`(H3,A5)` 只算 3★，筛 5★ 不命中（与 Inspector 一致）。
   - 备选并集：`(H3,A5)` 同时算 3★ 与 5★（字面“一起”，但可能“显示 3★ 却被 5★ 筛中”）。
2. **双评分并存时排序标量**【默认 D-2 人工优先有效分；备选：MAX(H,A)]
   - D-2：人工已评即人工（`H1,A5` → 按 1 排）。
   - 备选 MAX：`H1,A5` → 按 5 排（AI 高分把人工低分顶上去）。
3. **开关的粒度/持久化**【默认：评分/标签各一开关，跟随现有发现过滤状态、不跨会话持久化
   ——与既有 ratingFilter/tagFilter 的持久化策略一致即可；实现者先核对它们是否持久化，若持久化则一并持久化。】

---

## 6. 备注与边界（实现者留意）
- `ai_content` 无 `UNIQUE(asset_id, field_name)`：正常写路径 DELETE+INSERT 保证 ≤1 行；多写者不硬保证。
  本次**不改 schema**（只读查询加 `ORDER BY rowid DESC LIMIT 1` 兜底）。可在后续建议补唯一约束，不阻塞本单。
- 若实现后性能测试见相关子查询回归：把 effective 拆成 JOIN `(SELECT asset_id,
  CAST(value AS INTEGER) v FROM ai_content WHERE field_name='rating')` 派生表 —— 但这需在各查询 FROM 加 JOIN，
  侵入面大，仅当性能不达标再走，并单独记开发日志。
- 范围外（另开跟进，不入本单）：
  - 卡片/布局条目 `AssetSummary`/`layout_rating` 仍只喂 `m.rating`（Explore 确认网格卡片并不画星，
    仅 Inspector 首帧摘要/窗口槽位用；Inspector 已做有效分）——显示侧与“有效分”不完全一致，低优先跟进。
  - description 搜索（AI 描述已并入 FTS）、palette（人工色卡已被产品移除）等其它维度经排查**无同类问题**。

---

## 7. 测试计划（实现者必跑）
- Worker：`tests/worker/search.test.ts` 扩展/新增 ——
  rating：仅 AI 评分命中星级；开关关后 AI 资产落入未评分；H/A 并存人工优先；exclude 反转；未评分口径开/关。
  tag：开关关后 AI 标签不命中；开=现 UNION 不变；H/A 并存回归。
  覆盖智能合集复用路径（rating/tag 过滤解析）。
- 单元：`tests/unit/dimension-filter-bar.test.tsx`（新复选框默认勾选/切换回调/快照）；
  `tests/unit/active-discovery-filters.test.ts`（快照类型扩展）；App 层 clause 构建 includeAi 透传。
- 库可用性底线：`npm run test:library-availability`（改动触及资源库查询 SQL，**必跑**）。
- 质量门：`npm run typecheck`、`npm run lint`、`git diff --check`。
- E2E（可选/后补）：置一批 AI 评分资产 → 星级筛选命中 → 关开关后不再命中；标签同场景。
- 验收映射补进 `docs/internal/qa/human-acceptance-checklist.md`（`Serpent-450a22` 下）。

---

## 8. 验收（对齐工单 Serpent-450a22，范围含标签）
1. 对一批资产生成 AI 评分（无人评分）→ 顶部星级筛选选对应星级**默认能筛出**（P0 主体验）。
2. 关闭「包含 AI 评分」→ 仅人工 4★ 命中，AI-only 4★ 回到未评分。
3. 星级排序：仅 AI 评分资产不再垫底（人工优先兜底，见 §5-2 拍板项）。
4. 标签：默认含 AI 标签；关闭「包含 AI 标签」→ 只人工标签命中。
5. 智能合集 rating/tag 过滤跟随新语义。
6. 自动化回归 + 大库性能测试无显著回归。

## 9. 实现记录（2026-09-07）

- `FilterClause` 的分类筛选支持可选 `includeAi`；未传入时保持默认包含 AI。
- Worker 对评分使用“人工评分优先、否则 AI 评分”的有效评分表达式；标签在开关开启时合并人工与 AI 标签，关闭时仅查询人工标签。
- 评分排序始终使用有效评分，不受筛选开关影响；缺少 AI 表的旧资源库退回人工字段。
- 评分与标签浮层均复用现有 checkbox 样式，在同一行显示排除和 AI 开关，AI 默认开启；清除发现筛选时恢复默认开启状态。
- 自动化证据：`node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/worker/search.test.ts --reporter=dot`（90/90）；`npx vitest run tests/unit/active-discovery-filters.test.ts tests/unit/dimension-filter-bar.test.tsx --reporter=dot`（6/6）；`npm run test:library-availability`（209 passed / 1 skipped）；`npm run typecheck` 与改动文件 ESLint 通过。
- 真实界面、Windows 与 packaged 尚未执行，保留给人类验收。
