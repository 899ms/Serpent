## 为何

用户 10 万+ 导入在 `asset.import.resolve` 上失败：`SqliteError: too many SQL variables`，栈在 `countLogicalAssetUnits`。随后 `asset.refresh` 同样失败，栈在 `withImageSequenceSummaries`。SQLite 单条语句绑定有上限；仓库 jobs 查询已按 900 分块，导入/序列/刷新路径没有。

设计：docs/internal/implementation/2026-09-11-large-batch-import-reliability.md §5.1

## 做什么

1. 新增 `src/worker/sqlite-in.ts`（或同等小模块）：`SQLITE_IN_BIND_LIMIT = 900`，按 chunk 执行 IN 查询并合并结果。
2. 至少替换：`countLogicalAssetUnits`、`withImageSequenceSummaries`、`createDetectedImageSequences` 的 asset_id IN、`refreshManagedAssets` 的 assetIds IN。
3. 扫描 `library-service.ts` 里 `ids.map(() => '?')` / `placeholders` 拼 IN 的调用：删除/标签/合集等用户可多选超 900 的路径一并换 helper。同一 PR 可先保证导入热路径测试绿，其余必须在开发日志列出「已换 / 未换」；未换项另开跟进单，不得 silently 留下导入路径。
4. `resolveImport` 成功后不要 `listAssets({ recursive: true })` 再 filter；按受影响 ID 分块取摘要。

## 验收

- 临时 SQLite 插入 >900（建议 ≥2500）行，helper 结果完整，单语句绑定 ≤900。
- Worker：导入文件数 >900（可用极小空文件/迷你 fixture），`resolveImport` 不抛 too many SQL variables，importedCount 正确。
- `npm run test:library-availability` 必须完整跑完。
- 不得用用户真实库或同步盘路径；测完删除本次临时目录。

## 不改

不改 schema。不在本单修 overlay、TTL、恢复删除。
