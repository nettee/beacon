# Beacon MVP Schedule 表达格式与 Node 调度库调研

调研日期：2026-09-12

## 结论

Beacon MVP 使用**严格的 5 字段 cron + 必填 IANA 时区**，不支持可选秒字段，也不同时提供 `daily` / `interval` 结构化语法：

```text
id: daily-model-intelligence
cron: "0 9 * * *"
timezone: "Asia/Shanghai"
prompt: <schedule prompt 或 prompt 引用；由配置格式票决定>
destination: <飞书主动投递目标；由飞书实验票决定>
```

表达式字段固定为 `minute hour day-of-month month day-of-week`。Beacon 仅接受数字和 `* , - /` 组成的表达式；不接受第六个 seconds 字段、`@daily` nickname，以及 `? L W # H` 等扩展。若 day-of-month 与 day-of-week 都不是 `*`，拒绝配置，避免不同 cron 实现的 AND/OR 语义分歧。

使用 [`cron-parser`](https://github.com/harrisiirak/cron-parser) 作为**纯 occurrence calculator**，不直接使用调度库的内存 timer：Beacon 将 5 字段表达式前置 `0`，以 `strict: true` 解析为 6 字段，再从显式的 `afterExclusive` 计算下一次或一段窗口内的 occurrences。这样重启、睡眠唤醒和 missed-run 对账走同一条确定性路径。

```ts
type CronSchedule = {
  id: string;
  cron: string;       // exactly five fields
  timezone: string;   // required IANA zone
};

interface OccurrenceCalculator {
  next(schedule: CronSchedule, afterExclusive: Date): Date;
  between(
    schedule: CronSchedule,
    afterExclusive: Date,
    throughInclusive: Date,
    limit: number,
  ): Date[];
}
```

`limit` 必须存在，避免坏配置或长期离线造成无界枚举。如何处理多个 missed occurrences（全部执行、合并或只执行最近一次）是 Run 编排策略，不属于 cron 表达格式；计算层必须能如实列出窗口中的 occurrences。

## 为什么是窄 5 字段 cron

| 方案 | 优点 | MVP 问题 | 结论 |
|---|---|---|---|
| 标准 5 字段 cron | 一个字段覆盖每日、每周、每月与分钟级周期；运维人员熟悉；当前每日 09:00 直接表达 | 需要严格限制扩展和 DOM/DOW 歧义 | 采用 |
| 5/6 字段、秒可选 | 某些 Node 库原生支持；测试时可快速触发 | 同一个首字段可能是 minute 或 second；秒级任务不是需求，还会扩大 wake/reconcile 压力 | 拒绝第六字段 |
| `dailyAt` / `interval` 结构化 union | 每日场景直观，schema 可生成好错误 | 两套语义和实现；需求一扩展就继续增加 weekday/monthly 等 variant；elapsed interval 与 calendar schedule 的 DST、重启补偿不同 | MVP 不采用；未来 interval 应作为另一 trigger kind，而不是伪装成 cron |

Cron 对当前需求实际上比 structured union 更窄：一个必填 `cron` 加一个必填 `timezone` 即可。这里所谓“cron”是 Beacon 自己定义的受限方言，不接受各库额外扩展。

## 库比较

在隔离 worktree 中固定并运行：`cron-parser@5.10.0`、`croner@10.0.1`、`node-cron@4.6.0`。三者在调研时均为近期发布版本，均自带 TypeScript types；前两者支持 Node >=18，`node-cron@4.6.0` 要求 Node >=20。

| 能力 | cron-parser 5.10 | Croner 10.0.1 | node-cron 4.6 |
|---|---|---|---|
| 定位 | parser / iterator | parser + timer | scheduler + timer |
| 从任意参考时刻计算 future occurrences | `currentDate` + `next()/take()`，纯 API | `nextRun(s)(..., startFromDate)` | task 有 `getNextRun(s)`，但公开 API 不接收任意 reference date |
| 严格解析 | `strict: true`：完整 6 字段、空表达式、DOM/DOW 冲突等 | 构造时校验，但无等价 strict 模式 | `validateDetailed`；调度 API 仍面向活 timer |
| IANA timezone | `tz`，基于 Luxon | `timezone` | `timezone` |
| 确定性测试 | 直接注入 `currentDate`，不依赖系统时钟 | occurrence API 可注入 start date | 对 task API 测 arbitrary window 需要 fake clock 或内部 API |
| 依赖 / 模块 | Luxon 1 个依赖；CommonJS，带 types | 0 依赖；ESM/CJS，带 types | 0 依赖；ESM，带 types |
| 适合 Beacon 的 missed-run 对账 | 最合适 | 可行，但 timer/parser 混在同一抽象且 strict 较弱 | 不选；强项是在线 timer、overlap 与分布式协调，Beacon 不需要 |

选择 `cron-parser` 的核心原因不是包更小，而是它把“从已持久化 cursor 到当前时刻枚举发生点”作为一等 API。Beacon 自己负责等待下一次到期、原子写文件状态和触发 Run，避免库的内存任务状态成为第二事实源。

## 实验结果

可复现实验：[schedule-format-experiment.mjs](./schedule-format-experiment.mjs)。

### 每日模型情报

`0 9 * * *`、`Asia/Shanghai`，从 `2026-09-12T00:30:00Z` 开始的三个发生点：

```text
2026-09-12T01:00:00.000Z  // 09:00 CST
2026-09-13T01:00:00.000Z
2026-09-14T01:00:00.000Z
```

假设 Beacon 从 `2026-09-10T01:00:00Z` 的 cursor 恢复，并在 `2026-09-12T02:00:00Z` 对账，纯 iterator 能枚举两次 missed occurrences：9 月 11、12 日各一次。这不依赖曾经存在的 `setTimeout`。

### DST

在 `America/New_York`：

- 春季 gap：`30 2 * * *` 在 2025-03-09 的本地 `02:30` 不存在；`cron-parser@5.10.0` 实测返回 `07:30Z`，即当天 `03:30 EDT`。
- 秋季 fold：`30 1 * * *` 在 2025-11-02 有两个本地实例；实测只返回第一次，即 `05:30Z`（EDT），不会执行两次。
- `croner@10.0.1` 的实测结果与上面相同，但其 README 写的是 gap “skipped”，因此没有选择依赖该文字描述。

MVP 将上述 `cron-parser@5.10.0` 行为明确为契约：**gap 推进到第一个可表达的落点并保留分钟，fold 只取第一次**。需要用固定版本回归测试锁定；未来升级库时先跑 DST contract tests。每日 09:00 的当前任务本身不落在 DST 过渡窗口，但时区行为仍须定义。

### 错误与秒字段

包装层的实验结果：

- 6 字段 `0 0 9 * * *`：`Beacon cron must have exactly 5 fields; got 6`。
- 越界 minute `60 9 * * *`：底层明确报告期望范围 `0-59`。
- 同时限制 DOM/DOW 的 `0 9 1 * 1`：strict mode 拒绝。
- 无效时区的底层错误文本不友好，因此 Beacon 必须先用 `Intl.DateTimeFormat(..., { timeZone })` 独立验证 IANA zone，并把错误定位到 `profiles.<id>.schedules.<id>.timezone`。

所有配置错误都应在 `doctor` 和 `serve` 启动期间聚合定位后导致非零退出；不能静默改写表达式或回退到机器本地时区。

## 实现边界

最小实现建议：

1. 启动时验证 schedule id 唯一、cron 恰为五字段、字符属于窄语法、timezone 有效，再以 `0 ${cron}` + `strict: true` 编译。
2. 文件状态按 schedule 保存至少一个成功持久化的 reconciliation cursor（UTC instant）。文件必须临时文件写入后原子 rename；格式和 crash window 由运行记录票决定。
3. 每轮以注入的 `Clock.now()` 为上界调用 `between()`，把 occurrence 交给统一 Trigger → Run → Delivery 链路，再计算最近 next occurrence 安排 wake-up。
4. 系统 sleep、进程重启和普通在线 tick 均重新从 cursor 计算；timer 只负责唤醒，不负责证明某次执行发生过。
5. 测试 occurrence calculator 时传固定 `afterExclusive`，无需 fake timers；只在测试 wake-up loop 时使用 fake clock。

## 证据来源

- [`cron-parser` README](https://github.com/harrisiirak/cron-parser#readme)：5/6 字段、`currentDate`、`tz`、iterator、strict mode、Node/TS 要求。
- [`cron-parser` source](https://github.com/harrisiirak/cron-parser/blob/master/src/CronExpression.ts)：DST 与 next/prev occurrence 的实际计算实现。
- [Croner README](https://github.com/Hexagon/croner#readme)：`nextRun(s)`、timezone、可选秒/年字段、DOM/DOW 语义和声明的 DST 行为。
- [`node-cron` README](https://github.com/node-cron/node-cron#readme)：可选秒字段、timezone、task `getNextRun`、在线 scheduler 能力及不提供 durable exactly-once 的边界。
- npm registry metadata（2026-09-12 查询）：三个固定版本的发布时间、Node engine、module/type 与 dependencies。

## 后续规格必须写明

- schedule 的 prompt 和 Feishu destination 最终字段形状由配置格式、飞书主动投递实验决定，不在本票提前定死。
- missed occurrences 的业务策略与 cursor 在 crash window 中的推进时机，属于 Run 编排/运行记录票。
- 若未来真的出现“每 90 分钟，不随 wall clock/DST 调整”的需求，新增明确的 interval trigger kind，并单独定义 restart catch-up 语义；不要扩展当前 cron 字段去模拟。
