# Mac 单机定时调度机制调研

日期：2026-09-12  
范围：比较“launchd 只监督一个常驻 Beacon Service，由 Service 内部调度”与“每个定时任务对应一个 launchd job”。本结论只针对单台常驻 Mac 的 MVP。

## 结论

MVP 应采用：**一个 launchd job 监督 Beacon Service，所有业务定时任务由 Service 内部调度并持久化。**

launchd 负责它擅长的进程生命周期：启动 Beacon、Beacon 异常退出后重新拉起、收集 stdout/stderr。Beacon 负责它拥有语义的工作：解析 Profile 的 schedule、生成一次逻辑触发、去重/追踪 Run、调用与飞书消息相同的 Agent 执行管线，并把最终成功或失败结果主动发送到配置的飞书会话。

不要为每条业务 schedule 生成一个 launchd plist。多个 launchd job 技术上可行，但会把 Profile、目标会话、触发规则和任务指令拆到 OS 配置与 Beacon 配置两处；还必须额外提供 CLI/IPC 入口将 job 重新送回 Beacon。它没有减少核心复杂度，反而让变更、重载、失败追踪和去重跨越两个控制面。

## 官方机制与实测事实

Apple 的 `launchd.plist(5)`（本机 macOS 15.7.1）说明：

- `KeepAlive=true` 会要求 job 持续运行；频繁退出会被节流。`KeepAlive.SuccessfulExit=false` 会在非零退出后重启，并隐含 `RunAtLoad`。
- launchd 默认不会在 10 秒内反复 spawn；可用 `ThrottleInterval` 调整。生产配置应保留合理退避，避免 Beacon 配置错误时形成 crash loop。
- `StartInterval=N` 每 N 秒触发，但机器睡眠时的触发会漏掉；前一次仍在运行时的触发也会漏掉。
- `StartCalendarInterval` 类似 cron；缺少的字段是通配符，也可用字典数组表达多个日历时间。
- `StartCalendarInterval` 在机器睡眠时错过的触发会在唤醒后执行；睡眠中错过多次只合并为一次。机器关机期间错过的执行不会补发，而要等下一个计划时刻。
- `StartInterval` 与 `StartCalendarInterval` 相互独立；同时配置会形成两个独立触发源，而不是一个统一 schedule。

Apple 的《Scheduling Timed Jobs》同样明确：launchd 是 macOS 首选定时机制；`StartCalendarInterval` 可在睡眠唤醒后补一次，而关机错过不会补。参见：

