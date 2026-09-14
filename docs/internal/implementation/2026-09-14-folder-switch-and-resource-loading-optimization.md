# 2026-09-14 文件夹切换与资源加载性能优化方向

> 状态：第三轮 CPU profile、真实库只读 SQL A/B 与当前实例日志复核完成；第二轮未提交实现已被证伪，禁止按原方案提交。
> 父计划：`Serpent-e9a66b`（交互性能第二阶段）。
> 直接用户问题：`Serpent-52eed4`（切换仍慢，但不再吞操作）。
> 本文补充既有 [`2026-09-13-interactive-performance-design.md`](2026-09-13-interactive-performance-design.md)，不取代其只读进程、NAS 快照、两阶段 BrowseSession 与媒体描述符设计。

> 2026-09-14 第三轮纠偏：此前把问题概括为「后台许可被 reconciliation 长占」仍不够准确。新的端到端时间线证明，浏览 SQL 已返回后，Main 还会在向 Renderer 返回结果之前同步等待 `media.get-asset-drag-infos`；该请求又被降级到 background-primary，因此会在 reconciliation 后等待约一分钟。这是一次由“把辅助预热降级为后台”引入的关键路径优先级反转。与此同时，任务状态协调器虽然限制了 in-flight 数，却仍在每个媒体完成事件后重查完整任务列表，形成 2.71 次/秒、累计占用 Worker 约 206 秒的查询风暴。后续必须先消除这两条自制造负载，再决定是否启动独立只读进程等大改造。

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

### 2.2 第三轮 profile：真正的关键路径与查询热区

第三轮重新读取完整 Worker CPU profile、逐条核对同会话 `worker.cmd`，并在当前真实库上做只读 `EXPLAIN QUERY PLAN`；随后把数据库备份到一次性临时副本，只在副本上测试候选索引。临时副本和诊断脚本在测量后已清理，未修改用户资源库。

该样本约有 43,938 个资产、89,580 条历史任务，其中媒体任务 74,496 条；61,414 条已成功，仍有 9,667 条排队与 1,691 条暂停。344 秒 profile 的主要结果如下：

| 调用/阶段 | 次数或耗时 | 结论 |
| --- | ---: | --- |
| `media.list-jobs` | 933 次，2.71 次/秒 | single-flight 只限制同时在飞，并未限制媒体完成事件后的重新查询 |
| `media.list-jobs` Worker 执行 | 累计 206.4 秒，平均 221 ms，最大 367 ms | 占据 profile 的主要时间 |
| `better-sqlite3 all()` → `listMediaJobs` | 自耗约 204.7 秒 | 最大 SQL 热区的确切业务调用，不是 browse 查询 |
| `all()` → RAW metadata admission | 自耗约 22.6 秒 | 每轮 secondary pump 都会重新寻找候选，空结果也重复扫描 |
| `lstat` → 打开对账 | 约 14.7 秒 | 仍是次级文件系统热区，但不是本次第一热区 |
| Renderer | 约 72% idle；滚动无 long task | 前端计算与滚动绘制不是一分钟等待的主因 |

`listMediaJobs` 每次执行两条 SQL：一条按状态计数，一条取最近 500 条；两条都会关联资产，并对每条任务执行显式忽略与 `.gitignore` 的相关子查询。真实库只读计时与临时副本 A/B：

| 查询 | 当前中位数 | 去掉资产可见性重算 | 候选索引后 |
| --- | ---: | ---: | ---: |
| 状态计数 | 约 142.2 ms | 约 42.3 ms | 约 133.1 ms |
| 最近 500 条 | 约 166.6 ms | 约 52.8 ms | 约 1.0 ms |

运行计划显示当前最近列表使用 `jobs_library_status_priority` 后仍建立临时 B-tree 排序；增加 `(library_id, created_at DESC, job_id DESC)` 后该部分可降到约 1 ms。计数几乎不受普通索引改善，证明其算法问题是反复遍历约 7.4 万历史任务并重新计算资产可见性，而不只是“缺一个索引”。

更关键的是端到端链路：一次 `browse.session.open` 在约 1.206 秒内完成 Worker 往返，但 Main 在把结果交给 Renderer 前调用并 `await` 首屏 64 项的 `media.get-asset-drag-infos`。同一时段 reconciliation 作为 maintenance owner 连续运行至少 66.3 秒；两个 background-primary 拖拽预热请求分别等待约 65 秒以上，命令记录的 scheduler wait 约 67.8–68.0 秒。因此浏览 SQL 已完成，旧卡片却仍在屏幕上，直到辅助拖拽预热结束。这条隐藏在 Worker roundtrip 之后的 Main 后处理正是“命令很快、内容一分钟不换”的直接解释。

