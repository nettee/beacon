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
A configured Feishu-facing identity tied to exactly one Feishu Application, grouping its unified Prompt, workspace, Agent Runtime and model choices, message routing, schedules, and delivery defaults.
_Avoid_: Bot, Agent

**Trigger**:
A normalized request originating from an inbound message or a scheduled occurrence that asks Beacon to start one fresh Run.
_Avoid_: Message, event, task

**Run**:
One isolated attempt by an Agent Runtime to execute a Trigger and produce a Final Outcome.
_Avoid_: Conversation, session, job

**Run Capability**:
An ephemeral authority scoped to exactly one Run that lets its Agent Runtime submit that Run's Final Outcome without choosing or learning its Delivery Target.
_Avoid_: Session, channel token, bot credential

**Agent Runtime**:
An external execution boundary that accepts a Run request and returns its Final Outcome while keeping context management, tools, and model usage opaque to Beacon.
_Avoid_: Profile, Gateway

**Final Outcome**:
The single user-facing result explicitly submitted for a Run, or the explicit failure result produced when the Run cannot complete, which Beacon must deliver.
_Avoid_: Progress, trace, intermediate output

**Delivery Target**:
The exact reply or proactive-send location captured from a Trigger and bound to its Run; it is resolved and used only by Beacon, never selected by the Agent Runtime.
_Avoid_: Profile, destination prompt

**Delivery**:
An attempt to send a Final Outcome to a messaging destination using the Profile's application identity.
_Avoid_: Run, reply

**Schedule**:
A recurring rule that creates a Trigger for a Profile and names the destination for its eventual Delivery.
_Avoid_: launchd job, cron job

**Scheduled Occurrence**:
One nominal instant selected by a Schedule; Beacon may reconcile several overdue Scheduled Occurrences into one fresh Trigger after sleep or restart.
_Avoid_: Timer event, launchd invocation
