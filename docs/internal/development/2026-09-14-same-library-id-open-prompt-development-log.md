# 2026-09-14 同 ID 开库：提示重复打开，不当损坏

> 分支：`dev`  
> 状态：用户验收通过  
> 关联：`Serpent-79b839`

## 问题

用户打开网络共享上的资源库后，再用另一条路径打开同一份库（同一网络位置的不同到达方式，或复制出的副本）。界面按数据库损坏处理：标题「无法打开资源库」，正文要求备份恢复。这不是损坏。

根因：`openIdByPath` 只认规范化后的同一路径。路径不同、`library_id` 相同会走进 `adoptWritableOpenLibrary` / `openLibraryReadOnly`。旧逻辑抛 `LIBRARY_CORRUPT`。本会话曾改成静默复用句柄；用户明确否定——这不能当错误，要提示是否重复打开了相同的资源库。

产品口径（2026-08-27 / 2026-09-14）：

- 身份以 `library_id` 为主，路径只是到达方式。
- 同一规范化路径再打开：静默复用。
- 同一 ID、不同路径：提示，不报损坏，不抢救，不从最近列表删除。
- 不要第二个同 ID 句柄（预览与 artifact 按 ID 索引会串）。
- **取消 / 关闭**：留在当前已打开的库。
- **确认**：关掉当前句柄，打开刚选择的那条路径。不要再出现「切换资源库」或创建资源库界面。

## 改动

1. 公共码 `LIBRARY_ALREADY_OPEN`。正文按产品口径：「所选资源库和当前打开资源库有相同的资源库ID，可能是同一资源库的不同路径。是否视为不同资源库进行打开。」取消留在当前库；确认把刚选的位置当作不同资源库打开。不说损坏、不走抢救。
2. Worker `reuseOrRejectDuplicateCatalog`：默认关多余连接后抛该码。`library.open` 带 `replaceExisting` 时先关当前句柄，再采纳所选路径上的连接。迁移失败闩与抢救梯不把它当成损坏。
3. Renderer 阻塞窗标题用「资源库已打开」，按钮为「取消 / 确认」。取消和关闭只关掉提示；确认带着所选路径重开（`replaceExisting`）。不再提供「切换资源库」（会误开创建资源库界面）。
4. Main 最近列表删除条件不包含该码。

## 测试

- `npm run test:library-availability`：9 files / **214 passed** / 1 skipped。
- `npx vitest run tests/unit/library-open-already-open.test.ts tests/unit/fatal-alert-dialog.test.ts`：2 files / **6 passed**。
- `npx tsc --noEmit`：通过。

真实网络路径、packaged 未执行。不得把用户本机或共享路径写入仓库。
