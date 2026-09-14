# 2026-09-14 PERF2-02 共享纯读 catalog 核心 QA 报告

状态：自动化门禁通过；整体产品与性能验收未完成，不标记为 `accepted`。

## 范围与环境

- 分支：`dev`；固定基点：`7e4ff1f05ca79bb8207cea90a2ffcf2248b42c20`。代码仍在该基点之上的未提交工作树。
- 范围：提取 LibraryService catalog 查询与映射到共享核心；复用 all-only SQLite 分块查询；不改 schema、IPC、Renderer、Main 或 Preload。
- 环境：Node.js v24.14.0；Worker 测试通过仓库 Electron RunAsNode runner。资源库可用性脚本以 `--ignore-scripts` 运行测试入口，避免生命周期 pretest 触发 native rebuild；因此本次测试命令未执行该 pretest。本轮未改 native 模块。
- 工单：`Serpent-6dc70b`。独立双轴审查见[代码审查报告](../reviews/2026-09-14-perf2-02-catalog-read-code-review.md)。

## 自动化结果

| 检查 | 当次命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过，exit 0 |
| catalog 核心单测 | `npx vitest run --config vitest.config.ts tests/worker/catalog-read.test.ts` | 1 file、8 tests 通过 |
| 资源库可用性 | `npm --ignore-scripts run test:library-availability` | 9 files、211 passed、1 skipped；完整 Electron RunAsNode 测试入口通过，生命周期 ABI/FTS5 pretest 本次未执行 |
| 相关 Worker 回归 | `node scripts/run-vitest-with-electron.mjs run --config vitest.config.ts tests/worker/sqlite-in.test.ts tests/worker/search.test.ts tests/worker/browse-session.test.ts tests/worker/folder-browse-entries.test.ts tests/worker/image-sequence.test.ts tests/worker/linked-folders.test.ts` | 6 files、156 tests 通过；本轮未出现 shutdown warning |
| ESLint | `npx eslint src/worker/catalog-read.ts src/worker/library-service.ts src/worker/sqlite-in.ts tests/worker/catalog-read.test.ts` | 通过，exit 0 |
| 差异空白检查 | `git diff --check` | 无 whitespace error；仅有 Git 换行符规范化通知 |

此前一次相关 Worker 运行曾出现 folder-browse-entries / image-sequence shutdown timeout；本轮没有复现，但没有稳定复现与时序根因分析，故保留为未关闭风险。

## 未执行 / 仍未验证

- `tests/worker/large-library-performance.test.ts` 的 20,000 资产基线未执行；没有据此声称切换或资源加载已提速。
- 完整窗口 Electron E2E、packaged 启动与媒体解码验收未执行。
- Computer Use / 真实 UI 视觉验收未执行。
- Windows/macOS 的产品平台矩阵、真实 NAS/SMB 与离线 linked-folder 旅程未验收；测试通过不等于这些平台或旅程通过。
- 本单没有独立 SQLite 只读句柄；`prepare()` SQL 语句形状测试不证明底层连接权限。该项属于 PERF2-03。
- 本轮没有执行 Electron ABI/FTS5 生命周期 pretest；先前开发记录中有一次 ABI/FTS5 probe 正常的结果，但不将旧结果当作本轮证据。

## 结论

此次自动化证据支持 catalog 查询抽取与相关资源库门禁通过。由于 20k 性能基线和真实 UI / 平台验收尚缺，整体优化效果与产品验收仍为未验证；工单保持 `in_progress`，无提交、无用户验收通过声明。
