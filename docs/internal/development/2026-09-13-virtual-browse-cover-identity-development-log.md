# 2026-09-13 虚拟浏览封面身份与网络盘产物

## 元数据

- 规格：`docs/internal/qa/human-acceptance-checklist.md` CANVAS-038
- 分支：`codex/performance-20260913`
- 基线 SHA：`570b3cfafa23f379d136c1a26801dd37a2a302d1`
- 当前提交：工作区未提交
- 开始：2026-09-13
- 状态：实现完成，待人类验收
- 最后更新：2026-09-13

## 现象

中等规模库改为虚拟几何后，滑到约 15% 时视口内卡片整批重新加载。网络盘上同一批 `assetId` 反复打 `serpent://source`。

## 根因

三层叠在一起，不是「少加载了几页」：

1. 虚拟槽 React key 是 `` `${assetId}-${index}` ``。几何块到达时 `__geometry__:N` 换成真实 id，整窗卸载重挂。
2. `deferUntilVisible` 只在 `loadImmediately` 为真时挂封面 URL。几何修订会让相交判定抖动，已解码封面掉成图标再重新请求。
3. 小图 `previewKind: source` 跳过缩略图，封面走原文件。Main 的 PreviewCache 只管 `serpent://preview`。网络盘上每次重挂都重新打开远端原图。约 15% 对应几何块 128 边界（首屏 100 条之后）。
4. 内层 `CardTag` 仍用 `assetCardKey(libraryId, assetId)`；占位 `BrowseLayoutPreview` 换成真实卡片时组件类型与内层 key 再卸一次媒体子树。
5. `resolveSequenceFrameUrl` / `resolveInspectorPreviewSrc` 仍把 `previewKind: source` 变成 `serpent://source`，即使 Worker 已不再对网络库发出该 kind。

目录 SQLite 本地快照（D.7）不覆盖这条路径。

## 不变量

- 窗口化网格封面、序列帧封面、Inspector 预览在网络卷上必须是有界产物（或本机 PreviewCache 字节），不能是 origin。
- 仍在 overscan 内的同一 session index：槽位节点不因 asset id / 几何修订而卸载。
- 封面一旦在本轮挂载中附上，在该节点卸载前不得因 `loadImmediately` 抖动而拆掉 `src`。
- 查看器双击 `requestPreview` 仍可走 origin。

## 修改

- `isSourceDirectPreview({ networkStorage: true })` 恒为 false。Worker 入队、claim、layout/summary、序列帧都走该开关；网络库不再把 queued thumbnail 标成 `SOURCE_DIRECT` 取消。
- Renderer `resolveAssetCardCoverUrl` / `BrowseLayoutPreview` / `resolveSequenceFrameUrl` / `resolveInspectorPreviewSrc` 对网络库忽略 `previewKind: source`。
- `virtualBrowseSlotKey(index)` 作为槽位 key。虚拟路径去掉 `CardTag` 上的 `assetCardKey`。
- `assetSummaryFromLayoutEntry` 在几何身份到达后即可合成卡片 summary，避免占位预览与真实卡片换组件。
- `shouldAttachVirtualCardMedia`：overscan 仍不预取；一旦附上则粘在当前挂载周期。
- 未知行高度用已加载真实宽高的均值估计（至少 8 个样本），减少几何块到达时的拇指跳动。

## 测试接缝

- `tests/unit/preview-policy.test.ts`
- `tests/unit/asset-card-hover-preview.test.ts`
- `tests/unit/viewport-window.test.ts`
- `tests/unit/virtual-browse-canvas.test.ts`（含均值估高）
- `tests/unit/virtual-browse-session.test.ts`
- `tests/unit/sequence-frame-preview.test.ts`
- `tests/unit/inspector-preview.test.ts`
- `tests/unit/browse-window-slots.test.ts`
- `tests/worker/thumbnails.test.ts`：`storageKindOverrideForTests: 'network'` 时小图入队 thumbnail、不标 `previewKind: source`
- `tests/e2e/asset-pagination.test.ts`：虚拟槽出现后滑到约 15%，`scrollHeight` 相对已稳定高度不得塌缩或随分页暴涨

当次命令见本文件「命令与结果」。Computer Use、真实 SMB 滑动、packaged 未执行。

## 重要决定

网络库全局关掉 `previewKind: source`，因此 Inspector 在产物就绪前也不走 origin。网格反复打开 NAS 原图是本次故障；Inspector 与网格共用同一 admission。查看器双击仍走 `requestPreview`。

不把滚动条像素总高冻死。COUNT 稳定是产品合同；真实宽高到达后的轻微拇指修正保留。

## 偏离

相对「拇指永不变化」的字面读法：允许真实宽高到达后的轻微修正。清单 CANVAS-038 预期已对齐。

## 未纳入

PERF2-NAS 独立只读执行器仍为规划。

## 文件入口

- `src/shared/preview-policy.ts`
- `src/renderer/sequence-frame-preview.ts`
- `src/renderer/inspector-preview.ts`
- `src/renderer/browse/virtual-browse-canvas.tsx`
- `src/renderer/browse-window-slots.ts`
- `src/renderer/viewport-window.ts`
- `src/renderer/App.tsx`（虚拟路径省略内层 assetId key；`networkStorage` 传入卡片/查看器）
- `src/worker/library-service.ts`

## 命令与结果

见审查后续记录；本轮定向单测在落地后重跑。
