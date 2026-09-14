---
id: 20260914-beacon-cli-distribution
name: Beacon Cli Distribution
status: planned
created: '2026-09-14'
---

## Overview

Beacon 目前只能从源码执行 `pnpm install`、构建并全局 link。目标是提供一个有版本、可验证、无需检出源码的 CLI 分发与升级路径，使 Mac mini 上的 Beacon Service 和调用它的 Agent 能稳定安装和执行 `beacon`。

本次 change 将确定首选分发渠道、包名与可见性、版本和发布治理、安装边界，以及从本地打包验证到干净环境安装、启动前诊断的测试闭环；随后实现发布所必需的包结构、自动化与文档。首期不改变 Beacon 的 Trigger、Run、Delivery 等业务语义，也不重新设计 Pi Agent Runtime。

成功标准是：维护者能从一个明确的版本来源产出最小且不含无关/敏感文件的分发物；操作者能在目标 Mac mini 上不依赖 Beacon 源码安装 `latest` 或指定版本，并执行安装所得的现有 `beacon` 命令；发布失败或安装验证失败必须显式阻断流程。本期不管理 launchd service 生命周期。

## Design

### Summary

将 Beacon 发布为 public scoped npm package `@nettee/beacon`，首版 `0.1.0`，继续提供 `beacon` bin 并保持 `serve`、`doctor`、`trigger`、`version` 和内部 `outcome submit` 契约。Node.js 22+、npm 和 Pi 仍由目标机预装；package 通过显式 allowlist 仅携带运行产物和必要文档/示例，版本由 `package.json` 单一驱动。

维护者人工选择 SemVer。PR 从真实 tarball 做隔离安装验证；后续版本合并到 `main` 后自动发布。`0.1.0` 采用一次性人工 2FA bootstrap 并建立 Trusted Publisher；bootstrap 启用 repository variable 后，GitHub Actions 经 OIDC 查询并发布 main 上的精确版本：不存在才发布、已存在则明确跳过、其他错误一律失败。该边界直接解决 Mac mini 的无源码安装，同时避免引入 standalone binary、Pi 打包或 launchd service manager。

See [design.md](./design.md) for the Design Record.

### E2E Acceptance Gate (EAG)

No EAG. 本 Spec 以 `pnpm test:package` 的真实 tarball 隔离安装测试作为最佳自动化验证；合并后的 public registry 发布与安装验收由 HITL 执行。

## Plan

### Ticket 1 (AFK): Build the installable 0.1.0 package

Goal: 产出具备正确 identity、版本、运行布局与最小内容边界的 `@nettee/beacon@0.1.0` tarball。
Scope: 更新 npm metadata、public publish 配置与 `files` allowlist；让 production build 排除测试产物；让 `beacon version` 使用 `package.json` 单一版本源；确保 pack 前构建；补充必要自动化测试和 npm 页面所需的基本安装说明。
Depends on: None

Acceptance criteria: `npm pack --dry-run --json` 只列出允许的运行产物、examples/deploy 用户资产和 package 文档；bin、Outcome CLI 与 Pi extension 的相对布局完整，且 CLI 报告 `0.1.0`。

### Ticket 2 (AFK): Verify the real tarball in isolation

Goal: 用一个本地命令证明候选 package 可在无 Beacon 源码的环境中安装和执行。
Scope: 新增 fast-fail package test：构建并 pack，在临时 npm global prefix 安装 tarball，校验关键/禁止内容，从临时 bin 执行 `beacon version` 和代表性的 CLI failure smoke；可靠清理临时产物但不吞掉 required-operation failure；接入现有 CI。
Depends on: Ticket 1

Acceptance criteria: `pnpm test:package` 在成功时验证安装产物而非工作树；缺失关键文件、夹带禁止文件、版本漂移或任何 required subprocess 失败都会非零退出。

### Ticket 3 (AFK): Prepare guarded main-branch npm publication

Goal: 让 bootstrap 完成后的 main 新 SemVer 自动经过完整门禁和 OIDC 发布，首次合并不会在 trust 尚不可配置时注定失败。
Scope: 新增并测试精确 npm version 查询逻辑，只将明确 404 视为不存在；新增 main push 触发、串行且不可取消的 publish workflow，始终执行 production/package tests，仅在 repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true` 时查询并发布；使用满足 Trusted Publishing 要求的 Node/npm、`id-token: write` 与 `npm publish --access public`，已存在精确版本时显式跳过。
Depends on: Ticket 2

Acceptance criteria: 查询脚本覆盖存在、明确 404、认证/网络/异常响应；workflow 不保存长期 npm write token，任一 build、test、registry 或 publish 异常均失败。

### Ticket 4 (AFK): Validate the packaged distribution without an EAG

Goal: 在创建 PR 前完成本 Spec 可自动执行的最佳分发验证。
Scope: 运行 lint、typecheck、unit tests、production build 与 `pnpm test:package`，确认无 EAG，并把代表性结果记录到 Implementation File；任何失败必须修复或显式报告。
Depends on: Ticket 3

### Ticket 5 (AFK): Documentation Sync

Goal: 让 PR 文档准确描述待发布的分发、开发测试与发布行为。
Scope: 复核 README 中 requirements、public npm 的 latest/精确版本安装、升级/回滚、源码开发、`pnpm test:package`、首次 bootstrap、后续人工触发 OIDC 发布和 launchd 非目标边界；同步 Spec 中因实现产生的事实或偏差，不扩展 launchd service 管理。
Depends on: Ticket 4

### Ticket 6 (HITL): Publish and accept @nettee/beacon 0.1.0 after merge

Goal: 合并 Ready-for-review PR 后完成 `0.1.0` 首次发布、信任配置、自动发布启用与 public registry 安装验收。
Scope: 由 `nettee` 用户审核候选 package 并以 npm 交互式 2FA 首次 public publish `@nettee/beacon@0.1.0`；在 npm package settings 为 `nettee/beacon` 的 publish workflow 配置 Trusted Publisher；设置 GitHub repository variable `NPM_TRUSTED_PUBLISHING_ENABLED=true`；从 public registry 在干净临时 prefix 安装精确版本，确认内容边界与 `beacon version` 输出 `0.1.0`。任何外部步骤失败时停止并保留准确状态。
Depends on: Ticket 5

## Progress

- [x] Ticket 1 (AFK): Build the installable 0.1.0 package
- [x] Ticket 2 (AFK): Verify the real tarball in isolation
- [x] Ticket 3 (AFK): Prepare guarded main-branch npm publication
- [x] Ticket 4 (AFK): Validate the packaged distribution without an EAG
- [x] Ticket 5 (AFK): Documentation Sync
- [ ] Ticket 6 (HITL): Publish and accept @nettee/beacon 0.1.0 after merge

## Implementation

See [implementation.md](./implementation.md).

## Deferred Follow-Ups (DFU)

- 提供 `beacon service install/upgrade` 或其他一等 launchd plist、稳定 executable 路径、服务重启与回滚管理。
