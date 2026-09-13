---
id: 20260913-beacon-feishu-pi-mvp
name: Beacon Feishu Pi Mvp
status: implemented
created: '2026-09-13'
---

## Overview

Beacon 已通过实验证明飞书消息可以驱动独立 Pi Run，但当前仓库仍是一次性验证形态：入口面向单个 Profile，事件仅内存去重，缺少持久队列、Schedule、重启恢复和正式部署契约。此 Spec 将已确认的 Wayfinder 决策收敛为一个可实施的单机 MVP。

期望结果是在一台常驻 Mac 上运行一个受 launchd 监督的 Beacon Service。它加载一个或多个目录隔离的 Profile；将飞书私聊、群聊 `@Bot` 或 Scheduled Occurrence 规范化为 Trigger；为每个 Trigger 启动一个全新 Pi RPC Run；只接受 Agent 通过 Run Capability 显式提交的一份 Final Outcome；最后引用回复原消息或主动发送到 Schedule 的 `chat_id`。

范围包括严格配置与密钥加载、飞书长连接、完整引用链、永久持久化去重与运行记录、FIFO 并发队列、Pi RPC/Outcome、五字段 cron 调度、失败语义、CLI、doctor 和 launchd 部署。MVP 验收使用一个 Profile，但实现不得硬编码单例。

约束：Node.js 22+ 与 strict TypeScript；必需配置、状态、网络、协议和子进程失败必须可观察且非零失败；不得使用 mock/空文本伪装成功、静默兼容、目标降级或自动 Run/Delivery 重试；飞书密钥不得进入 Pi 环境。运行记录永久保留，不实现过期或清理任务。

成功标准：私聊、群聊引用消息与 Schedule 均能走同一条持久 Trigger → Run → Final Outcome → Delivery 管线；重复事件与重启不会重跑已 claim 的工作；Run 和 Delivery 成败独立；部署检查、自动化测试、类型检查、构建与 EAG 全部通过。

## Design

### Summary

保留已经真实验证的飞书 Gateway、Pi RPC 与 Unix Socket Outcome seam，将它们置于持久化编排核心之外。每个 Trigger 用一个原子更新、永不过期的 JSON 快照同时承载去重 claim、恢复状态与诊断证据；Service 级 FIFO 队列统一处理消息和 Schedule，并用明确终态分开 Run 与 Delivery。launchd 只监督 Service，业务 cron 与 missed-occurrence 对账由 Service 自己负责。

See [design.md](./design.md) for the Design Record.

### E2E Acceptance Gate (EAG)

Acceptance behavior：由一个未参与实现、使用全新上下文的独立验收 Agent 检查最终工作区。它必须证明一个群聊引用 Trigger 和一个 Schedule Trigger 分别只创建一个 Pi Run、接受一次显式 Outcome，并落盘为正确的引用 Delivery 与 `chat_id` Delivery；重复事件不创建第二个 Run；Delivery 失败时保留 `run=succeeded, delivery=failed`；重启后不重跑已 claim 或已开始的 Run；磁盘和 Pi 环境中不存在 secret/capability 泄漏。

Verification path：实现完成后启动一个独立验收 Agent，仅向它提供本 Spec、最终工作区和必要的本机运行条件。该 Agent 独立阅读实现，运行现有测试、类型检查和 production build，并通过产品 CLI、临时 Beacon home 与一次性 `/tmp` fixtures 验证上述行为；不得新增或依赖仓库内 EAG 脚本。它将逐项证据、失败项和最终 `PASS|FAIL` 写入 `implementation.md`。只有 `PASS` 才通过 EAG；失败后由实现 Agent 修复，再交给独立验收 Agent 复验。

## Plan

### Ticket 1 (AFK): 建立严格配置与多 Profile Service 外壳

Goal: `beacon serve --config` 能在启动任何外部连接前完整加载全局配置、所有 Profile、Prompt 和严格权限的 secrets。
Scope: 实现 global/Profile schema、source-aware YAML 失败、Profile 扫描、路径边界、secrets owner/mode 检查、Pi 显式环境构造和新的 CLI 路由；保留单 Profile 验收但移除单例假设。
Depends on: None

