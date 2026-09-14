# Implementation

<!-- High-signal implementation notes. Focus on material deviations and what future work must preserve; do not mirror every Plan ticket. -->

## Outcome

- `@nettee/beacon@0.1.0` 现在能生成 allowlisted production tarball，CLI 版本来自 package metadata，production build 不再携带测试产物。
- PR/main CI 可从真实 tarball 在临时 global prefix 安装并执行 Beacon；main publish workflow 在 bootstrap guard 启用后自动通过 npm OIDC 发布新精确版本。
- AFK Tickets 1–5 与 HITL Ticket 6 均已完成：`0.1.0` 已首次公开发布，Trusted Publisher/guard 已配置，public registry 匿名冷安装验收通过。

## Deviations

### Bootstrap requires an explicit repository-variable guard

Current behavior: main publish workflow 始终验证 package，但仅在 `NPM_TRUSTED_PUBLISHING_ENABLED=true` 时访问 registry/publish；首次合并后由 HITL 先发布 `0.1.0`、配置 trust，再打开 guard。

Deviation: 初版 Design 曾假设可以在 package 首发前建立 Trusted Publisher；实现前核验 npm 最新约束后，Design 与 Plan 已同步修订。

Attention: guard 现已启用；main 上每个未发布的新 package version 都会自动发布。精确版本已存在时 workflow 会安全跳过，所以合入本次文档收尾不会重复发布 `0.1.0`。

Evidence: [`.github/workflows/publish-npm.yml`](../../../.github/workflows/publish-npm.yml)、npm [trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。

## Verification

- 2026-09-14：`pnpm check`、`pnpm typecheck`、`pnpm test`（71 passed）、`pnpm build` 全部通过。
- 2026-09-14：`pnpm test:package` 从 tarball 安装到临时 global prefix，验证 allowlist、内部 CLI/extension 布局、`beacon version` 与失败退出行为，通过。
- 2026-09-14：`actionlint .github/workflows/ci.yml .github/workflows/publish-npm.yml` 与 `plutil -lint deploy/io.nettee.beacon.plist.example` 通过。
- 2026-09-14：npm 交互式 2FA 首次 public publish 返回 `+ @nettee/beacon@0.1.0`；registry 元数据确认 `latest=0.1.0`、`bin.beacon=dist/cli.js`、`engines.node=>=22`。
- 2026-09-14：使用 `/dev/null` userconfig 与全新 npm cache/prefix 完成匿名冷安装；安装所得 `beacon version` 输出 `0.1.0`，且 `dist/cli.js` 与 `dist/runtime/pi-outcome-extension.js` 存在。
- 2026-09-14：npm CLI 创建 Trusted Publisher 成功，回执 ID `e2db6c61-b778-46f3-9c99-dcc26a3a5c92`，绑定 `nettee/beacon`、`publish-npm.yml`，权限包含 direct publish；`gh variable list` 读回 `NPM_TRUSTED_PUBLISHING_ENABLED=true`。
- No EAG per user decision; public registry 验收已由 HITL Ticket 6 完成。下一个新版本合入 main 时将首次实际执行 OIDC publish 路径。

Fact sources: npm [`npm trust` command](https://docs.npmjs.com/cli/v11/commands/npm-trust/)、npm [Trusted publishing](https://docs.npmjs.com/trusted-publishers/)、npm registry/CLI 回执、GitHub repository variable 读回结果。

## Spec Retrospective

- 对新 npm package 设计 OIDC 发布时，应在确定首次发布顺序前先核验“package 必须已存在才能配置 trust”的 registry 前置条件。
