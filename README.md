# Beacon

Beacon is a single-host service that turns Feishu messages and configured schedules into isolated Pi agent runs. Each accepted Trigger is durably claimed, produces exactly one explicit Final Outcome, and is delivered either as a quoted reply or to a configured Feishu `chat_id`.

This repository currently implements the Feishu + Pi MVP described by the active [Zest Dev Spec](specs/change/20260913-beacon-feishu-pi-mvp/spec.md).

## Requirements

- macOS with Node.js 22 or newer
- pnpm 10.33.2
- A Pi executable and Pi coding-agent directory
- One Feishu self-built application per Profile, configured for persistent-connection message events and the APIs needed to read/reply/react/create messages

## Install and build

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
```

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

Edit [`deploy/net.nettee.beacon.plist.example`](deploy/net.nettee.beacon.plist.example) so every executable, config, working-directory, and log path is absolute. Create the log directory, copy the plist to `~/Library/LaunchAgents/net.nettee.beacon.plist`, then validate and load it:

```sh
plutil -lint /Users/USERNAME/Library/LaunchAgents/net.nettee.beacon.plist
launchctl bootstrap gui/$(id -u) /Users/USERNAME/Library/LaunchAgents/net.nettee.beacon.plist
launchctl print gui/$(id -u)/net.nettee.beacon
```

The example uses a restrictive umask and asks launchd to restart only after abnormal exit. `SIGTERM` initiates an orderly shutdown: timers and Gateways stop, accepted intake work drains, and the local Outcome server closes.

## Development checks

```sh
pnpm check
pnpm typecheck
pnpm test
pnpm build
plutil -lint deploy/net.nettee.beacon.plist.example
```
