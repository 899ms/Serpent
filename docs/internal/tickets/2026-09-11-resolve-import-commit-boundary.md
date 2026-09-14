## 为何

`resolveImport` 开头就 `pendingImports.delete`。文件和 DB 可能已 `committed`，随后 `createDetectedImageSequences` / `countLogicalAssetUnits` 抛 SQLITE。`catch (committed)` 再次调用同一计数再次抛错。请求以失败返回，且不发 complete 进度。UI 遮罩一直挂着；取消得到 `IMPORT_NOT_FOUND`。

设计：docs/internal/implementation/2026-09-11-large-batch-import-reliability.md §5.2

依赖：必须先落地 SQLite IN 分块（后处理计数仍要正确，不能只吞掉错误）。

## 做什么

1. 文件系统 + assets/revisions 提交且 `file_operations` 已 committed 之后，序列检测、逻辑计数、取卡片全部独立 try。
2. 后处理失败：仍返回成功 ImportCompletion；assetCount 用分块计数或受影响 ID 数回退；assets 可空；打诊断日志。
3. 禁止 committed===true 时无保护地再次调用会失败的 SQL。
4. 进入 applying/提交成功后把 importId 放入短时 finalized 集合；之后 cancel/abandon 该 id 视为已结束成功，不要 IMPORT_NOT_FOUND。
5. 提交成功或提交成功但后处理失败：发 `import.progress` phase `complete`。整笔回滚才是 failed/cancelled。

## 验收

- 单测或 Worker：提交后注入后处理失败，file_operations 仍 committed，resolve 返回 ok，importedCount>0。
- cancel 已 finalized 的 importId 不抛 IMPORT_NOT_FOUND。
- 现有 import-planning / 冲突提交测试不回归。
- `npm run test:library-availability` 完整跑完。

## 不改

不改冲突窗文案（另单）。不改 recoverFileOperations 删除规则（另单）。
