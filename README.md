# Beacon

Beacon is a single-host service that turns Feishu messages, configured schedules, and subscribed CloudEvents into isolated Pi agent runs. Each accepted Trigger is durably claimed, produces an explicit Final Outcome, and may `reply_text` / `reply_card` to a person, `notify_card` a group, or stay silent on the admin channel.

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
beacon serve
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
inbound vs Schedule vs event vs manual capabilities, the `reply_text` / `reply_card` /
`no_reply` / `notify_card` contract, and an optional `submit_feedback` tool.

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

Configuration is strict: unknown YAML/JSON fields, YAML aliases or warnings, missing paths, duplicate Schedule IDs, invalid timezones/cron expressions, a missing complete `persona.md` + `task.md` pair, escaped Profile markdown, permissive secret or runtime-environment permissions, missing Profile credentials, and unknown Feishu channel names all fail startup. Beacon validates all Profiles before opening a Feishu connection.

Group notify destinations are registered globally in `~/.beacon/channels.yaml`
(beside `config.yaml`), then referenced by semantic `name` from each Profile's
`notify`. Admin DMs are **not** channel entries: each Profile keeps a raw
`admin.chat_id` (one bot×person private chat; putting those in the registry
would explode as bots and people grow).

```yaml
# ~/.beacon/channels.yaml — group chats only
version: 1
channels:
  - name: weekday-brief-group
    description: Example weekday brief notify group
    chat_id: REPLACE_WITH_GROUP_CHAT_ID
```

```yaml
# profile.yaml destinations
admin:
  chat_id: REPLACE_WITH_ADMIN_DIRECT_CHAT_ID
schedules:
  - id: weekday-brief
    cron: "0 9 * * 1-5"
    timezone: Asia/Shanghai
    input: Prepare the weekday brief.
    notify:
      name: weekday-brief-group
```

Each channel has `name` (stable slug), `description` (human-readable Chinese or
English label), and `chat_id` (the real Feishu group chat id). Profile `notify`
binds `name` and may optionally override `description` for local readability;
Beacon resolves `name` → `chat_id` at load time. Unknown names fail startup.
`admin` must use bare `chat_id` (not a channel `name`). Legacy bare `chat_id`
under `notify` still loads so hosts can migrate one Profile at a time; new
`notify` entries should use `name`.

Each Schedule uses a five-field cron expression and an IANA timezone. Profile
`admin` is the private chat used for schedule `reply_text` /
`reply_card` / `no_reply` and for failure notices. Optional `notify` on a
Schedule is the group that receives `notify_card`. Beacon deliberately does not
infer or fall back to another destination. A newly discovered Schedule starts at
the current time.
After sleep or restart, overdue occurrences are reconciled and coalesced to the
most recent one.

## Event triggers

Beacon accepts CloudEvents on a dedicated, opt-in HTTP server. A Profile's
optional `listener` selects the events it receives; Profiles without a listener
never receive external events. Direct Feishu/manual inputs and Schedules keep
using their existing paths:

```text
CloudEvent → authenticate → match + persist recipients ─────┐
Time       → Schedule due ──────────────────────────────────┼→ Trigger → Run
Input      → directly addressed Profile ────────────────────┘
```

Enable the server in `config.yaml` (all values below except `enabled` and
`credentials_file` show defaults):

```yaml
events:
  enabled: true
  listen: 127.0.0.1
  port: 46184
  max_body_bytes: 262144
  max_pending: 1000
  credentials_file: event-credentials.json
```

`credentials_file` resolves relative to the directory containing `config.yaml`;
absolute paths also work. Copy
[`examples/event-credentials.json.example`](examples/event-credentials.json.example)
to that location and replace its token with a unique, random Bearer token of at
least 32 characters (for example, generate one with `openssl rand -hex 32`).
Each producer has a stable ID and an explicit list of allowed event sources:

```json
{
  "version": 1,
  "producers": [
    {
      "id": "deployment-system",
      "token": "REPLACE_WITH_A_UNIQUE_RANDOM_TOKEN_AT_LEAST_32_CHARACTERS",
      "sources": ["https://deploy.example.com/production"]
    }
  ]
}
```

The credentials file must be a regular, non-symlink file owned by the Beacon
user with mode `0600`. Its parent directory must belong to that user and grant
no group/world access. Producer IDs and tokens must be unique, and source lists
must be nonempty. Tokens use Bearer-compatible characters. Credentials are not
passed to Pi, included in event records, or loaded from `runtime.env`.

```sh
chmod 700 "$HOME/.beacon"
chmod 600 "$HOME/.beacon/event-credentials.json"
```

Subscribe in the desired `profile.yaml`:

```yaml
admin:
  chat_id: REPLACE_WITH_ADMIN_DIRECT_CHAT_ID
listener:
  sources:
    - https://deploy.example.com/production
  types:
    - com.example.deployment.completed.v1
  notify:
    name: weekday-brief-group
```

