# Beacon

Beacon is a single-host service that turns Feishu messages and configured schedules into isolated Pi agent runs. Each accepted Trigger is durably claimed, produces an explicit Final Outcome, and may `reply` to a person, `notify_card` a group, or stay silent on the admin channel.

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

Operator commands find the standard Beacon home automatically; a service
deployment names its configuration explicitly:

```sh
beacon doctor
beacon serve --config /Users/USERNAME/.beacon/config.yaml
```

`doctor` validates every Profile and credential, obtains a Feishu tenant token, and runs a real Pi RPC smoke test. It does not create Beacon state records.

## Configuration

Copy the files under [`examples`](examples) into a private Beacon home and replace every placeholder. A minimal layout is:

```text
~/.beacon/
├── config.yaml
├── runtime.env
├── secrets.json
├── profiles/
│   └── example/
│       └── profile.yaml
└── workspace/
    └── .beacon-profile/
        ├── persona.md
        └── task.md
```

yaml names the workspace directory only. Beacon then loads `persona.md`
(identity) and `task.md` (process) as a pair: `{workspace}/.beacon-profile/`
first; if that pair is missing, `{profileDir}/`. It never mixes the two
places, never reads yaml `prompt:` / persona / task paths, and never falls
back to `prompt.md`. If neither place has a complete pair, Profile load fails
and lists the missing paths. Both pairs may exist; the workspace pair wins.

Beacon prepends an English platform template for this Run: workspace limit,
inbound vs Schedule vs manual capabilities, and the `reply` / `no_reply` /
`notify_card` contract.

Protect the home and secret file before running Beacon:

```sh
chmod 700 /Users/USERNAME/.beacon
test ! -e /Users/USERNAME/.beacon/runtime.env || chmod 600 /Users/USERNAME/.beacon/runtime.env
chmod 600 /Users/USERNAME/.beacon/secrets.json
```

`runtime.env` is optional. When present, Beacon loads every `KEY=VALUE` entry
once at startup and passes it to every Pi Run. This gives launchd deployments a
deterministic runtime environment without executing interactive shell files such
as `.zshrc`:

```dotenv
GRAFANA_READER_TOKEN_PROD=replace-me
```

The file must be owned by the Beacon user with mode `0600`. Blank lines and
lines beginning with `#` are ignored; values are literal and never evaluated as
shell syntax. Duplicate or invalid names, malformed entries, and reserved
process variables such as `PATH`, `NODE_OPTIONS`, `BEACON_*`, and `FEISHU_*`
fail startup. A missing file is treated as an empty runtime environment. Changes
take effect after Beacon restarts. Beacon does not log or persist values from
this file, but every configured Profile and Pi Run receives them.

Configure a dedicated absolute Pi session root in `config.yaml`:

```yaml
pi:
  executable: /ABSOLUTE/PATH/TO/pi
  coding_agent_directory: /Users/USERNAME/.pi/agent
  session_directory: /Users/USERNAME/.beacon/sessions
```

`pi.session_directory` is optional for compatibility with configurations
created by Beacon 0.1.2 and earlier; when omitted it defaults to `sessions/`
beside `config.yaml`. When configured, it must be absolute. Beacon creates
per-Run directories with mode `0700` when Pi starts.

Configuration is strict: unknown YAML/JSON fields, YAML aliases or warnings, missing paths, duplicate Schedule IDs, invalid timezones/cron expressions, a missing complete `persona.md` + `task.md` pair, escaped Profile markdown, permissive secret or runtime-environment permissions, and missing Profile credentials all fail startup. Beacon validates all Profiles before opening a Feishu connection.

Each Schedule uses a five-field cron expression and an IANA timezone. Profile
`admin.chat_id` is the private chat used for schedule `reply` / `no_reply` and
for failure notices. Optional `notify.chat_id` on a Schedule is the group that
receives `notify_card`. Beacon deliberately does not infer or fall back to
another destination. A newly discovered Schedule starts at the current time.
After sleep or restart, overdue occurrences are reconciled and coalesced to the
most recent one.

## Commands

```text
beacon serve --config <absolute-path>
beacon doctor [--config <absolute-path>]
beacon trigger [--config <absolute-path>] --profile <id> --input -
beacon schedule trigger [--config <absolute-path>] --profile <id> --schedule <id>
beacon version
```

Operator commands use `~/.beacon/config.yaml` when `--config` is omitted.
An explicit override must still be an absolute path. `serve` keeps requiring an
explicit absolute config path so service definitions identify their deployment
configuration unambiguously.

An operator can run one Profile without Feishu delivery by piping input to `trigger`; the Final Outcome is printed to stdout:

```sh
printf '%s\n' 'Summarize the workspace status.' | \
  beacon trigger --profile example --input -
```

