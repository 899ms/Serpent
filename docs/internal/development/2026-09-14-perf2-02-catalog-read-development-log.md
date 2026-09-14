# 2026-09-14 PERF2-02：共享纯读 catalog 核心

> 工单：`Serpent-6dc70b`
> 规格：[交互性能第二阶段设计](../implementation/2026-09-13-interactive-performance-design.md) §4.1、§4.3、§5
> 本单不实现独立 UtilityProcess、两阶段 BrowseSession、NAS 快照发布或 Renderer 路由。

- 分支：`dev`
- 固定基点 / 当前未提交工作树基线：`7e4ff1f05ca79bb8207cea90a2ffcf2248b42c20`
- 开始 / 最后更新：2026-09-14
- 当前状态：自动化验证与独立双轴审查通过；整体性能与产品验收未完成，工单保持 `in_progress`。

## 1. 范围与实现

从 `LibraryService` 提取同一套查询语义；owner 仍使用原有查询流程和领域权威。新模块只接收窄化的 `CatalogReadConnection`（`prepare` + statement `all/get`，不含 `run/exec/transaction`），将 SQL 编译、catalog scope、可见性/忽略/序列折叠、排序、summary/layout 映射与 artifact 读取放在 `src/worker/catalog-read.ts`。该 TypeScript 接口只限制暴露的方法：`prepare(sql).all/get()` 仍可能执行带 `RETURNING` 的写语句，不能证明底层连接只读。

`readCatalogThumbnailArtifacts` 将大于 900 个 ID 的 TEMP 表物化查询改为有界的纯 SELECT 分块，并复用 `sqliteAllInChunks` 的 all-only 接口；写入型 `sqliteRunInChunks` 和 TEMP 表 owner API 保持不变。文件夹 ref 的 managed-folder 查找也改为 SELECT 分块。schema、migration、index 初始化、文件扫描、job 和写 owner 未改。

`tests/worker/catalog-read.test.ts` 的 prepare 审计接缝在 `prepare()` 调用处记录并覆盖当前全部数据库查询入口（navigation count、合集 scope、托管/链接目录 scope、thumbnail 分块、artifact descriptor），断言当前 8 条已执行语句以 SELECT/WITH 开始且不含显式 DML/DDL 关键字。它是针对模块 authored SQL 的小型测试护栏，不是 SQL parser，也不证明调用连接只读。实际独立只读 SQLite 连接与注册路由仍留给 PERF2-03。

## 2. 四列规格证据

