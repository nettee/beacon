# Beacon

Beacon is a single-host service that turns Feishu messages and configured schedules into isolated Pi agent runs. Each accepted Trigger is durably claimed, produces exactly one explicit Final Outcome, and is delivered either as a quoted reply or to a configured Feishu `chat_id`.

This repository currently implements the Feishu + Pi MVP described by the
[Zest Dev Spec](https://github.com/nettee/beacon/blob/main/specs/change/20260913-beacon-feishu-pi-mvp/spec.md).

## Runtime requirements

- macOS with Node.js 22 or newer
- npm
- A Pi executable and Pi coding-agent directory
- One Feishu self-built application per Profile, configured for persistent-connection message events and the APIs needed to read/reply/react/create messages

## Install

```sh
npm install --global @nettee/beacon@latest
beacon version
```

Install an exact version when the deployment must be reproducible, including
when rolling back:

```sh
npm install --global @nettee/beacon@0.1.0
```

Upgrade to the current stable release with the same `latest` command. Run
`beacon doctor` with the production configuration before restarting a running
service. Beacon does not manage launchd installation, restart, or rollback in
this release.

Beacon only accepts an absolute path for the global configuration:

```sh
beacon doctor --config /Users/USERNAME/.beacon/config.yaml
beacon serve --config /Users/USERNAME/.beacon/config.yaml
```

`doctor` validates every Profile and credential, obtains a Feishu tenant token, and runs a real Pi RPC smoke test. It does not create Beacon state records.

## Configuration

Copy the files under [`examples`](examples) into a private Beacon home and replace every placeholder. A minimal layout is:

```text
~/.beacon/
├── config.yaml
├── secrets.json
└── profiles/
    └── example/
        ├── profile.yaml
        └── prompt.md
```

Protect the home and secret file before running Beacon:

```sh
chmod 700 /Users/USERNAME/.beacon
chmod 600 /Users/USERNAME/.beacon/secrets.json
```

Configuration is strict: unknown YAML/JSON fields, YAML aliases or warnings, missing paths, duplicate Schedule IDs, invalid timezones/cron expressions, unsafe Prompt paths, permissive secret permissions, and missing Profile credentials all fail startup. Beacon validates all Profiles before opening a Feishu connection.

Each Schedule uses a five-field cron expression and an IANA timezone. Its `delivery.chat_id` may identify either a direct chat or a group chat; Beacon deliberately does not infer or fall back to another destination. A newly discovered Schedule starts at the current time. After sleep or restart, overdue occurrences are reconciled and coalesced to the most recent one.

## Commands

```text
beacon serve --config <absolute-path>
beacon doctor --config <absolute-path>
beacon trigger --config <absolute-path> --profile <id> --input -
beacon version
```

An operator can run one Profile without Feishu delivery by piping input to `trigger`; the Final Outcome is printed to stdout:

```sh
printf '%s\n' 'Summarize the workspace status.' | \
  beacon trigger --config /Users/USERNAME/.beacon/config.yaml --profile example --input -
```

## State and failure behavior

Per-Profile state lives below `profiles/<profile-id>/state/`. Trigger claims, normalized inputs, Run state, Final Outcomes, Delivery state, and Schedule cursors use durable JSON snapshots. Records do not expire, and Beacon has no automatic cleanup task. Manually deleting state also deletes its deduplication memory.

Duplicate Feishu events and duplicate Schedule occurrences do not start a second Run. Active Runs interrupted by restart fail rather than rerun. Pending Delivery can resume, while a Delivery interrupted after its external call began fails without resending. Run and Delivery success are recorded independently. Beacon does not automatically retry either one.

Secrets and ephemeral Run Capability tokens are excluded from persisted records and from the Pi environment except for the one Run-scoped Outcome capability.

## launchd

Edit [`deploy/io.nettee.beacon.plist.example`](deploy/io.nettee.beacon.plist.example) so every executable, config, working-directory, and log path is absolute. Create the log directory, copy the plist to `~/Library/LaunchAgents/io.nettee.beacon.plist`, then validate and load it:

Use `command -v beacon` after the global npm installation to find the absolute
CLI path for `ProgramArguments`. A Node version-manager upgrade can change that
path, so re-check it when changing the installed Node version.

```sh
plutil -lint /Users/USERNAME/Library/LaunchAgents/io.nettee.beacon.plist
launchctl bootstrap gui/$(id -u) /Users/USERNAME/Library/LaunchAgents/io.nettee.beacon.plist
launchctl print gui/$(id -u)/io.nettee.beacon
```

The example uses a restrictive umask and asks launchd to restart only after abnormal exit. `SIGTERM` initiates an orderly shutdown: timers and Gateways stop, accepted intake work drains, and the local Outcome server closes.

## Development checks

Development requires pnpm 10.33.2. Install dependencies before running checks
from a source checkout:

```sh
pnpm install --frozen-lockfile
```

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm test:package
pnpm e2e:message
pnpm build
plutil -lint deploy/io.nettee.beacon.plist.example
```

`pnpm test:package` builds a production tarball, checks its allowlisted
contents, installs it under a temporary global npm prefix, and runs the
installed `beacon` binary without using the source tree.

`pnpm e2e:message` sends one synthetic Feishu direct message through an
in-memory Gateway, the production message pipeline, and a real Pi model. The
same in-memory Gateway captures the quoted reply without contacting Feishu. It defaults to
`openai-codex/gpt-5.3-codex-spark`; override the runtime with
`BEACON_E2E_MESSAGE_PROVIDER`, `BEACON_E2E_MESSAGE_MODEL`,
`BEACON_E2E_MESSAGE_PI_EXECUTABLE`, or
`BEACON_E2E_MESSAGE_PI_CODING_AGENT_DIRECTORY`.

## Publishing

Choose the next semantic version explicitly when the release requires a major
or minor bump, or when you want to override the automatic patch decision:

```sh
pnpm bump-version major
pnpm bump-version minor
pnpm bump-version patch
```

For an in-repository pull request that changes production CLI inputs under
`src/`, `package.json`, `pnpm-lock.yaml`, or `tsconfig.json` without changing
the package version, CI automatically commits a patch bump to the PR branch.
Test-only and documentation changes do not trigger a release. An explicit
version change takes precedence over the automatic patch bump, and CI rejects
a changed version that is not greater than the base branch version.

The bump job accepts only branches in this repository, not pull requests from
forks. Configure an `AUTO_BUMP_TOKEN` Actions secret with repository contents
write access so the bot push starts a fresh CI run for the new commit. Without
that secret the job falls back to `github.token`; repository Actions settings
must allow write access, and GitHub will not recursively start workflows for
that bot push.

Submit the release candidate through the normal pull request checks. After the
initial package bootstrap, each push to `main` runs
the npm publish workflow. It verifies the source and packaged installation,
publishes a version that is not yet present, and explicitly skips a version
that already exists.

The first `@nettee/beacon` release is a one-time exception because npm requires
a package to exist before Trusted Publishing can be configured. After the
`0.1.0` pull request is merged:

1. Review `npm pack --dry-run --json`, then publish `0.1.0` interactively with
   npm 2FA using `npm publish --access public`.
2. Configure `nettee/beacon` and `.github/workflows/publish-npm.yml` as the npm
   Trusted Publisher with direct publish permission.
3. Set the GitHub repository variable `NPM_TRUSTED_PUBLISHING_ENABLED` to
   `true`.
4. Install `@nettee/beacon@0.1.0` from the public registry in a clean temporary
   prefix and verify `beacon version` before accepting the release.

The repository variable deliberately keeps publishing disabled during the
bootstrap merge. Subsequent versions publish from GitHub Actions with OIDC and
do not use a long-lived npm write token.
