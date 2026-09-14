# 2026-09-06 插件 widget 对话框（Host UI kit）

## 现象

插件对话框被做成又一个 workspace iframe：`contributes.dialogs.entry` HTML、`plugin-ui.ready` 握手、不透明 placeholder。MediaConverter 因此自造 `entry/ui/panel.html`。用户复验出现空白面板、取消无效、压缩/转换错页、永远「正在载入」。

根因是框架把「自定义面板」做成了 Webview，而不是宿主控件组合。

## 决定

对照 Qt / IntelliJ：菜单仍用 Manifest JSON（`when` / `enablement`）；对话框用 `serpent.ui.openDialog({ title, render })`。`render` 在插件进程执行，产出有界 widget IR；Renderer 映射到已有 primitive（`DialogShell`、`Field`、`Select`、`Switch`、`Slider`、`TextField`）。闭包不过 IPC。取消/提交由宿主页脚。iframe 只留给 WebGL/第三方页。

## 实现

- `src/shared/plugin-widget-ir.ts`：有界树（深度 8 / 128 节点）。
- `src/plugins/plugin-widget-toolkit.ts`：`ui.state` / `column` / `select` 等；变化后重建树。
- `ui.dialog` 增加 `{ sessionId, title, tree }`；`ui.widget-patch` 替换树；Renderer 用 `change` 事件回插件。
- Trusted Host 与 QuickJS Guest 都包装 `openDialog({ render })`。
- `PluginUiDialogHost`：有 tree 则渲染 kit，不再挂 iframe placeholder。
- MediaConverter 去掉 HTML 面板，两命令改为 `render`。

## 2026-09-06 复验

「开始处理」无 Job：preload 对 `plugin-ui-dialog:result` 用 `ipcRenderer.send`，Main 却 `ipcMain.handle`（只收 `invoke`）。已改为 `ipcMain.on`。QuickJS wrap 在 dialog 返回后 `__closeWidgetSession`，避免 event loop 挂死。

MediaConverter 按复验改：菜单「压缩体积」「视频转码」；窗口「媒体压缩」「视频转码」；输出仅 MP4/WebM；图像/视频设置分节；视频可设目标码率；音频默认复制；后缀留空替换原资产。`media-tools` 本地化为「媒体工具」，插件分组标签不再 uppercase。

## 证据

定向单测与插件仓 Node 测试见清单 PLUGIN-049。真实 Electron 须完整退出后重启并刷新插件包。

## 2026-09-06 第二次复验

用户报告：1）对话框下拉很大概率点不开；2）压缩失败「未找到资产信息」。

下拉：widget 用的是原生 `<select>`，祖先是带 `backdrop-filter` 和 `overflow: auto` 的 `dialog-backdrop`。Chromium/Electron 在这种合成层里经常不弹出系统/页内下拉。已改为复用 `PortaledPopover`（tooltip 层，画在 modal 之上），并把 DialogShell 从模糊 scrim 里拆出来。

压缩：日志里 `asset.list` 成功（启动时另有一次 `LIBRARY_NOT_OPEN` 是开库前的噪音）；`linked-folder.list` 因未声明 `folder.read` 被拒，与本次失败文案无关。失败来自 `indexAssetSummaries` 调用 `assets.list({ limit, offset })` **没有 `recursive: true`**。Host 默认只返回库根资产，文件夹里的选中项编不进 index，插件就报「未找到资产信息」。已改为递归分页列出，Guest 投影补上 `mimeType` / `byteSize` / `currentRevisionId`。

## 2026-09-06 第三次复验

用户报告：1）压缩极慢；2）正在压缩时再对另一批资产发起压缩，活动条/对话框 UI 坏掉。AI 分析与 Image Upscaler 同类长任务也没有「正在跑的任务被新排队盖住」的保护。

慢：两条叠加。`asset.list` Worker 仍一次性 SELECT 全表，Gateway 再切片；插件为找几个 ID 递归分页等于对 2 万资产扫上百次。同时 Guest 投影丢掉 `relativeFilePath` 后，插件只能用 768KB `readContent` 把整文件拷进临时目录再 ffmpeg。修复：`asset.list` 增加可选 `assetIds`（最多 200，SQL `IN`，跳过 folder/recursive 过滤）；Guest 投影补上可移植的库内相对路径（绝对路径仍剥离）；MediaConverter 按 ID 分批索引，有 `libraryRoot` + 相对路径时 ffmpeg 直读 `Assets/`。