- [Apple: Scheduling Timed Jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/ScheduledJobs.html)
- [Apple: Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

### 最小实验

实验均在 macOS 15.7.1（Build 24G231）当前用户的 `gui/501` launchd domain 中以唯一 label 临时加载，结束后均已 `bootout`，未安装持久 job。

1. **异常退出重启**：临时 job 使用 `KeepAlive.SuccessfulExit=false`、`ThrottleInterval=1`。脚本前两次以 23 退出，第三次以 0 退出。launchd 在约 1 秒间隔内共运行 3 次，第三次成功后停止；`launchctl print` 显示 `runs = 3`、`last exit code = 0`。

   ```text
   1 start=2026-09-12T04:15:23Z pid=15365
   2 start=2026-09-12T04:15:24Z pid=15373
   3 start=2026-09-12T04:15:25Z pid=16099
   ```

2. **运行中触发不重叠**：临时 job 配置 `StartInterval=2`，脚本每次运行 4 秒。观察到同一 label 没有并发实例；运行期间的 2 秒触发被漏掉，进程结束约 2 秒后才开始下一次，符合手册。

   ```text
   start 2026-09-12T04:15:51Z pid=21208
   end   2026-09-12T04:15:55Z pid=21208
   start 2026-09-12T04:15:57Z pid=22367
   end   2026-09-12T04:16:01Z pid=22367
   start 2026-09-12T04:16:03Z pid=22422
   ```

3. **配置校验**：两份实验 plist 均通过 `plutil -lint`。launchd 的默认环境中 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`，说明生产 job 必须使用 Beacon 可执行文件的绝对路径，并显式配置必需环境/配置文件位置；不能依赖交互 shell。

未通过等待真实睡眠周期重复验证 sleep/wake；该项直接采用 Apple 文档与本机 `launchd.plist(5)` 的一致描述。

## 两种方案比较

| 维度 | 单 launchd supervisor + Service 内调度 | 多个 launchd 定时 job |
|---|---|---|
| 配置归属 | Profile/schedule/投递目标均由 Beacon 管理，一个真相源 | 每个 schedule 还需生成、安装、重载 plist；OS 与 Beacon 双重配置 |
| 异常退出 | launchd 重启 Beacon；Beacon 启动时从持久状态对账 | 单次 runner 由 launchd 启动；若 runner 只负责请求 Beacon，则 Beacon 不可用时仍需另行重试/记录 |
| 睡眠/唤醒 | Beacon 唤醒后的下一次 tick 扫描 overdue，可定义清晰的补跑策略 | `StartCalendarInterval` 自动补一次并合并多个错过；`StartInterval` 直接漏掉 |
| 关机/停服错过 | 启动对账可按产品策略补跑 | launchd 不补关机期间错过的日历任务 |
| 重叠与并发 | 可统一使用 Beacon 并发限制；不同 schedule 可并发，单 schedule 可选择禁止重叠 | 同一 job 的运行中 interval 会漏掉；不同 plist 彼此独立并发，需另建全局限流 |
| 去重/审计 | schedule occurrence 与 Run 记录在同一存储中，可用唯一键原子 claim | launchd 不提供业务级 exactly-once；仍需 Beacon 侧做去重和 Run 记录 |
| 飞书主动投递 | 与消息触发共用 `Trigger -> Agent Run -> final result -> Feishu delivery` 管线 | job 必须执行 Beacon CLI、调用本地 IPC，或重复初始化 Gateway/凭证；多一层故障点 |
| 变更运维 | 改 Beacon 配置/数据即可，可实现热加载或一次 Service 重启 | 增删改需同步文件并 `bootstrap`/`bootout`，还要处理 label、路径、权限和残留 job |

## 推荐的 MVP 调度契约

### 1. launchd 的职责

- 只安装一个 Beacon job；用 `KeepAlive=true`（或等价的明确重启条件）保持 Service 常驻。
- 使用绝对可执行路径、明确的工作目录/配置路径，并把 stdout/stderr 写到固定日志位置。
- 保留 launchd 默认或合理的 `ThrottleInterval`，让持续启动失败可观察，而不是高速重启。
- launchd job 是 Service supervisor，不携带任何 Profile schedule、飞书 chat ID 或 Agent prompt。

LaunchAgent 还是 LaunchDaemon、凭证如何注入属于部署身份选择，不影响本次调度结论；但实现不能假设交互 shell 环境。

### 2. Service 内的持久化状态

每个 schedule 至少保存：`schedule_id`、规则及时区、启用状态、目标 `profile_id`、主动投递目标、`next_due_at`。每个逻辑触发生成稳定 occurrence key，例如 `(schedule_id, scheduled_at)`，并在 Run 表上加唯一约束。

领取到期任务与创建 Run 记录必须在同一事务中完成。这样 Service 的多个 tick 或重启对账不会为同一 occurrence 启动两个 Pi Run。MVP 即使只有一个进程，也值得保留这一不变量，因为崩溃/唤醒最容易暴露重复。

### 3. missed schedule 策略

- 每次启动及固定短周期 tick 都扫描 `next_due_at <= now`，因此睡眠、Beacon 重启和 Mac 重启使用同一恢复路径。
- 对同一 schedule 错过多个时刻时，MVP **合并为一次补跑**，并以最新已到期的计划时刻作为 occurrence；随后把 `next_due_at` 推进到未来。每日情报类任务无需在唤醒后连发多份过期报告，这也与 launchd 的日历 coalescing 行为一致。
- 在 Run 中记录 `scheduled_at` 与实际 `started_at`，以便看出补跑延迟。
- 如果未来出现“每个时刻都必须执行”的业务，应作为显式 per-schedule policy 新增，而不是改变默认行为。

### 4. crash、重复与不确定执行

- launchd 只保证进程被重新拉起，不保证 Agent 业务 exactly-once。
- Beacon 启动时把遗留的 `running` Run 标记为 `interrupted/failed`，并通过其配置的飞书目标发送明确失败结果。
- 对已启动 Pi 的遗留 Run，MVP 不自动重跑。崩溃可能发生在 Agent 已创建 PR、但 Beacon 尚未来得及写完成状态的窗口；自动重跑会扩大副作用。唯一 occurrence key 阻止其被调度器再次领取。
- 若崩溃发生在飞书发送成功与“发送成功”落库之间，仍存在重复发送或漏发二选一的不可消除窗口。MVP 应记录 delivery attempt/error，允许排查，不宣称 exactly-once。未来可在飞书 API 支持幂等键时收紧。

### 5. 复用同一执行与投递管线

定时器只创建一种通用触发对象，不直接启动 Pi 或调用飞书：

```text
in-process scheduler
  -> ScheduledTrigger(profile_id, schedule_id, scheduled_at, destination)
  -> durable Run claim
  -> existing Agent executor (new Pi run)
  -> final success | failure
  -> existing Feishu outbound sender(destination)
  -> delivery status on Run
```

飞书消息触发与 ScheduledTrigger 在进入 Run 之后走同一条执行路径。差别只在来源元数据与回复目标：消息触发回复原会话/消息，定时触发使用 schedule 配置的主动投递会话。

## Feasibility gate

此方案在 macOS/launchd 层面可行，且能满足 MVP 的单机、异常恢复、睡眠后补一次、并发 Pi Run、运行记录和主动飞书投递边界。实现规格仍需明确 schedule 表达式/时区格式、存储实现、tick 间隔与 stale Run 判定阈值，但这些不改变“launchd 只监督 Service、Service 内部调度”的选择。
