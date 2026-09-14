# Implementation

<!-- High-signal implementation notes. Focus on material deviations and what future work must preserve; do not mirror every Plan ticket. -->

## Outcome

- `@nettee/beacon@0.1.0` 现在能生成 allowlisted production tarball，CLI 版本来自 package metadata，production build 不再携带测试产物。
- PR/main CI 可从真实 tarball 在临时 global prefix 安装并执行 Beacon；main publish workflow 在 bootstrap guard 启用后自动通过 npm OIDC 发布新精确版本。
- AFK Tickets 1–5 已完成；首次 2FA publish、Trusted Publisher/guard 配置与 public registry 安装验收仍按 Ticket 6 保持 HITL。

## Deviations

### Bootstrap requires an explicit repository-variable guard

Current behavior: main publish workflow 始终验证 package，但仅在 `NPM_TRUSTED_PUBLISHING_ENABLED=true` 时访问 registry/publish；首次合并后由 HITL 先发布 `0.1.0`、配置 trust，再打开 guard。

Deviation: 初版 Design 曾假设可以在 package 首发前建立 Trusted Publisher；实现前核验 npm 最新约束后，Design 与 Plan 已同步修订。

Attention: 不要在首次 publish 和 Trusted Publisher 配置完成前打开 guard；打开后 main 上每个未发布的新 package version 都会自动发布。

Evidence: [`.github/workflows/publish-npm.yml`](../../../.github/workflows/publish-npm.yml)、npm [trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。

## Verification

- 2026-09-14：`pnpm check`、`pnpm typecheck`、`pnpm test`（71 passed）、`pnpm build` 全部通过。
- 2026-09-14：`pnpm test:package` 从 tarball 安装到临时 global prefix，验证 allowlist、内部 CLI/extension 布局、`beacon version` 与失败退出行为，通过。
- 2026-09-14：`actionlint .github/workflows/ci.yml .github/workflows/publish-npm.yml` 与 `plutil -lint deploy/io.nettee.beacon.plist.example` 通过。
- No EAG per user decision; public registry 验收保留在未完成的 HITL Ticket 6。

## Spec Retrospective

- 对新 npm package 设计 OIDC 发布时，应在确定首次发布顺序前先核验“package 必须已存在才能配置 trust”的 registry 前置条件。
