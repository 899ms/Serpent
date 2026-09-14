## 为何

`scheduleImportExpiry` 默认 15 分钟。大库冲突窗开着时到期会把 pending 标 IMPORT_EXPIRED 并删除暂存。用户再确认或取消变成 IMPORT_NOT_FOUND，体感「导了很久全没了」。

设计：docs/internal/implementation/2026-09-11-large-batch-import-reliability.md §5.5

## 做什么

1. 处于等用户决策（内容重复、同名冲突、无法读取、序列帧确认）时：TTL 改为 24 小时，或暂停到期直到 resolve / abandon / 关库。
2. 用户仍盯着对话框时不得清暂存。
3. 关库对「决策中 pending」仍可 LIBRARY_CLOSED 放弃暂存（与现语义一致）；不要在无对话框的后台默默 15 分钟清掉大导入。
4. 补测试：park pending 后快进 15 分钟仍可 resolve；超过新 TTL 才过期。

## 验收

- Worker/时钟注入测试覆盖 15 分钟仍在、24 小时后过期（或等价暂停到期）。
- 现有 pending-import 测试不回归。
- `npm run test:library-availability` 若改了 library-service 开库/导入过期路径则必须跑完。

## 不改

不做「关应用后恢复未确认导入」的产品。那是更大范围，不在本单。
