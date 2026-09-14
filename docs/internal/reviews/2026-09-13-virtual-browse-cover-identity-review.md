# 2026-09-13 虚拟浏览封面身份 — Luna 双轴审查后续

固定点：工作区相对 `570b3cfafa23f379d136c1a26801dd37a2a302d1`。
模型：Luna High（`gpt-5.6-luna-xhigh`）。一次审查覆盖 Standards 与 Spec。

## Standards 已改

| 项 | 处置 |
| --- | --- |
| 开发日志缺规格路径/分支/SHA/测试接缝 | 两份 development log 已补必填字段。（当时 `docs/internal/` 对未跟踪文件 ignore、提交须 `git add -f`；2026-09-14 起该 ignore 规则已移除，dev 上内部文档正常跟踪。） |
| CANVAS-038 四列缺 file:line / test:line | 清单证据列已补。 |
| 缺少真实 Electron E2E | `tests/e2e/asset-pagination.test.ts` 增加 173 项范围、虚拟槽出现后滑到约 15% 的 `scrollHeight` 稳定断言。图片 NAS 原文件重挂仍无网络盘 fixture；记未执行。 |

判断项未改：`sourceDirectPreviewForLibrary` Middle Man、`networkStorage` 布尔跨层传递。不为重构而拆。

## Spec 已改

| 项 | 处置 |
| --- | --- |
| `resolveSequenceFrameUrl` 无网络纵深防御 | 第三参 `networkStorage`；卡片、序列画布、序列查看器传入。产物优先，网络卷禁止 source。 |
| Inspector 失去 origin 回退范围不清 | `resolveInspectorPreviewSrc` 在 `networkStorage` 时不走 source；产物仍可用。规格写明：网络库 Inspector 等 thumbnail。查看器双击仍 `requestPreview`。 |
| 内层 `assetCardKey` 仍按 assetId | 虚拟路径省略该 key。几何身份到达即 `virtualSlotAsset` 合成 summary，避免 `BrowseLayoutPreview` → `CardTag` 换组件。 |
| 滚动条像素总高仍随几何块变化 | COUNT 从第一帧固定范围。未知行用已知宽高均值（≥8 样本）估高；真实宽高到达后仍修正。清单预期改为「不随已加载页数伸缩，允许真实宽高轻微修正」。 |

## 未执行

Computer Use、真实 SMB 滑动、packaged、全量 `test:e2e`。