An operator can also immediately run a configured Schedule through the real
Schedule input and Feishu chat Delivery path:

```sh
beacon schedule trigger --profile example --schedule daily-report
```

This creates a distinct durable Run on every invocation and prints its
`run_id`. It uses the Schedule's configured `input`, replies to
`admin.chat_id`, and may notify `notify.chat_id`, but does not read, initialize,
or advance the Schedule's cron cursor. Unknown
Profiles or Schedules and failed Runs or Deliveries exit non-zero; failure
messages include the `run_id` whenever a Run record was created.

## Final Outcomes

An Agent closes the conversational channel with `reply` or `no_reply`, and may
also call `notify_card` on the same Run:

- `reply` sends plain text. Inbound Feishu messages quote-reply the user.
  Schedules message the Profile admin. Inbound Runs must call `reply`, even
  when the message is outside the Profile's role.
- `no_reply` finishes a Schedule without messaging the admin. Its `reason` is
  stored for audit and is never sent. Do not use it on inbound messages.
- `notify_card` posts an interactive card to the Schedule's configured group.
  Inbound messages cannot notify.

The card tool accepts a title, Feishu-compatible Markdown body, and up to five
HTTP(S) link buttons. The first button is styled as primary. The tools accept
these argument shapes:

```json
{ "text": "The task completed successfully." }
```

```json
{
  "title": "AMR 生产发布影响报告",
  "content": "- XXL | CMS 活动生命周期、实时 Test 与生产 Campaign\n- XL | Astra 272K+ 长上下文费率",
  "buttons": [
    { "label": "查看 HTML 报告", "url": "https://example.com/report" },
    { "label": "查看 GitHub Compare", "url": "https://github.com/example/compare" }
  ]
}
```

```json
{ "reason": "No new models to onboard." }
```

Beacon binds destinations; the Agent never supplies a `chat_id`. Text remains
text. Cards are sent with Feishu's `interactive` message type and include the
card generation time. A schedule `no_reply` without `notify_card` records a
successful Run with no Delivery. Failures `reply` a short error and never
notify a group. Manual local triggers print reply text and any notify card as
Markdown on stdout.

## State and failure behavior

Per-Profile state lives below `profiles/<profile-id>/state/`. Trigger claims, normalized inputs, Run state, Final Outcomes, Delivery state, and Schedule cursors use durable JSON snapshots. Records do not expire, and Beacon has no automatic cleanup task. Manually deleting state also deletes its deduplication memory.

Every new business Run also owns a permanent Pi session. Its Run record stores
both `sessionId` and `sessionPath`; the session ID is exactly the Beacon
`runId`, and the path is the dedicated directory
`<pi.session_directory>/<profile-id>/<runId>/`. Pi receives that mapping via
`--session-dir`, `--session-id`, and a readable `Beacon <profile-id> <runId>`
name. The directory contains the Pi JSONL session file and is never cleaned up
by Beacon. A queued Run keeps the same mapping after restart. Queued records
written by Beacon 0.1.2 or earlier are assigned the same deterministic mapping
when recovered. Historical completed records remain readable and may omit the
two session fields because those Runs were originally ephemeral.

To locate a session from a reported `run_id`, first find its durable Run
record, then inspect or export the sole JSONL file in `sessionPath`:

```sh
rg -l '"runId": "run_REPORTED_ID"' /Users/USERNAME/.beacon/profiles/*/state/triggers/*/record.json
jq '.run | {runId, sessionId, sessionPath, state}' /ABSOLUTE/PATH/TO/record.json
find /ABSOLUTE/SESSION/PATH -maxdepth 1 -name '*.jsonl' -print
pi --export /ABSOLUTE/SESSION/PATH/TIMESTAMP_run_REPORTED_ID.jsonl run.html
```

`beacon doctor` keeps using `--no-session`, so its Pi smoke tests do not create
diagnostic session files.

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

The repository also contains Chinese operator runbooks based on the verified
`macmini.liuyi` deployment:

- [Deploy or update Beacon on macmini](docs/macmini-deploy-and-update.md)
- [Add a Beacon Profile on macmini](docs/macmini-add-profile.md)
- [Write a role-bounded Profile (`persona.md` / `task.md`)](docs/profile-prompt-writing.md)

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
`openai-codex/gpt-5.6-luna:low`; override the runtime with
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
forks. Configure a repository secret named `AUTO_BUMP_TOKEN` with a fine-grained
GitHub token whose repository access is limited to `nettee/beacon` and whose
Contents permission is read/write. The checkout persists that credential for
the version commit push, so GitHub attributes the PR update to the token owner
and starts follow-up PR checks without an approval prompt. When the secret is
absent, CI falls back to the job-scoped `github.token`; the bump still succeeds,
but GitHub requires a maintainer to approve the resulting PR workflow run.

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
