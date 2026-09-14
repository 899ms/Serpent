# 2026-09-14 文件夹切换与资源加载性能优化方向

> 状态：两轮当前实例诊断与拆单完成，尚未实施。
> 父计划：`Serpent-e9a66b`（交互性能第二阶段）。
> 直接用户问题：`Serpent-52eed4`（切换仍慢，但不再吞操作）。
> 本文补充既有 [`2026-09-13-interactive-performance-design.md`](2026-09-13-interactive-performance-design.md)，不取代其只读进程、NAS 快照、两阶段 BrowseSession 与媒体描述符设计。

## 1. 问题定义与完成边界

用户在当前开发实例中观察到两个相互关联的症状：

1. 点击文件夹后选中态可以变化，但内容可能约半分钟后才真正切换完成。
2. 已有资产的预览异常缓慢，即使本机已有预览缓存也会长时间空等。
3. 在约 2,000 个后台任务运行时，切换文件夹到预览可见接近一分钟；暂停全部任务后，同类操作未超过 0.5 秒。

本轮诊断确认，这不是单一前端渲染问题，而是以下链路叠加：

```text
打开资源库
  -> 写 owner 开始全量 reconciliation
  -> 源文件与 artifact 目录发生 O(N) 文件系统探针
  -> 唯一 Library Worker 长时间被 active maintenance 占用
  -> 目录查询可以进入 interactive lane，但首屏必需的 media.get-artifact-paths 被归入 background-primary
  -> reconciliation 即使在 yield/空闲等待中仍持有唯一 background admission
  -> Renderer 的 1 秒状态轮询继续堆积
  -> 每个 thumbnail 完成事件继续触发独立 drag-cache Worker 请求
  -> 自动媒体 pump 继续竞争同一 Worker/SQLite/CPU/文件 I/O
  -> 本地预览缓存因缺少独立媒体描述符，仍无法绕过 owner
```

完成不能只以“点击不再假死”或“首屏先改选中态”为准。必须证明：导航读可脱离忙碌写 owner 返回；热预览缓存可脱离 owner 路径查询真实解码；对账与状态查询队列有界；磁盘/数据库最终仍正确收敛。

## 2. 当前实例证据（已脱敏）

本次只读诊断对象是本地 NVMe 上的活动资源库，不是 NAS，因此以下瓶颈不能归因于网络盘：

| 指标 | 当前事实 |
| --- | ---: |
| 有效资产 | 约 28,972 |
| 资产总字节 | 约 23.27 GB |
| `library.db` | 约 168 MiB |
| artifact 文件 | 约 83,576 |
| 打开后台对账占用 | 约 28.9 秒 |
| `media.get-artifact-paths` 最长排队 | 约 28.31 秒 |
| 堵塞期间 Worker 队列峰值 | 至少 140 |

热缓存下的只读诊断测量：

| 操作 | 数量 | 耗时 |
| --- | ---: | ---: |
| 源目录顺序枚举并逐文件 `lstat` | 28,972 | 约 3.4 秒 |
| artifact 目录顺序枚举并逐文件 `lstat` | 83,576 | 约 11.1 秒 |
| artifact 目录只枚举名称 | 83,576 | 约 0.123 秒 |

这些是当前机器上的诊断样本，不是跨平台性能结论。冷缓存、Windows Defender 和 SMB 的放大必须分别实测，不能由本地热缓存结果外推。

数据库同时存在 1,335 个排队中的当前 revision 缩略图任务，其中 1,311 个已经有 ready thumbnail artifact。它不解释已有预览的 28 秒等待，但证明任务队列与产物真相存在收敛漂移，会继续制造无效后台活动。

### 2.1 约 2,000 个后台任务的当前会话对照

用户在同一实例中完成了自然对照：后台任务运行时，文件夹切换到预览可见接近一分钟；暂停全部任务后，同类切换未超过 0.5 秒。当前 session log 的脱敏时间线提供了以下后端证据：

| 阶段 | 唯一 active owner | background 队列变化 | 最长已观测等待 |
| --- | --- | ---: | ---: |
| 第一轮 stall | `maintenance reconciliation`，持续约 24.7 秒 | 23 → 166 | `media.get-artifact-paths` 约 24.1 秒 |
| 第二轮 stall | `maintenance reconciliation`，持续约 23.4 秒 | 26 → 96 | `media.get-artifact-paths` 约 22.8 秒 |

第一轮另有 Worker 请求超时以及有效迟到响应被忽略。队列包含 `media.get-artifact-paths`、`media.list-jobs`、`ai.status`、`plugin.jobs.list` 和维护轮询。任务面板打开时，Renderer 的常驻轮询与面板轮询会同时每秒发出媒体、AI、插件三类请求；上一轮未完成时仍会继续入队。