当前实例的另一段日志独立复现了相同结构：同一 reconciliation owner 连续活跃至少 37.8 秒，等待队列从 8 项增长到 34 项。它证明长 maintenance owner 仍存在，但不应再把所有可见延迟笼统归因于 reconciliation；真正的错误是把一个被同步 `await` 的关键路径子请求标成后台任务。

### 2.3 现有 profiler 判据的有效与无效部分

现有 `navigation-profile.test.ts` 的 CPU profile 与命令时间线有效，但页面判据仍有三个假阴性来源：

1. 它按 DOM 顺序点击任意 `.nav-row`，没有限定为非空、内容不同的文件夹/合集，也没有先确认目标行已经成为 active scope。
2. `waitForContentChange` 要求新卡片数大于零，所以正确切到空文件夹也会被记成 60 秒超时。
3. 文件夹循环结束后没有恢复到可滚动的大 scope；随机跳转可能在空或很小的 scope 上执行，并且图片覆盖率可能仍统计旧卡片。

因此“3/4 文件夹、3/3 跳转超时”不能整体当作产品耗时分布；报告还把 timeout 常量写进 timing，容易伪装成真实观测值。但上述约 68 秒的 `browse → Main drag prime → Renderer` 链路由独立命令时间线和 scheduler stall 直接证明，至少一个一分钟级卡顿不是测试假象。基准必须修正后再承担最终 A/B 判定。

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

### 3.3 拆分任务摘要与任务列表，完成事件不得触发全表重查

第二轮 `JobStatusCoordinator` 的 single-flight/coalesce 只解决“堵住时无限积压”，没有解决“上一轮很快结束后，下一条完成事件立即再查”。缩略图与尺寸完成事件密集时，`noteActivity("media")` 仍会直接调用同时包含全量计数和最近 500 行的 `media.list-jobs`，所以测得 2.71 次/秒和 206 秒累计执行。

新的算法边界：

- 拆成 `media.job-summary` 与分页 `media.list-jobs`。常驻状态栏只消费摘要；任务面板打开时才拉最近页，滚动时使用 cursor 分页。
- 媒体完成事件携带或驱动 O(1) 的状态增量，不能把“事件是主源”实现成“事件触发全量回源”。面板关闭且没有人工控制动作时，浏览旅程中的 `media.list-jobs` 请求数目标为零。
- 第一阶段允许开库后异步重建一次摘要，但必须晚于首屏；最终可用事务内计数表或 Worker 内存计数 + 崩溃后一次重建保证一致。忽略规则变化应批量修正摘要，不能在每次读取时对 7.4 万任务重新执行资产可见性子查询。
- 最近列表增加与排序匹配的索引；临时副本已证明该查询可从约 166.6 ms 降到约 1 ms。索引只解决列表页，不得把它当成计数问题已解决。
- 面板打开时最多按低频摘要兜底，上一轮未完成不补发；暂停/恢复/取消成功后主动应用命令回执，再做一次合并校准。窗口隐藏、切库与 generation 变化清理旧状态。
- 新指标分开记录“事件数、摘要增量数、摘要重建数、列表页请求数”，禁止再用合并数掩盖高频成功查询。

### 3.4 从浏览关键路径移除拖拽预热，禁止全结果后台预热

第二轮把每个完成事件改为 500 项分批、每库最多 20,000 项，虽然把逐事件请求降为 304 次，但仍在一个纯浏览 profile 中产生 304 个 `media.get-asset-drag-infos`。更严重的是，首屏 64 项仍在 Main 返回浏览结果前同步 `await`，而同一命令被归类为 background-primary；这直接制造了约 68 秒的优先级反转。

新的算法边界：

