import type { EventProducer } from "../config/event-credentials.js";
import type { Profile } from "../config/profile.js";
import type { TriggerInput } from "../domain/types.js";
import type { TriggerStore } from "../state/trigger-store.js";
import { type CloudEvent, matchesListener } from "./cloudevent.js";
import {
  EventIntakeError,
  type EventRecord,
  type EventStore,
} from "./store.js";

export type EventContext = {
  profile: Profile;
  store: TriggerStore;
  orchestrator: {
    process(key: string, normalize: () => Promise<TriggerInput>): Promise<void>;
  };
};

export class EventPipeline {
  private work: Promise<void> | undefined;
  private requested = false;
  private stopped = false;
  private failure: Error | undefined;
  constructor(
    private readonly options: {
      store: EventStore;
      contexts: EventContext[];
      maxPending: number;
      onFatal(error: Error): void;
    },
  ) {}

  async accept(
    event: CloudEvent,
    producer: EventProducer,
  ): Promise<{ created: boolean; record: EventRecord }> {
    if (this.stopped || this.failure)
      throw new EventIntakeError(503, "Event intake unavailable");
    if (!producer.sources.includes(event.source))
      throw new EventIntakeError(403, "Event source is not authorized");
    const recipients = this.options.contexts
      .filter(
        ({ profile }) =>
          profile.listener && matchesListener(event, profile.listener),
      )
      .map(({ profile }) => {
        if (!profile.admin)
          throw new Error(
            `Listener Profile ${profile.id} has no admin destination`,
          );
        return {
          profileId: profile.id,
          chatId: profile.admin.chatId,
          ...(profile.listener?.notify
            ? { notifyChatId: profile.listener.notify.chatId }
            : {}),
        };
      });
    const result = await this.options.store.accept(
      event,
      producer.id,
      recipients,
      this.options.maxPending,
    );
    this.wake();
    return result;
  }

  /** Call after Profile orchestrator recovery and after the HTTP listener binds. */
  wake(): void {
    if (this.stopped || this.failure) return;
    this.requested = true;
    if (this.work) return;
    this.work = this.pump()
      .catch((error: unknown) => {
        this.failure = new Error(
          `Event dispatch failed: ${error instanceof Error ? error.message : "unknown error"}`,
          { cause: error },
        );
        this.options.onFatal(this.failure);
      })
      .finally(() => {
        this.work = undefined;
        if (this.requested && !this.stopped && !this.failure) this.wake();
      });
  }

  private async pump(): Promise<void> {
    while (this.requested && !this.stopped) {
      this.requested = false;
      for (const record of await this.options.store.pending()) {
        for (const recipient of record.recipients) {
          if (this.stopped) return;
          if (recipient.triggerId) continue;
          const context = this.options.contexts.find(
            ({ profile }) => profile.id === recipient.profileId,
          );
          if (!context)
            throw new Error(
              `Pending Event ${record.receiptId} requires missing Profile ${recipient.profileId}`,
            );
          const input: TriggerInput = { kind: "event", event: record.event };
          const claimed = await context.store.claim({
            sourceKey: ["event", record.event.source, record.event.id],
            acceptedAt: new Date(record.acceptedAt),
            target: { kind: "chat", chatId: recipient.chatId },
            ...(recipient.notifyChatId
              ? {
                  notifyTarget: {
                    kind: "chat" as const,
                    chatId: recipient.notifyChatId,
                  },
                }
              : {}),
            input,
          });
          // Existing claims were recovered by the orchestrator before intake starts.
          if (claimed.created)
            await context.orchestrator.process(
              claimed.record.triggerKey,
              async () => input,
            );
          await this.options.store.markDispatched(
            record.receiptId,
            recipient.profileId,
            claimed.record.triggerId,
          );
        }
      }
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.work;
    if (this.failure) throw this.failure;
  }
  async drain(): Promise<void> {
    while (this.work) await this.work;
    if (this.failure) throw this.failure;
  }
}
