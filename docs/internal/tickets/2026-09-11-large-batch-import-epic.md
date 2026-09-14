2026-09-11 用户日志（Windows 0.2.1 便携版）：向已有库导入 10 万+ 文件时极卡、导入失败、进度数小时不消失、取消报失效；另一次关掉内容重复窗后「全部丢失」。库在网盘同步盘上。

设计正文（实现前必读）：
docs/internal/implementation/2026-09-11-large-batch-import-reliability.md

子工单：
- Serpent-d4d79f SQLite IN 分块（先做）
- Serpent-3d4290 resolveImport 提交边界（依赖 d4d79f）
- Serpent-41c7e1 applying 恢复
- Serpent-8fadb4 进度/取消 UI（依赖 3d4290）
- Serpent-d1280f 决策 TTL
- Serpent-9b7a3a 缺失源误报 LIBRARY_NOT_WRITABLE
- Serpent-0a5018 暂存前冲突预检

不要只修日志里出现的函数名；按设计不变量改完整导入状态机。