Both lists are required and nonempty. Values match exactly: **OR within each
list, AND between `sources` and `types`**. There are no wildcards, regular
expressions, or filters inside `data`. A listener requires `admin`;
`listener.notify` is optional. Matching Profiles each receive one Trigger with
the complete event as input. Their `persona.md` and `task.md` define what to do.
`reply_text` and `reply_card` go to the configured admin; `no_reply` is allowed;
`notify_card` is available only when the listener has a notify target. The event
cannot choose a Profile, command, or delivery destination. All event fields
remain untrusted external data, even after producer authentication.

Restart Beacon after changing configuration or credentials. This example sends
one CloudEvents 1.0 structured JSON event. Set the token in your **sender's**
environment to the value in its producer credentials; do not put it in Beacon's
`runtime.env`:

```sh
export BEACON_EVENT_TOKEN='YOUR_CONFIGURED_PRODUCER_TOKEN'
curl --fail-with-body --include \
  -X POST http://127.0.0.1:46184/v1/events \
  -H "Authorization: Bearer ${BEACON_EVENT_TOKEN}" \
  -H 'Content-Type: application/cloudevents+json' \
  --data-binary '{
    "specversion": "1.0",
    "id": "deployment-20260929-001",
    "source": "https://deploy.example.com/production",
    "type": "com.example.deployment.completed.v1",
    "subject": "services/payment",
    "time": "2026-09-29T09:00:00Z",
    "datacontenttype": "application/json",
    "data": {"service": "payment", "version": "v2.3.0"}
  }'
```

Use a new event `id` for each new fact. When retrying delivery of the same fact,
keep the same event body and ID. Acceptance returns a `receipt_id`, `status`,
`accepted_at`, `recipients`, and `duplicate`, with a `Location` header pointing
to the receipt. Query it using the same producer's credentials:

```sh
export BEACON_EVENT_RECEIPT_ID='evt_REPLACE_WITH_RECEIPT_ID_FROM_RESPONSE'
curl --fail-with-body \
  -H "Authorization: Bearer ${BEACON_EVENT_TOKEN}" \
  "http://127.0.0.1:46184/v1/events/${BEACON_EVENT_RECEIPT_ID}"
```

| HTTP result | Meaning |
| --- | --- |
| `202` | New event durably accepted, independently of Run execution |
| `200` on POST | Identical event from the same producer already accepted; no new Trigger |
| `400` / `415` | Invalid event or unsupported representation; fix the request |
| `401` / `403` | Invalid credentials / producer not authorized for this `source` |
| `409` | Same `source + id` already belongs to different event content or another producer |
| `413` | Request exceeds `max_body_bytes` (256 KiB by default) |
| `503` | Intake unavailable or pending inbox full; retry with backoff, honoring `Retry-After` |
| `500` | Required intake work failed; acceptance was not confirmed; retry the same event after recovery |

Receipt queries return `200` only to the originating producer while its source
remains authorized; missing or inaccessible receipts return `404`. Receipt
status is `unmatched` when no Profile matched, `pending` while recipients await
dispatch, or `dispatched` when dispatch has settled for all recipients. Each
recipient includes `profile_id` and, once dispatch settles, `trigger_id`.
**`dispatched` does not mean the Runs succeeded.** Inspect their Trigger/Run
records or Dashboard for execution and delivery outcomes.

This first version accepts a single structured JSON CloudEvent per POST.
`specversion`, `id`, `source`, and `type` are required. Sources may be valid
relative URI references or absolute URIs. Data is optional and must be JSON;
`datacontenttype`, when supplied, must be `application/json` or an
`application/*+json` type, with an optional UTF-8 charset. Extension names use
lowercase letters/digits and values are strings, booleans, or 32-bit integers.
There are no provider adapters, batch envelopes, binary-mode CloudEvents,
`data_base64`, or compressed requests.

The durable inbox lives at `<Beacon home>/state/events/`. At acceptance Beacon
snapshots matching Profiles and their admin/notify destinations. Restart resumes
pending dispatch without rematching historical events, and each recipient
Profile is claimed once. Changing a listener affects only new events. Keep
Profiles referenced by pending receipts configured until dispatch settles;
removing one causes a visible fatal dispatch failure. Dispatch is serial and
waits for the shared Run queue, while HTTP acceptance remains independent.
Active Runs interrupted by restart fail rather than execute twice; failed Runs
are not retried automatically or retriggered by duplicate event delivery. Event
records, like existing state records, have no automatic retention cleanup;
manually deleting them removes deduplication history.

For remote senders, put HTTPS authentication-preserving reverse proxying in front
of the event port. Keep its default loopback binding when the proxy is on the
same host. Expose only the event endpoint, not Beacon's unauthenticated Dashboard.