- `browse.session.open/page` 的 Worker 结果一旦返回，Main 不得再等待任何拖拽缓存请求才能交给 Renderer。端到端 span 必须显式记录 Worker 返回、Main 后处理和 Renderer 收到三个阶段。
- 首选方案是在 Worker 构造首屏结果时，同时携带只供 Main 消费的受控拖拽描述符；Main 缓存后剥离，Renderer 仍不接收绝对路径。这样不需要第二个 Worker 请求，也不破坏安全边界。
- 若协议包络暂时不能携带 Main-only 数据，则浏览结果先返回；只对当前可见卡片或明确的 pointer/drag intent 做异步预热。不能为了极低概率的“卡片出现后立即拖出”而阻塞所有文件夹切换。
- 删除“剩余全部结果后台预热”。虚拟化滚动到新窗口时最多按当前可见窗口补齐；缩略图 ready/failed 不改变源路径，不应触发拖拽路径重新解析。只有 move/rename/relink/revision/library generation 等真正影响描述符的事件才失效或更新缓存。
- 若同一底层查询同时存在关键路径与后台预取用途，必须使用不同命令语义/车道或显式请求意图；禁止用一个静态 lane 同时承担二者。
- 验收基线：不发生 pointer/drag intent 的纯浏览旅程，`media.get-asset-drag-infos` 为 0（采用 Main-only 包络时）或严格受可见窗口数约束；浏览响应的 Main 后处理不超过 50 ms；拖拽冷、热路径继续可用。

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

### 3.9 RAW metadata admission 采用可失效游标，禁止每轮空结果重扫

CPU profile 中第二个 `all()` 热区来自 `enqueueRawImageMetadataBackfill`。当前真实库有约 2,202 个 RAW 资产；一次候选查询当前约 94 ms，但 secondary media pump 每轮都先调用它，已经处理完的库仍重复执行扩展名后缀扫描、多个 jobs/artifact 反连接和忽略规则子查询，累计约 22.6 秒。

- 为每库、generation 维护 RAW metadata admission cursor 与 `exhausted` 状态；扫描到尾后不再重查，只有新增 RAW、revision 变化、用户 retry 或相关忽略规则变化才精确失效。
- 资产入库时已经知道扩展名/媒体类型，应持久化规范化分类并建立候选索引，避免每轮对 `LOWER(relative_file_path) LIKE '%后缀'` 做全资产扫描。迁移必须兼容旧库并后台分批回填。
- 活跃/成功/失败状态应由一条可索引的唯一 admission policy 查询表达，避免同一 asset/revision 对 jobs 表执行三组相关反连接；claim 前仍做最终防竞态校验。
- 每轮只读取游标后的有界候选，时间片同时受条数和连续执行毫秒预算约束；空结果后不得靠定时器不断从头再扫。
- 临时实验中简单建立 RAW id 临时表反而使查询更慢，不能照搬；正式方案必须以 `EXPLAIN QUERY PLAN` 和 20k/真实库 A/B 证明选中索引与扫描行数。

## 4. 工单分解与依赖

本文先后新增八个窄工单：

| 工单 | 范围 | 与既有 PERF2 的关系 |
| --- | --- | --- |
| `Serpent-26f22b` | 对账探针去放大与阶段指标 | PERF2-07 的实现前置 |
| `Serpent-e97c00` | 任务摘要/列表拆分、增量状态与面板按需分页 | 原 single-flight 实现已证伪，需按 §3.3 重做 |
| `Serpent-1de919` | ready artifact 与 queued 派生任务收敛 | PERF2-09 的队列正确性前置 |
| `Serpent-be29a9` | reconciliation continuation 真正归还 background admission | 原批次 yield 只让交互/写抢占，仍需完成 continuation；排在关键路径修正之后 |
| `Serpent-8ee170` | 从浏览关键路径移除 drag prime，取消全结果预热 | 原“分批合并”方案制造约 68 秒优先级反转，需按 §3.4 重做 |
| `Serpent-217028` | 修正 profiler 判据与 Main 后处理端到端 span | 所有优化 A/B 的最高优先级前置 |
| `Serpent-288cd9` | RAW metadata admission 游标/exhaustion 与可索引分类 | PERF2-09 的独立前置；消除累计 22.6 秒空结果重扫 |
| `Serpent-7ac453` | foreground epoch、资源保留与后台媒体自适应降载 | 依赖 `Serpent-217028` |

既有工单继续承担其原边界：

- `Serpent-6dc70b` / PERF2-02：共享纯读 catalog。
- `Serpent-0ecab5` / PERF2-03：独立只读 UtilityProcess 和真正抢占。
- `Serpent-078a15` / PERF2-04：两阶段 BrowseSession。
- `Serpent-777a14` / PERF2-07：按影响范围刷新和最终全库收敛。
- `Serpent-aea5b9` / PERF2-08：媒体描述符与本地缓存直达。
- `Serpent-312c29` / PERF2-09：元数据队列预算和维护事务预算。

新的顺序禁止并行抢跑：