日志也记录了媒体任务中断，但同一诊断同时覆盖 abort、pause 与 cancel，不能据此反推用户点击暂停的精确时刻。当前持久日志没有 `browse.session.*`、暂停成功事件或完整 navigation span，因此：

- “接近一分钟”和“低于 0.5 秒”保留为用户现场实测，不伪装成日志直接测量。
- 日志独立证明的是二十多秒的 active maintenance、预览路径等待、请求超时与队列增长。
- 约 2,000 个持久任务不等于 2,000 个 Scheduler command；更准确的模型是少量活动解码持续占用资源，同时状态轮询、产物完成事件和路径查询不断制造跨进程与数据库 churn。
- 暂停通过一次批量状态更新并 cooperative-abort 少量活动解码，不需要逐条取消 2,000 次；暂停后迅速恢复强烈支持“共享资源竞争”这一因果方向。

## 3. 根因与优化方向

### 3.1 去除打开对账的文件系统 I/O 放大

`src/worker/library-service.ts` 的打开对账串行执行托管资产刷新、缺失 artifact 检查和孤儿 artifact 检查。

当前孤儿扫描先对每一个 artifact 路径执行 `lstat`，随后才检查该路径是否仍被数据库引用。当前实例几乎全部 artifact 都有有效引用，因此八万多次探针中的绝大多数在逻辑上可以提前排除。

优化必须同时解决：

- 在任何逐文件探针前，用规范化的引用集合排除确定仍有效的路径。
- 只对真正的孤儿候选或类型不确定条目执行 `lstat`；不能无界并行探针。
- 源文件刷新优先复用 watcher dirty scope、目录快照或可靠变更身份；完整扫描仍作为不可靠事件、手动刷新与恢复场景的最终收敛路径。
- 将阶段耗时、枚举数、`lstat` 数、候选孤儿数和 yield 间隔纳入结构化指标，区分 JS 长任务、系统调度饥饿和文件系统延迟。
- 保留安全删除、失败可见、异常恢复和临时文件清理纪律；不能以跳过验证换速度。

此方向是 PERF2-07 的窄前置工作，不替代按影响范围刷新和最终全库收敛。

### 3.2 对账让步必须归还调度许可

当前 `yieldReconciliation` 会让出 JS turn，也会等待交互空闲窗口，但外层 reconciliation promise 始终是 active maintenance。`InteractiveScheduler` 因此一直认为唯一 background admission 已占用，优先级更高的 `background-primary` 预览路径也无法运行。这是本次日志能够直接证明的优先级反转。

不能只继续缩短内部循环；必须改变调度所有权模型：

- 将 reconciliation 表达为可恢复 continuation，每个目录/数据库批次只持有一个有界时间片。
- 时间片完成后返回 `{ done, cursor }`，结束当前调度 promise 并归还 background admission；未完成 continuation 重新以 maintenance 优先级入队。
- 等待交互空闲时不持有 admission。`background-primary` 路径查询和有界状态读取可以在相邻 maintenance 时间片之间先运行。
- navigation generation 变化时，旧 continuation 在安全点停止；不得通过反复 abort→从头扫描制造新的 I/O 风暴。
- 每个时间片必须同时受最大连续占用时间与批量大小约束，记录真实占用、让步、重新入队和完成进度；后台仍须获得有限进展。

### 3.3 让状态更新有界，消除轮询积压

Renderer 当前对每个已打开资源库每秒并发查询媒体任务、AI 状态和插件任务；任务面板打开时还可能有第二组相同轮询。请求没有 single-flight、latest-wins 或基于活动状态的退避。

优化方向：

- 优先复用现有 Worker 事件，将任务变化作为增量状态源。
- 保留的兜底轮询必须按“库 + 查询种类”single-flight；上一轮未完成时不得再入队同类请求。
- 无活动任务、窗口隐藏、库正在切换或 owner 已知繁忙时退避；恢复时只做一次合并刷新。
- 对 `media.list-jobs`、`ai.status`、`plugin.jobs.list`、`history.status` 等读定义 latest-wins/coalescing 语义，过期响应不得覆盖新库或新 generation。
- 队列上限必须与堵塞时长无关；不能通过扩大 Worker 并发掩盖无限生产请求。

### 3.4 合并 thumbnail 完成后的拖拽缓存预热

Main 当前在每个 thumbnail ready/failed 事件后单独请求 `media.get-asset-drag-infos`。Renderer 的 RAF 批量只减少 UI 更新，没有合并 Main→Worker 请求；大量任务完成时，这条旁路会产生与完成事件同量级的额外请求。

