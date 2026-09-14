## 为何

用户关掉重复窗/关应用后「全部丢失」。若已点确认，操作处于 `applying`：文件已从 stage rename 到 Assets，但 file_operations 尚未 committed。下次打开 `recoverFileOperations` 对 `!hadDestination && !staged && dest exists` 会 `rmSync` 目标文件，把已放入库的新文件删掉。

设计：docs/internal/implementation/2026-09-11-large-batch-import-reliability.md §5.3

## 做什么

1. version-1 import、status=applying：若目标 path 在 assets（deleted_at IS NULL）已有行，视为已应用，禁止 rmSync。
2. 仅当无 DB 行、无 backup、stage 已空、hadDestination=false 时，才删孤儿目标（rename 之后、INSERT 之前崩溃）。
3. 有任一已应用文件则操作标 committed / PROCESS_INTERRUPTED_RECOVERED，不要整单 rolled_back。
4. closeLibrary：决策中的 pending 仍可 abandon 暂存；已 applying 的不要当 pending 扔掉，留给下次恢复。
5. backup 存在时仍恢复 backup（替换已有文件的崩溃语义不变）。

## 验收

- Worker：applying + 目标已有 asset 行 + stage 空 → 恢复后文件与行仍在。
- Worker：applying + 无 DB 行的孤儿目标 → 仍删除孤儿。
- 替换导入（hadDestination/backup）崩溃恢复回归不得坏。
- `npm run test:library-availability` 完整跑完。

## 不改

未确认（preparing/冲突 pending）的暂存仍应可被取消删除。不要把暂存改写到系统盘。
