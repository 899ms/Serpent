## 为何

当前导入先把全部源文件拷进 `.serpent/operations/*/stage/`，再算重复并弹窗。10 万文件在同步盘上先耗数小时，用户取消冲突窗就丢掉全部暂存。源文件一般还在，但体感是导入全丢。

设计：docs/internal/implementation/2026-09-11-large-batch-import-reliability.md §5.7
这是产品/性能项，不要和 P0 SQL 修混在一个 PR。

## 做什么

枚举后先按相对路径 + 体积（及已有指纹索引）生成冲突计划，用户确认后再暂存；或只暂存「保留两者/替换」需要拷贝的子集。

必须遵守：同体积不得再全量 SHA-256（IMPORT-UI-001）；临时文件仍在库内 operations 生命周期内清理；空间不足预检；禁止把大暂存静默写到系统盘。

## 验收

- Worker：目标库已有同名/同内容时，决策前 operations/stage 没有完整 1:1 拷贝（或仅拷需要的子集）。
- 取消冲突后源目录文件仍在。
- 自动化覆盖小夹具即可，不要 10 万真实文件。
- 改 library 导入路径则 `npm run test:library-availability` 必须跑完。

## 不改

不改变「取消 = 本批不入库」。不在本单改 SQLITE 分块或 applying 恢复。
