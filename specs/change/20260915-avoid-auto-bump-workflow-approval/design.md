# Design Record

## Research Findings

- PR #32 的原始 `pull_request` run 由 `nettee` 触发并成功；`github-actions[bot]` 提交 `19fbdd8` 后，同一 commit 的新 `pull_request` run 以 `action_required` 结束，而显式 `workflow_dispatch` run 成功。来源：GitHub Actions runs `34966670376`、`34966688800`、`34966684808`。
- GitHub 明确规定：workflow 使用 `GITHUB_TOKEN` 创建或更新 PR 时，随后的 `pull_request` opened/synchronize/reopened run 会进入需审批状态；改用 GitHub App installation token 或 PAT 可自动触发。来源：[Triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)。
- Zest Dev 的同类 workflow 在 checkout 使用 `secrets.AUTO_BUMP_TOKEN || github.token`，且其仓库已配置同名 secret；Beacon 当前 checkout 写死 `github.token`，仓库没有 repository secret。来源：`/Users/william/projects/zest-dev/.github/workflows/ci.yml`、Zest Dev/Beacon `gh secret list`。
- `actions/checkout` 默认持久化所用 credentials，因此后续 `git push` 使用 checkout 的 token。来源：[actions/checkout](https://github.com/actions/checkout)。

## Design Decisions

### Reuse Zest Dev's AUTO_BUMP_TOKEN pattern

在 `actions/checkout` 的 `token` input 中使用 `secrets.AUTO_BUMP_TOKEN || github.token`。配置 secret 时，push actor 是 token owner，后续 PR CI 正常触发；fallback 保持未配置仓库的原有行为。选择 fine-grained PAT 时只授予 `nettee/beacon` 的 Contents read/write，并由维护者通过 repository secret 注入，不把 token 写入代码或日志。依据：Zest Dev 既有实现与 GitHub workflow-trigger 规则。

Trade-off：PAT 是长期 credential，需要维护者轮换；未来可迁移到短期 GitHub App installation token，但不属于本次范围。

### Remove the redundant manual dispatch

删除 `actions: write` job permission 和 bump 后的 `gh workflow run`。有 `AUTO_BUMP_TOKEN` 时，push 已自然触发正确的 `pull_request` run；保留 dispatch 会为同一 commit 再制造一轮 CI。依据：PR #32 run 证据和 GitHub token-trigger 规则。

### Change Scope

- Impact Areas：PR CI 的 auto-bump authentication、follow-up CI triggering，以及维护者 secret 配置文档；不改变 fork guard、版本检测、发布或业务代码。
- Planned File Changes：`.github/workflows/ci.yml` 调整 token/权限/dispatch；`README.md` 记录 secret；Spec 文件保存决策和验证证据。

### Verification

本地以 `actionlint` 和静态断言验证 workflow；最终系统行为只能由配置 secret 后的真实 PR run 验收，因为 GitHub 不允许读取 secret value，且 approval gate 是 GitHub 托管行为。