| 需求条目 | 实现位置 | 自动化测试 | 人工/平台证据 |
| --- | --- | --- | --- |
| 结构化 FTS 候选、精确 contextual 搜索与相关性排序保持既有语义 | `src/worker/catalog-read.ts:78`、`src/worker/catalog-read.ts:134`、`src/worker/catalog-read.ts:172`；调用方 `src/worker/library-service.ts:5853`、`src/worker/library-service.ts:30836` | `tests/worker/catalog-read.test.ts:99`；差分回归 `tests/worker/search.test.ts:398`、`tests/worker/search.test.ts:478`、`tests/worker/search.test.ts:525`、`tests/worker/search.test.ts:670` | Worker 测试在 Electron runtime 执行；无前台/Computer Use 验收，不代表 packaged 或平台验收 |
| 分类与数值过滤保持 AI tag、格式展开、布尔空值和 NULL exclusion 语义 | `src/worker/catalog-read.ts:194`；调用方 `src/worker/library-service.ts:30453` | `tests/worker/catalog-read.test.ts:120`；差分回归 `tests/worker/search.test.ts:976`、`tests/worker/search.test.ts:1073`、`tests/worker/search.test.ts:1300`、`tests/worker/search.test.ts:1364` | 仅自动化 SQL/结果路径；无产品 UI 验收 |
| 托管/链接目录、递归、合集递归/叶子 scope 与 missing 行为 | `src/worker/catalog-read.ts:432`、`src/worker/catalog-read.ts:486`；调用方 `src/worker/library-service.ts:30854`、`src/worker/library-service.ts:31026` | `tests/worker/catalog-read.test.ts:142`；差分回归 `tests/worker/search.test.ts:775`、`tests/worker/search.test.ts:824`、`tests/worker/search.test.ts:875`、`tests/worker/search.test.ts:949`、`tests/worker/folder-browse-entries.test.ts:322`、`tests/worker/linked-folders.test.ts:125` | 真实文件夹切换 E2E 未执行；本单没有验证 SMB 或离线 linked root 产品流程 |
| explicit/gitignore、linked ignore 与隐藏序列帧可见性；序列 summary 折叠、帧预览与总字节数 | `src/worker/catalog-read.ts:330`、`src/worker/catalog-read.ts:371`、`src/worker/catalog-read.ts:787`；调用方 `src/worker/library-service.ts:16389`、`src/worker/library-service.ts:31012` | `tests/worker/catalog-read.test.ts:212`；差分回归 `tests/worker/image-sequence.test.ts:306`、`tests/worker/image-sequence.test.ts:354`、`tests/worker/image-sequence.test.ts:382`、`tests/worker/image-sequence.test.ts:498`、`tests/worker/linked-folders.test.ts:533`、`tests/worker/linked-folders.test.ts:577` | 文件系统扫描未纳入该模块；没有独立 OS 级 file-access instrumentation 证据 |
| 排序保留 FTS relevance、手动合集位置、NULL 优先级与稳定 assetId tie-break | `src/worker/catalog-read.ts:554`；调用方 `src/worker/library-service.ts:30869` | `tests/worker/catalog-read.test.ts:99`、`tests/worker/catalog-read.test.ts:212`；差分回归 `tests/worker/search.test.ts:1484`、`tests/worker/search.test.ts:1523`、`tests/worker/search.test.ts:1594`、`tests/worker/search.test.ts:1661` | 20k 性能夹具本次未配置，性能预算未验证 |
| AssetSummary、布局几何与当前 artifact descriptor 的纯映射/读取；Service 行签名共用 catalog row 类型 | `src/worker/catalog-read.ts:635`、`src/worker/catalog-read.ts:658`、`src/worker/catalog-read.ts:722`、`src/worker/catalog-read.ts:878`、`src/worker/catalog-read.ts:954`；调用方 `src/worker/library-service.ts:25844`、`src/worker/library-service.ts:30413`、`src/worker/library-service.ts:32222` | `tests/worker/catalog-read.test.ts:344`、`tests/worker/catalog-read.test.ts:394`、`tests/worker/catalog-read.test.ts:422`；资源库可用性 `tests/worker/library-availability.test.ts:121`、`tests/worker/library-availability.test.ts:220` | 未做 Renderer/packaged 媒体解码或 Computer Use 验收 |
| 目录 query seam 不暴露 `run`；当前由 catalog core 执行的 prepare SQL 均为 SELECT/WITH 查询，thumbnail 分块复用 all-only helper | `src/worker/catalog-read.ts:28`、`src/worker/catalog-read.ts:33`、`src/worker/catalog-read.ts:878`；`src/worker/sqlite-in.ts:8`、`src/worker/sqlite-in.ts:43` | `tests/worker/catalog-read.test.ts:285` 审计 8 条当前 prepare SQL；`:394` 断言 901 IDs 分两条 SELECT | API/SQL shape 测试不证明底层句柄只读，也不替代 PERF2-03 的 OS/连接隔离验证 |
| 不改变已发布 schema | 本单只改 `src/worker/library-service.ts` 并新增纯读模块/测试/日志；无 schema/migration 文件改动 | `git diff --check` 和变更文件审阅 | 没有人类验收项；schema 兼容性由完整 availability 门禁覆盖 |

## 3. 当次命令与结果

