# 2026-09-13 中等规模浏览：滚动条与卡片闪烁

## 现象

约一千项资产的资源库（含网络盘上的库）在滚动画布时：

- 滚动条拇指忽长忽短
- 已出现的资产卡片会整张消失再出现

## 根因

BrowseSession 首屏仍是 100 条 summary。`useVirtualBrowseSession.begin` 原先只在 `total > 2000` 时启用 `VirtualBrowseLayout`。

101–2000 项走 RegularMasonry：

1. 首帧 `browseLayout` 为空，画布回退到已加载 summary，滚动条按 100（随后 200、300…）项高度计算
2. 后台 `layoutOnly` 全量几何在网络盘上更慢；到达后一次换成全部 COUNT 并重新分列
3. 视口窗口化按新高度切片，原先挂载的卡片被卸掉，看起来像闪烁

这与 PERF-002 / `Serpent-87pd` 描述的「滚动条停在已加载的 100 张」同类，但当时虚拟化门槛把一千项规模排除在外。

## 修改

`shouldUseVirtualBrowseLayout`：只要有 `sessionId` 且首屏条数小于 COUNT，就使用既有虚拟几何（`VirtualBrowseLayout.total` 从第一帧起就是全范围）。不再为中等规模等待 `layoutOnly` 再撑开滚动条。

一页能盖住的小范围仍走原来的完整 layout 数组。

## 未纳入本轮

- 源文件直出预览（`previewKind: source`）在网络盘上读原图的延迟与缺文件
- NAS 本地目录快照（PERF2-NAS，仍为规划）

## 测试

`tests/unit/virtual-browse-session.test.ts` 覆盖 1000/100 启用虚拟几何、整页盖住 COUNT 时不启用。
