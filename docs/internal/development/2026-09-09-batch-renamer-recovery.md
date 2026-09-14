# 批量重命名拒收后的修复记录

## 范围与证据边界

- 工单：`Serpent-0da7b7`，关联 `Serpent-e6db30`、`Serpent-275e58`。
- 从失败交接继续，保留会话开始时已有的暂存和未暂存修改。
- 用户要求控制模型成本：主 agent 负责判断与核查，Luna high 分别处理插件、Host 控件和菜单/卸载确认。
- 用户本轮明确选择“暂时不要，先完成代码和后台检查”，因此不启动会抢占前台的 Electron，不进行真实焦点或视觉验收。
- 既有 `run-e2e-isolated.mjs` 仍调用正常 `show()`，不构成不抢占焦点的保证；不得以隔离脚本名代替实际隔离证据。
- 工单保持未验收；本轮后台证据不能推翻此前用户拒收。

## 修复与验证

代码已更新，真实 Electron 焦点和用户视觉验收仍未执行。

| 需求条目 | 实现位置 | 自动化测试 | 人工/平台证据 |
| --- | --- | --- | --- |
| Aa/正则互斥与连续输入 | `src/renderer/plugin-widget-renderer.tsx:317`；插件 `src/dialog-ui.js:24` | `tests/unit/plugin-widget-renderer.test.tsx:46`、`:86`、`:137`、`:187`；插件 `tests/dialog-ui.test.js` | 后台 DOM 测试通过；真实 Electron 未执行 |
| 编号方向/位置提交一致 | 插件 `src/dialog-ui.js:24`、`src/plugin.js:107` | 插件 `tests/plugin.test.js:110` | 插件自动化通过；真实重命名旅程未执行 |
| 精简自动编号与底部预览 | 插件 `src/dialog-ui.js:135`、`:196`；Host `plugin-widget` 样式 | 插件 `tests/dialog-ui.test.js` | 用户已拒收旧 UI；新 UI 待复验 |
| 卸载前确认、目标作用域固定 | `src/renderer/PluginSettingsPage.tsx:453`、`src/renderer/PluginUninstallDialog.tsx:18` | `tests/unit/plugin-uninstall-dialog.test.tsx:122` | 后台页面测试通过；真实窗口未执行 |
| 首次打开可直接输入 | `src/renderer/plugin-ui-dialog-host.tsx` | 尚无真实 Electron 复现证据 | 未验证，不能宣称根因已解决 |
| 长菜单边缘可达 | `src/renderer/context-menu.tsx` | `tests/unit/context-menu.test.ts` | 后台测试通过；真实滚动/边缘未验证 |

本轮命令与结果：

- Host：`npx vitest run tests/unit/plugin-widget-renderer.test.tsx tests/unit/plugin-widget-dialog.test.ts tests/unit/plugin-menu-contributions.test.ts tests/unit/plugin-uninstall-dialog.test.tsx tests/unit/context-menu.test.ts`，5 files / 45 passed。
- Host：`npm run typecheck`、变更 Renderer/确认面板/文案与对应测试的定向 ESLint、`git diff --check` 均通过。
- 插件：`npm test` 14/14、`npm run check` 通过。最终交付包 `com.dolag.serpent.renamer-0.1.2-any.zip`，SHA-256 `f825023ddcf0c1929dd097bfd11ee1e000751aac1a0c849dbbf2cbd600ce2eb1`；交付包保留，测试解压临时文件已清理。
- 默认 userData 插件锁为空；无法排除当前运行实例使用自定义 userData，未证实实际安装包与源码一致。未覆盖用户安装。
- 按用户要求不启动前台测试：Computer Use、真实 Electron E2E、packaged、Windows 真机交互未执行。`verify:mainline` 包含前台 E2E，未运行；此次未提交/合流，不能声明合流门禁通过。

## 本轮追加的用户反馈

### 0.1.3 后再次拒收与规格校正

- 用户报告参数 tab 和编号格式切换可能卡约 5 秒，格式切换还会关闭编号；首次打开输入失效仍存在，切换 Windows 应用再返回后恢复。以上保持未解决，不能用静态截图或 DOM 测试证明通过。
- 编号默认追加文件名后，默认分隔符 `_1`；选项只显示 `1`、`_1`、`1_`、`_1_`。关闭编号时保留字段并置灰，不隐藏。
- 插件定向测试已同步新默认值、disabled 状态及 `shot.png → shot_1.png` 预览断言，14/14。
- 本轮误在 Host 目录启动全量 npm test，发现后中断；该运行未完成，不能作为验证。输出出现既有 desktop-ingestion 失败；本次不以重跑消除它，也不修改无关测试。

### 0.1.3 卡片正规化收尾

- group 直接复用 SettingsCard；参数和预览各一张标准卡片，不再渲染 fieldset/legend。Switch 复用设置行，不传会产生垂直 Field 的 label，保留可访问名称与描述。
- 对话框最大高度改用视口预算。后台 Chrome 760×1000 加载当前 Renderer、DialogShell、toolkit、实际插件 tree 和主窗口同序 CSS，确认圆角卡片、内部标题、同行开关、双列对齐及 8 行短名可见。这不是实际 Electron 或用户主题验收。
- 本次 Host 相关 22/22；新增卡片结构回归后 Renderer 5/5；插件14/14、check、打包通过，Renderer lint通过。包为 `com.dolag.serpent.renamer-0.1.3-any.zip`，SHA-256 `f44613f15ea7aa78e903a6b0db94dd796743a8d044cda0cd7a1020c98f5e3caf`。
- 用户未验收新版，首次输入真实焦点仍未验证。

- 0.1.2 布局再次被用户截图拒收：明确要求参数和预览使用设置页同款独立卡片，自动编号标题/开关仍未对齐。根因已由主 agent 核对：`Switch` 传入 `label` 后自动包成垂直 `Field`，前版仅把 heading 与 Switch 放进 row，并未形成真正横向开关行。后续改为标准设置行 + 无 Field 包装的 Switch，并用 `SettingsCard` 渲染 group；0.1.2 不作为视觉完成证据。

- 用户截图拒绝自动编号页的布局，要求从 UX 和美观角度完全重组并保持精简。采用同行开关、开启后两列字段、文字化位置/顺序、仅补零时显示位数、预览保持底部的结构；不是仅调整颜色或圆角。
- 用户询问多选菜单顶部“移动/回收站：将处理 / 跳过”何时加入，未要求删除。本轮仅做只读追溯。
- Luna 追溯到提交 `e6187fedc1dcc2b29566f4fb6828d562a00a5665`（2026-07-18 16:52:13 +0800，`feat(org): collection import CTAs, smart-collection rules, menu skips`），关联 `Serpent-guq` / `REQ-MENU-004`。更早 0014 已有较长范围说明。
- 现存内部需求池、开发日志与工单不能证明用户明确要求该两行具体文案；工单创建者为 `unknown`。不得归因为用户明确授权。

## 已定位的代码问题

- Host 长期本地 override 会盖住插件 peer patch。按钮改用 widget tree 权威状态；文本和数字输入保留短期 pending，避免迟到快照覆盖连续输入。
- 编号方向和位置原先只存在插件 state，提交快照却是两个布尔按钮值；已补提交归一化。本轮精简 UI 将改为直接提交方向/位置字符串。
- 插件卸载原先直接 dispatch；新增标准确认面板，包含名称、版本、作用域，固定目标资源库并展示失败。
- 首次输入失效的真实 Electron 根因仍未证实；不增加延迟绕过。菜单裁剪仍缺真实窗口证据，不继续叠加猜测性定位修改。
