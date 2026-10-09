# Beacon

Beacon connects messaging applications to agent runtimes while keeping platform communication, configured identity, and agent execution as separate concepts.

## Language

**Beacon Service**:
The long-running bridge that accepts Triggers, creates Runs, and delivers each Run's Final Outcome through a Profile.
_Avoid_: Agent, Bot

**Gateway**:
The messaging-platform boundary that receives platform events and sends platform messages without interpreting agent-internal state.
_Avoid_: Agent gateway, Runtime

**Feishu Application**:
An organization-installed Feishu application with a Bot identity that can receive events and call Feishu APIs.
_Avoid_: Custom bot, webhook bot, one-time bot

**Profile**:
A configured Feishu-facing identity tied to exactly one Feishu Application, grouping its unified Prompt, Playbook, Agent Runtime and model choices, message routing, schedules, an optional Listener, and delivery defaults.
_Avoid_: Bot, Agent

**Playbook**:
The Profile's local working directory for Agent Runtime file access, SOP content, and optional `.beacon-profile` persona/task pair. Configured as `playbook` in profile.yaml (Workspace rename complete; `workspace` key is no longer accepted).
_Avoid_: Workspace, Playground, working copy, repo root (unless that directory is the Playbook)

**Trigger**:
A normalized request for one Profile, originating from direct input, a scheduled occurrence, or a matching Event, that asks Beacon to start one fresh Run.
_Avoid_: Message, event, task

**Event**:
A fact reported by an external system, described using CloudEvents. An Event may match zero or more Profiles and produce a separate Trigger for each matching Profile.
_Avoid_: Trigger, Run

**Listener**:
A Profile's optional subscription rule declaring which Events it is interested in. A matching Event creates a Trigger for that Profile.
_Avoid_: HTTP server, Gateway

**Run**:
One isolated attempt by an Agent Runtime to execute a Trigger and produce a Final Outcome.
_Avoid_: Conversation, session, job

**Run Capability**:
An ephemeral authority scoped to exactly one Run that lets its Agent Runtime submit that Run's Final Outcome without choosing the Delivery address.
_Avoid_: Session, channel token, bot credential

**Agent Runtime**:
An external execution boundary that accepts a Run request and returns its Final Outcome while keeping context management, tools, and model usage opaque to Beacon.
_Avoid_: Profile, Gateway

**Final Outcome**:
The reply and optional notify result explicitly submitted for a Run, or the explicit failure result produced when the Run cannot complete, which Beacon must deliver on the bound channels.
_Avoid_: Progress, trace, intermediate output

**Delivery Target**:
The exact reply location and optional notify location captured from a Trigger and bound to its Run; addresses are resolved and used only by Beacon. The Agent Runtime may choose which bound channel to use (`reply_text` / `reply_card` / `no_reply` / `notify_card`) but never supplies a `chat_id`.
_Avoid_: Profile, destination prompt

**Delivery**:
An attempt to send a Final Outcome to a messaging destination using the Profile's application identity.
_Avoid_: Run, reply

**Schedule**:
A recurring rule that creates a Trigger for a Profile, replies to the Profile admin, and may name a group for `notify_card`.
_Avoid_: launchd job, cron job

**Scheduled Occurrence**:
One nominal instant selected by a Schedule; Beacon may reconcile several overdue Scheduled Occurrences into one fresh Trigger after sleep or restart.
_Avoid_: Timer event, launchd invocation
