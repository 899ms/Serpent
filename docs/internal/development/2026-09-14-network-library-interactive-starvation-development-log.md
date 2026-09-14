# 2026-09-14 网络库浏览卡死：源路径/轮询抢槽与协议读并发

> 分支：`dev`  
> 状态：第二轮已交付。用户确认切文件夹卡顿仍在，但不再阻碍操作。耗时收口仍走 PERF2。  
> 关联：`Serpent-3kfe`（性能 Epic）；本轮工单 `Serpent-52eed4`

## 第二轮（切文件夹仍卡、hover 有效点击无效）

用户在第一轮车道改动之后反馈：切文件夹仍容易卡死；卡顿期间资产卡片点击、文件夹点击都不生效，但文件夹 **hover 高亮仍在**。

这不是「鼠标事件彻底丢了」，而是三件事叠在一起：

1. `.workspace-navigation-hold` 用透明层盖住画布并 **捕获 pointer**。卡片点击被这层吃掉。侧栏不在这层下面，所以 CSS `:hover` 还在。
2. `chooseFolder` 要等 `createBrowseSession` 回来才改 `assetScope`。侧栏「当前文件夹」高亮跟的是 `assetScope`，所以点击看起来没成功。
3. `createBrowseSession` 仍然先跑全范围 `idsOnly`（数万 ID），再取首屏 100 条。网络库上这是长时间同步 SQLite；latest-wins 杀不掉已经开始的这次查询。连点文件夹等于排队等上一次枚举跑完。

第二轮改动：

1. **点击当下就改侧栏选中**（文件夹 / 合集 / 智能合集 / 标签 / 回收站），不等 Worker。
2. 导航挡板改为 `pointer-events: none`，进度光标改挂在画布 host 上，不再吞点击。
3. **浏览会话先查有界首屏 + COUNT**，不再为显示 100 条先枚举全部 ID。后续页在索引未完成时按同一查询 OFFSET 补齐；全选仍走原来的 ids 读取并在那时补全快照。

主/Worker 改动不会经 Vite HMR 生效，必须退出整个 Electron 再 `npm start`。

**2026-09-14 用户复验：** 切换文件夹卡顿的问题还是存在，只是不会阻碍用户操作了。操作假死视为消除；首屏/COUNT 在网络库上的耗时未达标，留给 `Serpent-e9a66b`。

## 第一轮问题

用户用 **0.2.2 安装包**打开 UNC 网络共享上的资源库后：开库慢、资产浏览区鼠标像被事件卡住、切文件夹极慢。

当次会话日志（无本机路径）要点：

- 进程启动后约 8 秒 `library.open` 完成，约 24 秒才出现第一次 `serpent://source`。
- 同一资产在 560ms 内被解析 10 次。
- 开库后台对账跑了 17.6 秒；原生拖放预热排队 7.3 秒。
- 清过期回收站报 `LIBRARY_NOT_WRITABLE` / `PERMISSION_DENIED`。
- 第二次卡住：`ai.test-connection` 占着 `interactive-control` 约 3 秒，后面叠了三轮 `media.list-jobs` / `ai.status` / `plugin.jobs.list`。

根因不是画布丢了鼠标监听，而是：

1. `media.get-source-path`、状态轮询、`ai.test-connection` 都走（或落到）唯一的 `interactive-control` 槽，和 `browse.session.open` 互斥。
2. 调度器同一时刻只允许一个 interactive 车道（含 visible-media / viewer-upgrade）。
3. 主进程对网络文件 `open`/`stat` 打满 libuv 线程池后，Electron 窗口输入也会停。

本轮**不**做 PERF2 的只读进程隔离和 NAS 快照（仍在 `Serpent-e9a66b`）。当前分支先把浏览交互从这些后台工作里拆出来。

## 做法

1. **车道分类**（`src/shared/performance-contract.ts`）
   - 浏览会话、列表、搜索明确留在 `interactive-control`。
   - `media.get-source-path` 及同类路径查询改到 `background-primary`（与拖放预热一样会向 mutation 让路）。
   - `media.list-jobs` / `ai.status` / `plugin.jobs.list` / `history.status` / `sync.asset-card-status` / `ai.test-connection` 改到 `background-secondary`。
   - `browse.session.open` 增加 latest-wins 键 `browse-session`，连点文件夹时丢掉仍在排队的旧打开。

2. **不改 interactive 互斥规则**  
   曾试过让 `interactive-control` 与 `visible-media` 并发，会让切库时的浏览积压在 `library.open` 入队前就把 Worker 占满，回归 `SWITCH-001` 的切库饿死。因此调度器准入保持原样：browse 仍可与 **background** 重叠（已有测试），不能与 visible-media 重叠。

3. **协议读并发门**（`src/main/async-gate.ts`）  
   `createArtifactResponse` 的 `open`/`stat` 最多同时 2 个。其余请求在 JS 里等，不占满默认 4 个 libuv 槽，主进程还能分发指针事件。

未改开库对账本身、未改「网络库写失败仍按可写库对账」；那是另一条写路径，不解释鼠标假死。

## 验证

第一轮：

```text
node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/unit/interactive-scheduler.test.ts tests/unit/async-gate.test.ts tests/unit/artifact-response.test.ts
```

3 files / 31 passed。

第二轮：

```text
node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/unit/browse-session-store.test.ts tests/unit/workspace-navigation-hold-css.test.ts tests/worker/browse-session.test.ts tests/worker/linked-folders.test.ts
```

4 files / 44 passed。`tsc --noEmit` 通过。未跑 `test:library-availability`（未改 schema / 开库 / 关库）。未跑 Electron E2E 与 packaged。真实网络库需用户用**完整重启后的当前构建**复验。

## 已知限制

- 网络盘上 SQLite 与 SMB 延迟仍在；COUNT 和首屏 LIMIT 仍走远端库，只是不再为 100 张卡片先拉全范围 ID。
- 开库对账 10 秒级、权限拒绝清回收站仍会打日志。
- PERF2 的只读进程隔离和 NAS 本地快照未交付。索引未完成时滚动靠 OFFSET 再查，全选仍可能在第一次 ids 读取时停一下。