### Ticket 2 (AFK): 交付持久化飞书消息 tracer bullet

Goal: 一条私聊或群聊 `@Bot` 消息能在 ACK 前原子 claim，解析完整引用链，运行全新 Pi RPC，接受显式 Final Outcome，并引用回复原消息。
Scope: 引入领域类型、TriggerStore 单快照记录、Feishu `event_id` 去重、异步 reaction、FIFO happy path、RunOrchestrator、严格一次 Outcome capability 与 typed reply Delivery；覆盖重复事件、引用循环/读取失败和业务错误码。
Depends on: Ticket 1

### Ticket 3 (AFK): 固化容量、失败与重启语义

Goal: 所有 Run/Delivery 边界失败都得到稳定错误码和可恢复的持久终态，不发生隐式重跑或重复发送。
Scope: 实现全局并发/队列上限、超时与 Pi 终止、RPC buffer 限制、失败 Outcome、Run/Delivery 状态分离，以及 queued/running/pending/delivering 的启动恢复规则；记录永久保留且无清理路径。
Depends on: Ticket 2

### Ticket 4 (AFK): 增加持久 Schedule 主动投递

Goal: 严格五字段 cron Schedule 在正常、睡眠和重启场景下生成不重复的 Trigger，并向单聊或群聊 `chat_id` 主动投递。
Scope: 实现 `cron-parser` 窄 adapter、IANA timezone/DST 契约、原子 cursor、bounded reconciliation、多个 missed occurrence 合并为最近一次，以及 typed chat Delivery。
Depends on: Ticket 3

### Ticket 5 (AFK): 完成 CLI、doctor 与 launchd 运维面

Goal: 操作者能安全启动、诊断、人工触发和监督 Beacon，而不依赖 shell 环境或隐式修复。
Scope: 完成 `serve`、只读 `doctor`、stdin `trigger`、`version`，提供通过 `plutil -lint` 的 LaunchAgent 示例，并验证绝对路径、限制性 umask、退出码、SIGTERM 与异常重启。
Depends on: Ticket 4

### Ticket 6 (AFK): EAG Validation

Goal: 由未参与实现的独立验收 Agent 执行 Design 定义的 EAG，并保存可复核的独立结论。
Scope: 启动全新上下文的验收 Agent；由它读取本 Spec 和最终工作区，运行现有检查并使用产品 CLI 与 `/tmp` 一次性 fixtures 验证规定行为，不创建仓库内 EAG 脚本；将证据与 `PASS|FAIL` 写入 Implementation File。失败项返回实现阶段修复后再独立复验。
Depends on: Ticket 5

### Ticket 7 (AFK): Documentation Sync

Goal: 最终行为、配置和运维文档与已实现系统一致且只有一个规范入口。
Scope: 复核 README、示例配置、launchd 安装/诊断说明、`CONTEXT.md` 与旧 Wayfinder 文档；将旧 MVP 文档改为指向本 Spec，记录已确认的实现偏差。
Depends on: Ticket 6

## Progress

- [x] Ticket 1 (AFK): 建立严格配置与多 Profile Service 外壳
- [x] Ticket 2 (AFK): 交付持久化飞书消息 tracer bullet
- [x] Ticket 3 (AFK): 固化容量、失败与重启语义
- [x] Ticket 4 (AFK): 增加持久 Schedule 主动投递
- [x] Ticket 5 (AFK): 完成 CLI、doctor 与 launchd 运维面
- [x] Ticket 6 (AFK): EAG Validation
- [x] Ticket 7 (AFK): Documentation Sync

## Implementation

See [implementation.md](./implementation.md).

## Deferred Follow-Ups (DFU)

- Beacon 侧用户、群聊或群内成员 allowlist。
- 多 Profile 行为验收、Profile 级公平调度或配额。
- 飞书以外的 Gateway 与 Pi 以外的 Agent Runtime。
- 连续对话/session 复用、恢复已中断 Run、流式中间过程和用户主动取消。
- 自动 Run/Delivery 重试。
- 使用 `open_id`、`user_id`、email、thread/root ID 或 Profile 默认目标投递。
- 配置热重载、Schedule CRUD、数据库、运行记录过期与清理。
- 高可用、多机和服务器部署。
