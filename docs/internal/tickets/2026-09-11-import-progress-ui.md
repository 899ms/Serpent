## 为何

resolve 失败后 Renderer 不清 `importProgress`，遮罩一直在。取消走 abandon → IMPORT_NOT_FOUND。冲突窗取消没有说明丢掉的是暂存副本不是源文件。

设计：docs/internal/implementation/2026-09-11-large-batch-import-reliability.md §5.4
关联：Serpent-85e60c（连点 IMPORT_NOT_FOUND 抑制）、Serpent-224ac8（取消不能卡死）

依赖：resolveImport 提交边界（complete 进度事件与 finalized importId）。

## 做什么

1. `resolveImportConflictsWith` 无论成功失败都清 overlay（finally `setImportProgress(null)` 或依赖 worker complete 事件且失败路径也清）。
2. 对已 finalized / 本次已提交成功的 importId，cancel/abandon 的 IMPORT_NOT_FOUND 走 shouldSuppressImportContinueError，遮罩必须关掉。
3. 内容重复/同名冲突取消文案（中英）：将丢弃这次复制到资源库暂存区的文件；源文件夹里的原文件不会删除。
4. 拷贝阶段保持已处理/总数，不要长时间停在「正在准备导入」（同步盘单文件很慢时至少数字会变或显示当前文件序号）。
5. 复用现有 DialogShell / i18n catalog，禁止自造弹层和硬编码颜色。

## 验收

- 单元：失败路径清 progress；finalized cancel 不弹失效死循环。
- 文案 key 在 zh-CN / en 都有。
- 实现同一提交更新 human-acceptance-checklist：IMPORT-UI-005、IMPORT-UI-006。
- 不得把条目标成人类验收通过。

## 不改

不改 Worker SQL 分块。不把取消冲突改成保留暂存到下次启动。