- 复用现有 drag cache，在 Main 按 library、generation 和短时间窗去重合并。
- 优先当前可见资产或确有预热价值的集合；其余资产首次拖拽时按需补齐。
- pending 数、单批大小和每轮调用数必须有上限，不能把逐项请求改成一次无界大包。
- 切库、关闭库、窗口销毁与 generation 变化时清理旧 pending；迟到结果不得污染新库。

### 3.5 热预览缓存必须先于写 owner

当前 `serpent://preview` 先通过 `media.get-artifact-paths` 向 Worker 查询绝对路径和扩展名，再查本地主进程的 PreviewCache。写 owner 被对账占用时，缓存中已有字节也不能显示。

沿 PERF2-08 实施规范化媒体描述符：

- summary/read response 携带受控的 asset、revision、artifact、usage、MIME 与 library generation。
- Main 在 media fence 和授权有效时先定位本地缓存，热命中不访问 SQLite、不询问写 owner、不逐图远端 `stat`。
- miss 使用 single-flight，共享显示与落缓存的同一次源读取；临时文件校验后原子发布，取消与失败必须清理。
- revision 替换、资产删除、库关闭/切换后立即撤销旧授权；猜中 artifact ID 不能越权读取旧缓存。

### 3.6 导航读与写 owner 真正隔离

当前优先级只能改变尚未开始的请求，不能抢占已经运行的同步 SQLite 或维护工作。最终方向仍是 PERF2-02/03/04：

- 提取无扫描、无迁移、无物化副作用的共享 catalog read 核心。
- Main 将允许的浏览读直达独立只读 UtilityProcess；不强杀写 owner。
- BrowseSession 首屏不等待全范围 ID、精确 COUNT 或完整几何，后台按稳定版本有界补齐。
- A→B→C、双窗口、库关闭重开必须按 consumer 和 generation 隔离，旧结果不得上屏。

### 3.7 派生任务与 ready artifact 必须收敛

任务队列不能把“已有当前 revision 的 ready artifact”长期保留为待生成。需要从入队、认领和打开恢复三处建立同一 artifact-policy 判定：

- 唯一键和状态判定覆盖 asset、revision、用途与生成器版本。
- claim 前再次确认需求仍存在；已有合法 ready artifact 时将冗余 queued job 收敛，而不是启动解码。
- 清理必须保留失败诊断、历史和正在运行任务安全性，不直接删除用户资产或有效 artifact。
- 修复后重新打开资源库不会重建同一批冗余任务；持续浏览也不会 cancel→重建循环。

### 3.8 为前台交互保留资源预算

Scheduler 当前只决定命令何时开始，自动媒体 pump 还会与浏览共享 Worker 事件循环、SQLite connection、CPU、原生解码器和文件 I/O。只读进程是最终隔离，但在此之前也需要统一资源 governor：

- 文件夹导航、可见窗口变化和 viewer 请求建立 foreground epoch；epoch 内停止新的普通后台 claim，并将自动解码与文件 I/O 降到保留预算。
- 已开始工作只在明确安全点 cooperative-abort，避免把每次滚动变成失败、重试和重新入队风暴。
- 交互安静 0.5–1 秒后渐进恢复后台并发；按前台 p95 延迟反馈升降，不按积压数量盲目加并发。
- 前台预算覆盖数据库读取、artifact locator、文件读取和必要解码，不只覆盖 Scheduler lane。
- 后台必须有有限进展和最大饥饿保护；“每次切文件夹就暂停全部任务”只能作为诊断手段，不能成为产品算法。

## 4. 工单分解与依赖

本文先后新增七个窄工单：

| 工单 | 范围 | 与既有 PERF2 的关系 |
| --- | --- | --- |
| `Serpent-26f22b` | 对账探针去放大与阶段指标 | PERF2-07 的实现前置 |
| `Serpent-e97c00` | 任务状态事件化、single-flight 与有界兜底轮询 | `Serpent-52eed4` 的剩余根因；独立于只读进程先落地 |
| `Serpent-1de919` | ready artifact 与 queued 派生任务收敛 | PERF2-09 的队列正确性前置 |
| `Serpent-be29a9` | reconciliation 时间片归还 background admission | PERF2-07 的调度前置；直接消除本次优先级反转 |
| `Serpent-8ee170` | thumbnail 完成事件的 drag-cache 请求有界合并 | 可由 Luna High 独立实施的小边界 |
| `Serpent-217028` | 2,000 后台任务下的端到端 navigation span 与回放基准 | 前台资源预算的测量前置 |
| `Serpent-7ac453` | foreground epoch、资源保留与后台媒体自适应降载 | 依赖 `Serpent-217028` |