并发 UI：Job 调度对同一实例仍是串行排队，逻辑没有并行跑两个 ffmpeg。活动条用 `created_at DESC` 的列表 `.find(queued||running)`，先命中刚入队、进度 0 的 job2，正在跑的 job1 从条上消失。对话框 `setRequest` 直接替换，上一条 `openDialog` 挂死。修复：活动条优先 `running`，再最早的 `queued`，并显示「另有 N 个排队」；新对话框到来时先 `resolve(null)` 取消上一条；插件对话框纳入 `serpent-modal-open`。允许排队，不靠禁止第二个 Job 打补丁。AI 菜单已有 `!aiAnalyzing`；插件 Job（含 upscaler）走同一条活动条选择逻辑。

## 2026-09-06 第四次复验

用户确认图片压缩已通。视频压缩和转码都失败；并指出「插件为找选中资产去 `assets.list`」是错的，选中项应由 Host 传入。

视频：假 ffmpeg/`probe: duration: '10'` 测不到。宿主捆绑 FFmpeg 8（`n8.1.2`，`--disable-libx264 --disable-libx265 --enable-libopenh264`）上两条叠加：

1. 插件 `ffprobe` 用了 `-print-format json`（连字符）。FFmpeg 8 只认 `-output_format json` / `-of json`；`-print_format` 是已弃用别名。probe 一失败，压缩和转码都停。
2. `media-plan` 写死 `libx264` / `libx265`，捆绑包没有这两个编码器。

修复：`ffprobe -output_format json`；Job 开始时读 `ffmpeg -encoders`，优先 `libx264`/`libopenh264` 再硬件；CRF 只给真正支持 CRF 的编码器，否则映射码率。用捆绑二进制生成 0.5s `testsrc2` 跑压缩（percent）和转码（quality），不再用假 runner 充当视频已测通。

选中资产：`invocation.selection.assets` 带有界快照（id/name/relativeFilePath/mediaType/byteSize/currentRevisionId/folderId/locationKind）。菜单、工具栏、快捷键、Inspector、查看页从已有 `AssetSummary` 填入。MediaConverter 用这份快照分类、直读 `Assets/`、以及后缀留空时的 `expectedRevisionId`；只有快照缺失时才 `assets.list({ assetIds })`。不再为分类去调 `linked-folder.list`（未声明 `folder.read` 会刷 `AUTOMATION_CAPABILITY_DENIED`）。

第四次复验后用户报告视频已能跑完 ffmpeg，但替换原资产失败「缺少修订版本」：快照当时没有 `currentRevisionId`，直读磁盘又不走 `readContent`，写回拿不到 revision。已补进 Host 快照。

## 2026-09-06 第五次复验

用户报告：1）压缩视频（含目标体积 50%）输出比源文件更大；2）转码成 WebM 后资源库仍显示 MP4；3）选 WebM 时编码仍用备注，且 MP4 应能选 VP9/AV1。

体积变大：percent/size 模式把「目标字节 × 8」整段总比特直接喂给 `-b:v`。`-b:v` 要的是每秒码率，必须再除以时长。3 秒片源上旧公式会把输出做成约 3 倍目标，所以 50% 也会变大。质量模式对无 CRF 的 `libopenh264` 也曾用固定 ~3100k，脱离源码率。现改为按时长换算；若第一次仍 ≥ 源体积，再按源码率的 45% 重编一次。单测用字面量 `4002304`（100 MiB / 100s / 50%）卡住旧公式；真实 FFmpeg 用 3 秒 1500k 片源断言输出 < 源。

WebM 仍是 MP4：后缀留空走 `replaceContentBatch`，路径还是 `clip.mp4`，库按扩展名认类型。标签其实还在同一资产上。修复：Worker 本就支持 `newFileName`；Automation/Guest 补上后，容器变了就 replace 再 `renameFile(..., { fileName: stem.webm })`，同一 `assetId`。带后缀 import 则从原资产拷标签/评分/描述到新资产。

编码下拉：选 WebM 时选项变为 VP9/AV1 并落到 VP9，不再用备注。MP4 增加 VP9/AV1（FFmpeg 的 MP4 可封装二者；VP9 写 `-tag:v vp09`）。widget select 在选项变化后若当前值非法则回落到合法项。

## 证据

定向单测与插件仓 Node 测试（含真实 FFmpeg：50% 必须小于源、WebM 的 ffprobe `format_name` 含 webm）见清单 PLUGIN-049。真实 Electron 须完整退出后重启并刷新插件包。
