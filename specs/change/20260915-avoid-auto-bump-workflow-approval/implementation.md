# Implementation

<!-- High-signal implementation notes. Focus on material deviations and what future work must preserve; do not mirror every Plan ticket. -->

## Outcome

- PR auto-bump push 现在优先使用只授权 `nettee/beacon` Contents read/write 的 `AUTO_BUMP_TOKEN`，自然触发后续 `pull_request` CI，不再产生维护者审批门槛或额外 dispatch。
- Beacon repository secret 已配置，README 已记录权限和 fallback；PR #33 的真实 auto-bump 路径完成端到端验收。

## Deviations

None found.

## Verification

- 2026-09-15：`actionlint .github/workflows/ci.yml` 与 `git diff --check` 通过。
- 静态检查确认 workflow 包含 `secrets.AUTO_BUMP_TOKEN || github.token`，且不再包含 `actions: write` 或 `gh workflow run ci.yml`。
- 2026-09-15：通过 GitHub UI 创建 fine-grained PAT `beacon-auto-bump-ci`，仅授权 `nettee/beacon`，Contents read/write、Metadata read-only，2026-10-15 到期；保存为 repository secret `AUTO_BUMP_TOKEN`，页面确认添加成功。
- 2026-09-15：PR #33 临时重排 `tsconfig.json` 以触发真实 auto bump；run `34968423852` 成功提交 `8ed3e9c`，新的 `pull_request` run `34968454964` 立即以 actor/triggering actor `nettee` 运行并成功，没有 `action_required` 或 approval banner。验收后临时 tsconfig 改动和 package version bump 均已恢复。

## Spec Retrospective

None.
