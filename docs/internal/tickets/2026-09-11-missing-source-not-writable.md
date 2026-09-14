## 为何

同一份用户日志里，开库后约 1000 条 generate_thumbnail 失败。cause 是源文件不存在（网盘未落地/已挪走），外层却是 LIBRARY_NOT_WRITABLE。对账随后才把资产标 missing。Worker 被失败媒体任务占满，导入更卡。

设计：docs/internal/implementation/2026-09-11-large-batch-import-reliability.md §5.6

## 做什么

1. Sharp/ffmpeg/OIIO 的 ENOENT /「Input file is missing」不得再包成 LIBRARY_NOT_WRITABLE；用 SOURCE_NOT_FOUND 或现有媒体失败码。
2. availability=missing 或入队前 exists 失败：跳过 startup 缩略图波次。
3. 对账标 missing 尽量发生在风暴入队之前，或入队时跳过 offline/missing。

## 验收

- 单测或 Worker：源文件不存在的缩略图任务错误码不是 LIBRARY_NOT_WRITABLE。
- missing 资产不在开库 startup 波次被批量入队（可用夹具，不要真实网盘）。
- `npm run test:library-availability` 完整跑完。

## 不改

不修 SQLite IN。不做网盘智能同步产品。不把同步盘库改成只读。