## Commands

```text
beacon serve [--config <absolute-path>]
beacon doctor [--config <absolute-path>]
beacon trigger [--config <absolute-path>] --profile <id> --input -
beacon schedule trigger [--config <absolute-path>] --profile <id> --schedule <id>
beacon version
```

`serve`, `doctor`, `trigger`, and `schedule trigger` use `~/.beacon/config.yaml`
in the current running user's home directory when `--config` is omitted,
regardless of the working directory. An explicit override must be an absolute
path, for example `beacon serve --config /opt/beacon/config.yaml`.
Missing or invalid configuration and required dependency failures are reported
as errors with a nonzero exit status; Beacon does not fall back to another config.

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
the Profile `admin` channel, and may notify the Schedule `notify` channel, but does not read, initialize,
or advance the Schedule's cron cursor. Unknown
Profiles or Schedules and failed Runs or Deliveries exit non-zero; failure
messages include the `run_id` whenever a Run record was created.

## Final Outcomes

An Agent closes the conversational channel with `reply_text`, `reply_card`, or
`no_reply`, and may also call `notify_card` when the Run has a notify target:

- `reply_text` sends plain text. Inbound Feishu messages quote-reply the user.
  Schedules and event Runs message the Profile admin.
- `reply_card` sends an interactive card on the same conversational channel
  (inbound quote-reply, or Schedule/event admin chat). It closes that channel by
  itself.
- `no_reply` finishes without messaging the conversational channel. Its
  `reason` is stored for audit and is never sent. Do not use it on inbound
  messages.
- `notify_card` posts an interactive card to the Schedule or listener's configured group.
  Only valid when the Run has a notify target.

Which of `reply_text` / `reply_card` / `notify_card` / `no_reply` to use for a
business result is decided by the Profile persona/task (or the situation), not
hard-coded by Beacon beyond channel availability (`notify_card` needs a notify
target; inbound cannot `no_reply`).

The card tools accept a title, Feishu-compatible Markdown body, and up to five
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
card generation time. A Schedule or event `no_reply` without `notify_card` records a
successful Run with no Delivery. Failures `reply_text` a short error and never
notify a group. Manual local triggers print reply text/card and any notify card
as Markdown on stdout.

## State and failure behavior

Per-Profile state lives below `profiles/<profile-id>/state/`. Trigger claims, normalized inputs, Run state, Final Outcomes, Delivery state, and Schedule cursors use durable JSON snapshots. Records do not expire, and Beacon has no automatic cleanup task. Manually deleting state also deletes its deduplication memory.

Every new business Run also owns a permanent Pi session by default. Its Run
record stores both `sessionId` and `sessionPath`. For a fresh Trigger the
session ID is exactly the Beacon `runId`, and the path is the dedicated
directory `<pi.session_directory>/<profile-id>/<runId>/`. Pi receives that
mapping via `--session-dir`, `--session-id`, and a readable
`Beacon <profile-id> <runId>` name. The directory contains the Pi JSONL
session file and is never cleaned up by Beacon. A queued Run keeps the same
mapping after restart. Queued records written by Beacon 0.1.2 or earlier are
assigned the same deterministic mapping when recovered. Historical completed
records remain readable and may omit the two session fields because those Runs
were originally ephemeral.

When an inbound Feishu message is a quote-reply (`parent_id`) to a message
Beacon previously delivered (`reply_text` / `reply_card` / `notify_card`, or a
failure reply), Beacon looks up that outbound Feishu `message_id` on the
matching Delivery / notify Delivery (`providerRequestId`), then starts a new
Run that **reuses the prior Pi session** and appends one new user prompt.
Follow-up Runs keep their own `runId` but set `sessionId` / `sessionPath` to
the original session. If the quoted message is not a Beacon Delivery, or the
Delivery did not persist a Feishu `message_id`, Beacon falls back to a fresh
session.

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

Duplicate Feishu events, CloudEvents, and Schedule occurrences do not start a second Run. Active Runs interrupted by restart fail rather than rerun. Pending Delivery can resume, while a Delivery interrupted after its external call began fails without resending. Run and Delivery success are recorded independently. Beacon does not automatically retry either one.

Secrets and ephemeral Run Capability tokens are excluded from persisted records and from the Pi environment except for the one Run-scoped Outcome capability.

## launchd

Edit [`deploy/io.nettee.beacon.plist.example`](deploy/io.nettee.beacon.plist.example) so every executable, working-directory, and log path is absolute. The example runs `beacon serve` and loads the running user's `~/.beacon/config.yaml`; add `--config` and an absolute path to `ProgramArguments` to override it. Create the log directory, copy the plist to `~/Library/LaunchAgents/io.nettee.beacon.plist`, then validate and load it:

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
