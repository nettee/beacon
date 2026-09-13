# Design Record

## Research Findings

### Existing System

- 当前实现已经按 Profile 目录读取 `profile.yaml` 与同目录 Markdown Prompt，拒绝未知字段、无效 workspace 和逃逸 Profile 的 Prompt 路径；但 schema 仍包含已被 MVP 延后的 `access.allow_all`，且入口只加载调用者指定的一个 Profile。证据：`src/config/profile.ts:8-26,54-110`、`src/service.ts:8-23`。
- Feishu Gateway 已能接收 `p2p|group` 用户消息、添加非关键 `OnIt` reaction、递归读取 `parent_id` 引用链、检查飞书业务错误码并以 `reply_in_thread=false` 引用回复；当前去重仅为进程内 `message_id` Set，且 reaction 发生在持久 claim 之前。证据：`src/feishu/gateway.ts:29-33,39-64,67-99,102-159`。
- 引用链规范化已检测循环和无效 JSON，并按最早消息到直接父消息排列；当前消息保持独立。证据：`src/feishu/trigger-input.ts:40-88`。
- 当前 Profile runner 已把 Profile Prompt、workspace、provider/model 和规范化引用上下文映射到一个 Pi Run，并明确要求结构化 `submit_final_outcome`；普通 assistant final response 不用于 Delivery。证据：`src/run/profile-runner.ts:18-57`。
- Pi adapter 已使用显式环境 allowlist，按 LF 解析 RPC JSON，等待 prompt acceptance、`message_end` 与 `agent_settled`，检查 `stopReason`，限制 stderr 为 64 KiB，并在退出时终止子进程。证据：`src/runtime/pi-rpc.ts:106-140,164-280`。
- Outcome Server 已使用 256-bit 随机 token 与本地 Unix Socket，并在 Run settled 后要求已提交非空文本；当前实现会覆盖重复 submission，尚未执行 exactly-once 拒绝。证据：`src/outcome/server.ts:31-105`。
- Wayfinder 的真实实验已跑通私聊、群聊四消息引用链、全新 Pi RPC Run、结构化 Outcome 与引用回复，自动化基线为 24/24；这证明 adapter seam 可行，但不证明当前实验代码已满足持久化、Schedule 或部署要求。证据：[Issue #12](https://github.com/nettee/beacon/issues/12#issuecomment-5647135056)。

### Design Inputs

- 项目词汇明确区分 Profile、Trigger、Run、Run Capability、Final Outcome、Delivery Target、Delivery 与 Schedule，且 Agent Runtime 不应获知 Delivery Target。证据：`CONTEXT.md:19-56`。
- 已确认使用 Node.js + TypeScript、统一 `beacon` CLI 和每 Run 一个 Pi RPC 子进程；`--print` 仅用于诊断。证据：[Issue #14](https://github.com/nettee/beacon/issues/14#issuecomment-5643603489)。
- 已确认 launchd 只监督一个 Beacon Service；业务 Schedule、missed-run 对账和 Trigger 管线由 Service 持久化管理。证据：[Issue #4](https://github.com/nettee/beacon/issues/4#issuecomment-5643404620)。
- YAML 1.2 + source-aware `yaml` Document + strict schema 能提供需要的定位和失败语义；aliases、warning、未知字段与隐式兼容应被拒绝。证据：[Issue #15](https://github.com/nettee/beacon/issues/15#issuecomment-5643767780)。
- 飞书密钥文件与 Pi provider auth 应分离，Pi 必须从显式 allowlist 构造环境；`0600` 文件不构成对同一 macOS 用户任意代码执行的强隔离。证据：[Issue #16](https://github.com/nettee/beacon/issues/16#issuecomment-5643775840)。
- 五字段 cron、必填 IANA timezone、`cron-parser` occurrence calculator、文件 cursor 和固定 DST 契约已经过库对比与实验。证据：[Issue #17](https://github.com/nettee/beacon/issues/17#issuecomment-5644379540)。
- 用户已确认 Schedule 只配置 `chat_id`，它覆盖单聊和群聊；消息 Trigger 则引用回复原 `message_id`。证据：[Issue #18](https://github.com/nettee/beacon/issues/18#issuecomment-5650861249)。
- 用户最终选择运行记录与去重 claim 永不过期、无自动清理任务。证据：[Issue #7 amendment](https://github.com/nettee/beacon/issues/7#issuecomment-5650894089)、[Issue #10](https://github.com/nettee/beacon/issues/10#issuecomment-5650894382)。

### Constraints and Evidence Gaps

- 飞书 WebSocket handler 必须在持久接收后快速返回，不能等待 Pi；相关 ACK 时序、scopes 与主动发送限制来自官方 SDK/文档研究。证据：[Issue #2](https://github.com/nettee/beacon/issues/2#issuecomment-5643411593)。
- Pi RPC 的成功不能只由退出码推断；必须解析结构化终态并区分 spawn、模型、协议、超时与信号退出。证据：[Issue #3](https://github.com/nettee/beacon/issues/3#issuecomment-5643414940)、`src/runtime/pi-rpc.ts:210-268`。
- 当前仓库没有生产级持久状态、Schedule、全局容量控制、完整 CLI 或 launchd 文件；这是从现有文件清单与 `src/service.ts:8-23`、`src/cli.ts:11-58` 推出的实现缺口，而不是已验证能力。
- 独立验收 Agent 可以用现有测试、产品 CLI 和 `/tmp` fixtures 验证编排与持久化，但这不能重新证明飞书 SaaS 或真实模型的可用性；真实 adapter seam 的依据仍是已完成的 credentialed 实验 [Issue #12](https://github.com/nettee/beacon/issues/12#issuecomment-5647135056)。

## Design Decisions

### 1. 一个持久化编排核心，adapter 保持窄边界

Beacon Service 组合 `ProfileRegistry`、`TriggerStore`、`RunQueue`、`Scheduler` 与 `RunOrchestrator`；Feishu、Pi RPC 和 Outcome Socket 只实现边界协议。领域层使用 `DeliveryTarget = reply(messageId) | chat(chatId) | local_stdout`，其中 `local_stdout` 仅供诊断 CLI；`beacon trigger` 产生 `manual` TriggerInput，不伪装成消息或 Schedule。选择这一结构是为了延续已验证的 adapter seam，同时落实 `CONTEXT.md:7-49` 中 Gateway、Runtime 和 Delivery 的职责分离。代价是当前直接串联的 `runFeishuGateway → RunProfile` 需要重构。

### 2. 配置从启动开始 fail fast

全局配置声明 profiles root、Pi 绝对路径、`max_concurrent=2`、`max_queued=100`、`timeout_seconds=1800`、终止宽限和 reconciliation 上限；Profile 声明 Prompt 文件、workspace、`runtime: pi`、provider/model 与 Schedules，不再接受 `access`。Service 在打开 Gateway 前扫描并验证全部 Profile 和 secrets。这个规范选择建立在 YAML/strict-schema 能力和现有 Profile 路径防逃逸实现上（[Issue #15](https://github.com/nettee/beacon/issues/15#issuecomment-5643767780)、`src/config/profile.ts:43-100`）；它牺牲局部 Profile 可用性，换取启动状态不含隐藏的半成功。

### 3. 每个 Trigger 一个永久原子快照

状态路径为 `profiles/<profile_id>/state/triggers/<trigger_key>/record.json`。Feishu key 是版本化 `(profile_id,event_id)` 编码的 SHA-256，Schedule key 是 `(profile_id,schedule_id,scheduled_for)` 的 SHA-256；排他创建目录就是 claim。`record.json` 用严格版本 schema 嵌套 Trigger、Run、Final Outcome 和 Delivery，更新采用同目录临时文件、flush、原子 rename。记录永久保留，无 retention 字段、清理 timer 或清理命令。该选择直接执行用户确认的简单生命周期（[Issue #7 amendment](https://github.com/nettee/beacon/issues/7#issuecomment-5650894089)、[Issue #10](https://github.com/nettee/beacon/issues/10#issuecomment-5650894382)）；代价是磁盘使用只由人工停服删除控制，删除也会丢失去重记忆。

记录保存完整规范化当前消息/引用链、Final Outcome、必要飞书标识、provider/model、Prompt digest、状态时间与稳定错误码；不保存原始事件 envelope、secret、capability、RPC transcript、Pi 中间过程或完整 stdout/stderr。外部分享另行脱敏。

### 4. ACK 前 claim，之后异步规范化与运行

Feishu handler 只接受用户 `p2p|group` 消息，要求 `event_id`，在返回前 durable claim 最小当前消息字段和 reply target；重复 claim 直接成功返回且不 reaction、不 Run。新 Trigger 入队后异步添加非关键 `OnIt`，再递归读取完整引用链；循环、任何必要父消息不可读或内容无效都生成明确失败 Outcome。依据是 ACK 不能等待 Pi 的时序事实 [Issue #2](https://github.com/nettee/beacon/issues/2#issuecomment-5643411593) 与已验证的引用解析 `src/feishu/trigger-input.ts:48-88`。这要求替换当前基于 `message_id` 的内存 Set。

### 5. FIFO 容量与 at-most-once Run

所有 Profile 共用持久 FIFO 队列；最多两个并发 Run、100 个 queued Run，满队列产生 `capacity_exceeded` 失败 Outcome 而不 spawn Pi。queued 在重启后继续；starting/running 标记 `service_interrupted`、投递失败 Outcome且不恢复或重跑；pending Delivery 可继续，delivering 因外部结果不确定而标记 `delivery_interrupted` 且不重发。Run 与 Delivery 状态彼此独立。该规范选择以避免重复副作用为首要目标，建立在独立 Pi 进程可并发和中断不可安全恢复的事实之上（[Issue #3](https://github.com/nettee/beacon/issues/3#issuecomment-5643414940)、[Issue #4](https://github.com/nettee/beacon/issues/4#issuecomment-5643404620)）。

### 6. Pi settled 与显式 Outcome 共同定义成功

每个 Run 启动 `pi --mode rpc --no-session --no-approve`，在 Profile workspace 中发送一条 prompt；必须看到 prompt accepted、权威 `message_end(stopReason=stop)`、`agent_settled`，并收到一次非空 `submit_final_outcome(text)`。普通 assistant text 被忽略。Run Capability 使用至少 256-bit 随机 token，只存在于内存和子进程环境，首个合法 submission 后即消费；错误/重复/过期 token 明确失败。依据为现有 Pi/Outcome seam（`src/runtime/pi-rpc.ts:164-280`、`src/outcome/server.ts:31-105`）和真实实验 [Issue #12](https://github.com/nettee/beacon/issues/12#issuecomment-5647135056)。

Run 超时先请求 RPC abort（若兼容），再 SIGTERM，宽限后 SIGKILL；协议 frame、stderr 和最终 Outcome 均有明确大小上限。提交 Outcome 后的协议或受控关停失败仍是 Run failed，不交付未确认成功结果。

### 7. 两种飞书投递不互相降级

消息 Trigger 固定调用 reply API，目标为原 `message_id` 且 `reply_in_thread=false`；Schedule 固定调用 create-message，目标为显式 `chat_id`，同时覆盖 `p2p` 和群聊。transport 成功但飞书业务码非零仍是 Delivery failed。任何失败都不改发普通群消息、用户 ID 或其他 target，也不重跑 Agent。这个规范选择基于真实引用回复验证与用户确认的窄 Schedule target（`src/feishu/gateway.ts:29-64`、[Issue #18](https://github.com/nettee/beacon/issues/18#issuecomment-5650861249)）。

### 8. Service 内调度，cursor 是事实源

Schedule 使用严格五字段 cron 和必填 IANA timezone；`cron-parser` 只计算 occurrence。每个 Schedule 有原子 cursor；新 Schedule 第一次被 Service 发现时将 cursor 初始化为当前时间，不追溯配置存在前的历史 occurrence。启动、唤醒和 timer 时枚举 cursor 之后到 now 的 occurrence，超过全局上限明确失败，多个 overdue occurrence 合并成最新一次 Trigger。无论该 Trigger 是新 claim 还是重复 claim，只在 durable claim 已存在后推进 cursor。DST gap/fold 遵循已验证契约。选择依据为 launchd 会合并/遗漏业务触发且 cron-parser 可确定性枚举（[Issue #4](https://github.com/nettee/beacon/issues/4#issuecomment-5643404620)、[Issue #17](https://github.com/nettee/beacon/issues/17#issuecomment-5644379540)）。

### 9. 稳定失败码与边界责任

至少定义 `config_invalid`、`secret_invalid`、`gateway_terminal`、`trigger_persist_failed`、`trigger_normalization_failed`、`schedule_state_invalid`、`capacity_exceeded`、`runtime_spawn_failed`、`runtime_protocol_error`、`runtime_timeout`、`runtime_exit_failed`、`outcome_missing`、`outcome_invalid`、`service_interrupted`、`delivery_api_failed`、`delivery_interrupted`。用户可见失败只包含安全摘要和 `run_id`；本地 snapshot 保存有界诊断。reaction/log-cleanup 一类非关键诊断不阻断核心链路，但任何当前状态写失败立即失败。

### 10. EAG 由独立 Agent 验收，不维护专用脚本

实现完成后必须启动一个未参与实现、使用全新上下文的验收 Agent。它只接收本 Spec、最终工作区和必要本机运行条件，独立选择现有测试与产品 CLI 验证消息、Schedule、重复、Delivery 失败、重启和 secret/capability 排除；允许在 `/tmp` 创建一次性 fixture，但不得向仓库增加 EAG harness、测试脚本或通用产品能力。真实飞书/Pi 可用性不要求每次重做，因为 credentialed seam 已有独立证据 [Issue #12](https://github.com/nettee/beacon/issues/12#issuecomment-5647135056)。验收 Agent 把逐项证据与最终 `PASS|FAIL` 写入 `implementation.md`，实现 Agent 不能自行宣告 EAG 通过。

### Change Scope

#### Impact Areas

- 配置与兼容性：引入全局 config，Profile schema 删除 `access` 并增加 Schedule；现有实验配置需要迁移。
- 持久状态：新增不可自动清理的版本化 Trigger snapshot 与 Schedule cursor；没有旧格式迁移，因为现有代码没有生产状态格式。
- 架构：Gateway 与 Pi wire type 不再直接穿透编排；Run/Delivery 独立终态。
- 运维：CLI 从实验命令调整为 `serve|doctor|trigger|version`；增加 launchd 示例与启动恢复。
- 安全：secrets owner/mode 校验、Pi environment allowlist 和 Outcome capability exactly-once 成为强制合同。

#### Planned File Changes

- `src/config/`: 增加 global config、ProfileRegistry 与 source-aware 严格 loader；加强 `secrets.ts` 权限/owner/version 校验。
- `src/domain/`: 新增 Trigger、Run、Final Outcome、Delivery Target、状态与错误码类型。
- `src/state/`: 新增原子 snapshot repository、Trigger claim 与 Schedule cursor。
- `src/run/`: 将 `profile-runner.ts` 重构为持久 FIFO queue 与 RunOrchestrator。
- `src/feishu/`: 将 `gateway.ts` 拆分 intake/context/delivery 边界，使用 `event_id` durable dedupe 并增加 proactive chat send。
- `src/runtime/pi-rpc.ts`、`src/runtime/pi-outcome-extension.ts`、`src/outcome/`: 加固 framing、timeout、受控关停和 exactly-once capability。
- `src/schedule/`: 新增 cron adapter、reconciliation 与 wake timer。
- `src/service.ts`、`src/cli.ts`: 多 Profile 组合、启动恢复、公开 CLI 和退出语义。
- `deploy/`: 增加 LaunchAgent 示例。
- `src/**/*.test.ts`: 按模块补充状态、失败、DST、队列、环境与 CLI 测试。
- `README.md`、示例配置、`docs/beacon-mvp-spec.md`：最后同步操作文档，并将旧规格改为指向本 Spec。