既有工单继续承担其原边界：

- `Serpent-6dc70b` / PERF2-02：共享纯读 catalog。
- `Serpent-0ecab5` / PERF2-03：独立只读 UtilityProcess 和真正抢占。
- `Serpent-078a15` / PERF2-04：两阶段 BrowseSession。
- `Serpent-777a14` / PERF2-07：按影响范围刷新和最终全库收敛。
- `Serpent-aea5b9` / PERF2-08：媒体描述符与本地缓存直达。
- `Serpent-312c29` / PERF2-09：元数据队列预算和维护事务预算。

建议实施顺序：先并行完成 `Serpent-e97c00`、`Serpent-8ee170` 和 `Serpent-217028`，停止请求放大并补齐因果测量；随后实施 `Serpent-be29a9`，让 maintenance 真正归还许可；基于同一回放结果实施 `Serpent-7ac453`。PERF2-02 → 03 → 04 继续承担最终导航读隔离，`Serpent-26f22b` 与 PERF2-07 降低对账总成本，PERF2-08 负责热预览绕过写 owner，`Serpent-1de919` 完成后再统一 PERF2-09 的后台预算。涉及 `LibraryService`、`App.tsx`、Main 入口时仍需串行文件所有权。

## 5. 自动化与验收矩阵

| 需求 | 自动化证据 | 人工/平台证据 |
| --- | --- | --- |
| 有效 artifact 不发生逐文件 `lstat` | 构造大量已引用 artifact，断言 probe 数接近真实孤儿候选数；目录/DB最终一致 | 本地冷/热实测；Windows Defender、SMB 分列 |
| reconciliation 中仍可导航 | 实际 barrier 阻塞写 owner，新文件夹由独立读路径先返回 | 真实 Electron 连续 A→B→C；不能只看选中态 |
| 热缓存绕过 owner | 阻塞 `media.get-artifact-paths`，完整重启后缓存图片仍 `complete && naturalWidth > 0` | 本地与 SMB；视频 Range 单列 |
| 状态请求有界 | 阻塞 owner 30 秒，逐类 pending/in-flight 数保持 O(1)，过期响应不跨库 | 任务面板开/关、窗口隐藏/恢复 |
| maintenance 让步归还许可 | barrier 阻塞一个 reconciliation 时间片，路径请求在片间先返回；continuation 最终完成 | 2,000 任务运行中连续切换文件夹 |
| thumbnail 事件请求有界 | 突发 2,000 个完成事件，drag-cache Worker 调用与 pending 保持有界 | 冷拖拽与热拖拽均可用 |
| 前台资源预算 | 同一 fixture 对比任务运行/暂停，记录 claim、decode、DB、I/O 与首图 p50/p95/max；无 timeout 和 abort 循环 | 本地、SMB、Windows 分列 |
| ready artifact 与 queued job 收敛 | 打开恢复、重复入队、claim 前竞态、生成器换版分别覆盖 | 大库任务数量和后台吞吐对照 |
| 切换首屏预算 | 首屏前无全范围 IDs/精确 COUNT；严格统计全部可见图片 | 本地 20k、真实 SMB、Windows/packaged 未跑则标未验证 |

任何资源库打开、对账、任务恢复或协议修改都必须完整运行 `npm run test:library-availability`。跨 Main/Worker/Renderer 和媒体协议修改必须运行真实 Electron E2E，使用隔离 userData，后台串行执行，并清理本次产物。最终大功能完成后按仓库规则由一个独立审查 agent 同时做 Standards 与 Spec 双轴审查；用户本人确认前不得把 UI 条目标为人类验收通过。

## 6. 禁止的替代方案

- 不以增加超时、扩大缓存或提前显示选中态宣称性能问题完成。
- 不无界并行 `stat`/`lstat`，避免把串行延迟改成磁盘、SMB 或 libuv 风暴。
- 不让 Main 打开资源库数据库，不复制第二套有写能力的 LibraryService。
- 不取消最终对账、损坏检测、恢复或可写性安全边界。
- 不通过删除测试、跳过全可见图片或只统计已挂载 `<img>` 使门槛变绿。
- 不用清空所有派生任务或 artifact 的方式掩盖队列状态漂移。
- 不把 `media.get-artifact-paths` 简单塞回现有 interactive lane；网络路径解析可能重新占住唯一交互许可。
- 不把提高 Worker timeout、无界增加解码并发或“导航时暂停全部任务”当作正式优化。
