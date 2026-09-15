---
id: 20260915-avoid-auto-bump-workflow-approval
name: Avoid Auto Bump Workflow Approval
status: planned
created: '2026-09-15'
---

## Overview

Beacon 的 PR CI 会用 `github.token` 向 PR 分支提交自动 patch version bump。GitHub 对由该 token 更新 PR 后产生的 `pull_request` workflow 强制要求维护者审批，因此每个符合自动 bump 条件的 PR 都出现多余的 “Approve workflows to run” 提示；当前额外 dispatch 的 CI 虽能运行，却没有消除提示。

本次 change 复用 Zest Dev 已验证的认证方式，让自动 bump push 优先使用 repository secret `AUTO_BUMP_TOKEN`，从而以 token owner 身份自然触发后续 PR CI，并删除冗余的显式 dispatch。fork PR、版本选择和发布逻辑不变。成功标准是 workflow 配置通过静态校验，文档准确说明 secret 要求，并在 secret 配置后由真实 PR 自动 bump 证明不再产生 approval gate。

## Design

### Summary

在 checkout 中使用 `secrets.AUTO_BUMP_TOKEN || github.token`，让持久化的 git credentials 在配置 secret 时用于后续 push；删除仅为 bot push 补跑 CI 的 `workflow_dispatch` 步骤及 `actions: write` 权限。保持 `github.token` fallback 以便配置缺失时仍可执行原有路径，但明确记录：只有配置 fine-grained token 才能消除审批提示。

See [design.md](./design.md) for the Design Record.

### E2E Acceptance Gate (EAG)

真实 EAG：配置 `AUTO_BUMP_TOKEN` 后，从仓库内分支创建一个需要自动 patch bump 的 PR；bot commit 后的 `pull_request` CI 自动开始，PR 不显示 workflow approval banner。该验证依赖不可从仓库读取的 secret 与 GitHub 托管运行，因此没有本地自动 EAG；实现以 `actionlint .github/workflows/ci.yml` 作为最佳静态门禁。

## Plan

### Ticket 1 (AFK): Use contributor-authenticated auto-bump pushes

Goal: 让配置过 `AUTO_BUMP_TOKEN` 的自动 bump push 自然触发 PR CI，不再产生 bot approval gate 或重复 dispatch。
Scope: 调整 checkout token、job permissions，并删除显式 workflow dispatch。
Depends on: None

### Ticket 2 (AFK): Validate the workflow configuration

Goal: 确认更新后的 GitHub Actions YAML 合法且关键认证/触发不变量存在。
Scope: 运行 actionlint 和针对 workflow 关键字段的静态检查；确认完整 diff。
Depends on: Ticket 1

### Ticket 3 (HITL): Configure and validate AUTO_BUMP_TOKEN

Goal: 在 GitHub 托管环境证明 auto-bump follow-up CI 不再进入 approval-required 状态。
Scope: 维护者创建 repository-scoped fine-grained PAT，将其保存为 Beacon repository secret `AUTO_BUMP_TOKEN`，随后在真实 PR 上触发一次 auto bump 并检查 run actor/conclusion 与 PR banner。
Depends on: Ticket 2

### Ticket 4 (AFK): Documentation Sync

Goal: 让维护者能正确配置并理解 auto-bump token 行为。
Scope: 复核 README，确保 `AUTO_BUMP_TOKEN` 的权限、fallback 与真实 PR 验收路径和最终行为一致。
Depends on: Ticket 3

## Progress

- [x] Ticket 1 (AFK): Use contributor-authenticated auto-bump pushes
- [x] Ticket 2 (AFK): Validate the workflow configuration
- [ ] Ticket 3 (HITL): Configure and validate AUTO_BUMP_TOKEN
- [ ] Ticket 4 (AFK): Documentation Sync

## Implementation

See [implementation.md](./implementation.md).

## Deferred Follow-Ups (DFU)

None.