1. **PERF2-P0A / `Serpent-217028`**：先修正 profile 判据并加入 Renderer → Main → Worker → Main 后处理 → Renderer commit 的相关 span。timeout 作为失败状态单列，不写成耗时样本。
2. **PERF2-P0B / `Serpent-8ee170`**：移除同步 drag prime 与全结果后台预热；以同一真实库证明一分钟尾延迟消失。
3. **PERF2-P0C / `Serpent-e97c00`**：拆分摘要/列表，关闭面板时停止完整任务列表查询；为最近页加排序索引，再证明 344 秒旅程中不再出现 933 次重查。
4. **PERF2-P0D / `Serpent-288cd9`**：加入 RAW admission cursor/exhaustion 与可索引分类，清掉累计 22.6 秒的空结果扫描；完成后再并入 `Serpent-312c29` 的整体元数据预算。
5. **PERF2-P1 / `Serpent-be29a9`、`Serpent-26f22b`、`Serpent-777a14`**：再把 reconciliation 改成真正返回/重新入队的 continuation，并收口 `lstat` 放大。
6. **重新决策架构升级**：只有完成 P0/P1 A/B 后，才依据剩余的 browse/preview profile 决定是否继续 `Serpent-6dc70b` → `Serpent-0ecab5` → `Serpent-078a15` 的独立只读进程路线。独立进程无法修复 Main 自己等待后台 drag prime，也无法消除 Renderer 主动制造的查询风暴，当前不得把它当作默认下一步。

`Serpent-7ac453` 的前台资源预算在上述自制造负载清除后再调参；否则 governor 会把错误请求模式隐藏成限流问题。PERF2-08 继续负责热预览绕过写 owner，`Serpent-1de919` 负责 ready artifact 收敛。涉及 `LibraryService`、`App.tsx`、Main 入口时仍需串行文件所有权。

## 5. 自动化与验收矩阵

| 需求 | 自动化证据 | 人工/平台证据 |
| --- | --- | --- |
| 有效 artifact 不发生逐文件 `lstat` | 构造大量已引用 artifact，断言 probe 数接近真实孤儿候选数；目录/DB最终一致 | 本地冷/热实测；Windows Defender、SMB 分列 |
| reconciliation 中仍可导航 | 实际 barrier 阻塞写 owner，新文件夹由独立读路径先返回 | 真实 Electron 连续 A→B→C；不能只看选中态 |
| 热缓存绕过 owner | 阻塞 `media.get-artifact-paths`，完整重启后缓存图片仍 `complete && naturalWidth > 0` | 本地与 SMB；视频 Range 单列 |
| 状态请求不制造负载 | 面板关闭的浏览旅程 `media.list-jobs=0`；2,000 完成事件只产生 O(1) 摘要增量；最近页命中排序索引 | 任务面板开/关、窗口隐藏/恢复，计数最终一致 |
| maintenance 让步归还许可 | barrier 阻塞一个 reconciliation 时间片，路径请求在片间先返回；continuation 最终完成 | 2,000 任务运行中连续切换文件夹 |
| drag prime 不阻塞浏览 | browse Worker 返回后 Main 后处理 <50 ms；无拖拽意图时 drag-info 请求为 0 或严格限于可见窗口 | 冷拖拽与热拖拽均可用，快速出现后立即拖拽单列 |
| 前台资源预算 | 同一 fixture 对比任务运行/暂停，记录 claim、decode、DB、I/O 与首图 p50/p95/max；无 timeout 和 abort 循环 | 本地、SMB、Windows 分列 |
| ready artifact 与 queued job 收敛 | 打开恢复、重复入队、claim 前竞态、生成器换版分别覆盖 | 大库任务数量和后台吞吐对照 |
| RAW admission 不重扫 | exhausted 后连续 100 个 secondary turn 不再执行候选全扫；新增/换 revision 精确失效 | 大 RAW 库后台吞吐与 Inspector 最终一致 |
| 切换首屏预算 | 只选择已确认非空且内容不同的 scope；scope active、目标 generation 首卡、90%/100% 解码分段记录；任何 timeout 直接失败 | 本地 20k、真实库任务运行/暂停同场 A/B、SMB、Windows/packaged 未跑则标未验证 |

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
- 不在向 Renderer 返回浏览结果前 `await` 任何标为 background 的辅助预热；静态 lane 不得掩盖调用点的真实关键路径语义。
- 不把“事件到达后立即全量查询”称为事件化，也不以 single-flight 证明查询频率已经有界。
- 不把 30/60 秒 timeout 常量写进 p50/p95；timeout 必须作为失败计数并使性能验收失败。
