# Implementation

<!-- High-signal implementation notes. Focus on material deviations and what future work must preserve; do not mirror every Plan ticket. -->

## Outcome

- Beacon now loads all strict Profiles and credentials before external startup, durably claims Feishu and Schedule Triggers, runs them through a bounded global Pi queue with exactly-once Final Outcomes, and records Run and typed Delivery terminal states independently.
- The production surface includes `serve`, read-only-state `doctor`, stdin `trigger`, `version`, persistent Schedule reconciliation, restart recovery, permanent records, a launchd example, and operator configuration documentation.

## Deviations

None found.

## Verification

- Fresh final-worktree gates: `npm test` passed 65/65; `npm run check` and `npm run build` exited 0; `plutil -lint deploy/io.nettee.beacon.plist.example` reported `OK`.
- Built-product EAG: copied the freshly built `dist/` to a one-time `/tmp` home, substituted only disposable Pi and Feishu boundary adapters, and ran `node <tmp>/app/dist/cli.js serve --config <tmp>/home/config.yaml`. One duplicated group event with a quoted parent plus one overdue Schedule produced exactly two records and two Pi processes. Snapshots contained one `run=succeeded`, one accepted agent Outcome, and one `delivery=delivered` each; Feishu evidence contained exactly one reply to `om_group_current` with `reply_in_thread:false` and exactly one create with `receive_id_type:chat_id` / `receive_id:oc_schedule_target`.
- Each disposable Pi process invoked the built `beacon outcome submit` twice: the first submission exited 0 and the second exited 1 with `Final Outcome already submitted`. Ordinary assistant text was not delivered.
- Duplicate/restart check: serving the same durable state with the same event left Pi-run count `2 -> 2` and record count `2 -> 2`; no acknowledgement, context fetch, or Delivery was attempted for the duplicate.
- Delivery-failure check: a fresh group Trigger with a Feishu business error created one Pi Run and persisted `run=succeeded`, agent Outcome `group outcome`, and `delivery=failed` with `delivery_api_failed`; the Run was not rewritten as failed.
- Recovery check: seeded valid claim-only and `run=running` snapshots, then started the built CLI. Both became `service_interrupted` failures and delivered Beacon failure Outcomes while Pi-run count remained `3 -> 3`; already claimed/started work was not rerun. The final shutdown-race change was then rebuilt and rechecked with a fresh Schedule: Pi-run count `3 -> 4`, typed chat Delivery completed, SIGTERM exited 0, and the new `drains an in-flight reconciliation during shutdown` test passed.
- Security check: recursive snapshot scans found neither the fixture Feishu secret, capability environment names, nor any standalone 43-character base64url Run token. Across four Pi invocations the Feishu secret and all fixture-only service variables were absent; the effective environment contained only the documented inherited keys, the three intended Outcome capability/CLI keys, and macOS-provided `__CF_USER_TEXT_ENCODING`.
- Failed items: none.

EAG: PASS

## Spec Retrospective

- The initial plan did not state how the first cursor for a newly configured Schedule should be initialized. The Design was amended before implementation to initialize it at discovery time, avoiding unbounded historical backfill.
- The public manual CLI needed an explicit `manual` TriggerInput and `local_stdout` Delivery Target instead of impersonating a Feishu or Schedule Trigger; this seam should be named in future CLI plans up front.