```text
npm run typecheck
→ exit 0（`tsc --noEmit` 与 extension typecheck）

npx vitest run --config vitest.config.ts tests/worker/catalog-read.test.ts
→ 1 file passed；8 tests passed

npm --ignore-scripts run test:library-availability
→ 运行 package 的完整 Electron RunAsNode availability 测试命令；9 files passed；211 passed、1 skipped。为避免该命令 pretest 在探测失败时自动 rebuild，本轮跳过生命周期脚本；本轮未执行 ABI/FTS5 pretest，也未重建或更改 native 模块。

node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/worker/sqlite-in.test.ts tests/worker/search.test.ts tests/worker/browse-session.test.ts tests/worker/folder-browse-entries.test.ts tests/worker/image-sequence.test.ts tests/worker/linked-folders.test.ts
→ 6 files passed；156 tests passed；exit 0。本轮未出现 worker shutdown warning。此前一次 Worker 回归曾报告 folder-browse-entries/image-sequence shutdown timeout；本轮未复现但根因仍未调查，暂不关闭该风险。

npx eslint src/worker/catalog-read.ts src/worker/library-service.ts src/worker/sqlite-in.ts tests/worker/catalog-read.test.ts
→ exit 0

git diff --check
→ 无 whitespace error；Git 对当前工作树提示换行符规范化通知。
```

开始时曾用 host Node 直接启动 Worker suites，遇到 better-sqlite3 ABI 148/137 不匹配；随后改用仓库官方 Electron RunAsNode runner。此前一轮 availability prehook 曾报告 Electron ABI/FTS5 probe 正常。本轮依协调要求跳过 pretest 以确保绝不触发 native rebuild，测试仍由官方 Electron runner 运行；`node_modules` 未改动。host Node 直接跑 Worker 不作为通过证据。

## 4. 未执行 / 未验证

- 20,000 资产性能基线未执行：本次没有配置 `SERPENT_LARGE_LIBRARY_PERF_PATH` 夹具；thumbnail 分块与 20k 查询延迟尚无基准结论。
- full-window Electron E2E、packaged、SMB、Computer Use 未执行；本单未改 Renderer/Main/Preload/protocol，但不把 Worker suite 等同于真实 UI 验收。
- Windows/macOS 平台兼容与真实 NAS 读写未验收。
- PERF2-03 的独立 SQLite read-only 句柄、UtilityProcess 路由、注册查询白名单、请求取消/隔离仍未实现。
- 此前运行中的 worker shutdown timeout warning 根因未定位；本轮相关 6 个 suites 重跑无 warning，但没有建立稳定复现或解释时序原因，因此问题仍未关闭。
- 人类验收、四列产品大项与 `accepted` 结论由协调者/独立验收者决定；本日志不自签切片完成。

## 5. 独立审查与复审

- 首轮 Standards 发现两处低优先级重复：thumbnail 查询复制 900 ID 分块循环；LibraryService summary row 重复 catalog 行类型。修复为复用 `sqliteAllInChunks`（all-only 接口）和 `CatalogAssetSummaryRow`。
- 首轮 Spec 发现 `CatalogReadConnection` 的方法面不构成底层 SQLite 只读保证，且原测试只核对 thumbnail SQL。修正接口注释与日志边界说明，并增加 `prepare()` 查询审计，覆盖当前 8 条已执行 catalog SQL，检查 SELECT/WITH 语句形状及显式 DML/DDL 关键字。它不是通用 SQL parser，也不证明底层句柄只读；真正的只读 SQLite 连接留在 PERF2-03。
- 同一独立 Luna 审查者按固定点和原文件范围复审，Standards、Spec 均通过；未发现新问题。完整记录见[代码审查报告](../reviews/2026-09-14-perf2-02-catalog-read-code-review.md)。
- 修复后证据：catalog-read 8/8、typecheck、availability 9 files/211 pass/1 skip、相关 Worker 6 files/156 pass、ESLint、diff-check 均通过；无 commit。

## 6. 当前结论与 QA

- 当前自动化结果仅证明此次 worker 查询重构的定向语义与资源库门禁通过，不证明大型资源库性能已改善。
- 20k 性能基线、完整窗口 / packaged E2E、Computer Use 与平台产品验收尚未执行；因此本单不声明整体 accepted。QA 证据见[QA 报告](../qa/2026-09-14-perf2-02-catalog-read-qa.md)。
- 下一步按执行计划进入 PERF2-03：落实真正独立的只读连接、执行器路由与请求隔离，再以大型库性能基线验证实际效果。
