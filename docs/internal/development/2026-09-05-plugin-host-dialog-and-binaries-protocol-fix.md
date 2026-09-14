# 2026-09-05 插件 ui.dialog / media.binaries 协议与全局实例目标库

## 现象

全局无限制插件右键「压缩图片视频」无反应。

第一轮日志：

- `plugin.trusted.protocol-fault`：`Invalid or unknown control message: plugin-trusted.host-command.`
- 实例 `RUNTIME_PROTOCOL_ERROR` 崩溃
- Renderer：`plugin-command-failed … mediaconverter.open-compress operation-failed`

协议修复并完整重启后仍无面板。第二轮日志：

- 无 `protocol-fault`
- 右键后约 5 秒 Renderer：`plugin-command-failed … mediaconverter.open-compress operation-failed`
- 无 `plugin.trusted.host-command-failed` / `plugin.host-command.gateway-failed`（Gateway 的 `ui.dialog` 一直在等 Renderer）

## 根因

1. 插件 `host-command` 的 `commandId` 沿用脚本白名单 `automationScriptCommandIdSchema`。该名单含 `ui.notify`，不含 `ui.dialog` / `media.binaries.get`。Zod 解析失败后，整条控制消息被当成未知协议，UtilityProcess 被杀掉。
2. Main 对**所有**插件 host-command 要求开库或 `serpent.forLibrary()`。`ui.dialog` / `media.binaries.get` / `ui.notify` 的 `libraryContext` 是 `none`，全局插件的 ambient 调用会在协议修复后仍被拒绝。
3. Renderer 用完整贡献 id（`pluginId.libraryId.localId`）去匹配 `openDialog({ dialogId })` 的 Manifest local id，对话框会立刻按未知对话关闭。
4. `PluginUiDialogHost` 挂在 `previewAsset &&` 分支里。网格右键时没有打开资产预览，宿主不 mount，Main 一直等 Renderer 完成 `ui.dialog`，默认 5 秒命令超时后变成 `operation-failed`。
5. 即便面板能画出来，`openDialog` 会阻塞到用户提交；命令 invoke 的 5 秒定时器仍在走，填表也会被掐断。
6. Renderer 传了 `invocation`，`plugin-manager.run-command` IPC 未转给 Activation Coordinator。
7. 对话框 iframe 请求 `serpent-plugin://…/entry/ui/panel.html` 时，协议 allowlist 只认 workspace/sidebar/inspector/viewer/settings 视图，**不含 `dialogs`**。日志：`plugin-ui.protocol-rejected` → 页面显示 `Plugin UI asset not found`。

脚本协议仍只用脚本白名单，不扩大脚本能力。

脚本协议仍只用脚本白名单，不扩大脚本能力。

## 修复

- `pluginHostCommandIdSchema` = 脚本命令 ∪ `{ ui.dialog, media.binaries.get }`，仅用于插件 Host 协议。
- `libraryContext: 'none'` 的命令允许全局插件 ambient 调用；读写库命令仍要求 `forLibrary()`。
- 对话框按 local id 或完整贡献 id 匹配。
- `PluginUiDialogHost` 提到窗口级 overlay（与 `HoverTipHost` 同级），iframe 使用 `request.libraryId`。
- 插件卡在 host-command（含 `ui.dialog`）时暂停该实例的命令超时；嵌套 host-command 用深度计数，全部返回后再重武装满额 `timeoutMs`。
- IPC 转发 `invocation`；Renderer 失败日志带上 `failureCode` / `message`。
- 删除 `list-contributions` 往用户目录写 `plugin-contrib-diag.json`、激活失败写 `plugin-activation-failures.jsonl` 的临时代码。
- `resolvePluginUiAsset` 通过 `listPluginUiFrameContributions` 纳入 `dialogs`，对话框 HTML 与同目录脚本可被 `serpent-plugin://` 提供。

## 第四轮：面板种类、取消、高度、载入占位

用户复验：压缩菜单弹出转换表单；取消关不掉；高度固定；一直「正在载入选中资产…」。iframe 自造按钮也不走宿主正规化 DialogShell。

根因：

1. Classic script 在 iframe `load` 前发出 `plugin-ui.ready`，随后 `frame-load` 把 lifecycle 打成 `reloading`，不透明 placeholder 盖住表单。
2. `plugin-ui.ready` 的 `contributionId`/`instanceId` 与宿主严格相等；自定义协议 pathname 容易把 instanceId 解析错。
3. 面板默认 `kind=convert`，只信 `payload.kind`；payload 未到就禁用开始并显示载入文案。
4. 取消按钮在 iframe 内，`Escape` 不冒泡到宿主；宿主 hook 也不清 request。
5. Manifest `height` 被当成固定窗口高度。
6. `panel.html` 曾引用 `../../src/panel-host-contract.js`。对话框 `uiRoot` 是 `entry/ui`，该路径会被 `resolvePluginUiAsset` 拒绝。

修复：

- 宿主：`pluginUiIframeReadyMatches` 接受 local id；URL query 带 `instanceId`；忽略 ready 之后的首次 `load`；`DialogShell` 页脚取消/开始处理；`dialog-request-submit` 让 iframe 提交；iframe 高度跟 `dialog-content-size`。
- 插件：契约脚本放在 `entry/ui/`（宿主可服务的唯一位置）；从 contributionId 立刻区分 compress/convert；空 payload 也可提交；取消交给宿主 chrome。

## 验证

宿主（CI，无 Electron 窗口）：

```text
npx vitest run tests/unit/plugin-ui-dialog-session.test.ts tests/unit/plugin-ui.test.ts tests/unit/plugin-view-contract.test.ts tests/unit/plugin-activation-coordinator.test.ts
# 4 files / 38 passed
```

插件仓模拟宿主会话（CI 同样跑；不启动 Serpent）：

```text
npm test
# 42 passed, 1 skipped (SERPENT_PLUGIN_HOST_E2E)
```

`SERPENT_PLUGIN_HOST_E2E=1` 的真机项默认 skip。真实菜单旅程须完整退出后再启动，并刷新已安装的插件包。
