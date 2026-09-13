import type { Profile } from "../config/profile.js";
import type { TriggerInput } from "../domain/types.js";
import type { TriggerStore } from "../state/trigger-store.js";
import { occurrencesBetween } from "./cron.js";
import type { ScheduleCursorStore } from "./cursor-store.js";

export type ScheduleReconcilerOptions = {
  profile: Profile;
  triggers: TriggerStore;
  cursors: ScheduleCursorStore;
  maxOccurrences: number;
  process(
    triggerKey: string,
    normalize: () => Promise<TriggerInput>,
  ): Promise<void>;
};

export class ScheduleReconciler {
  constructor(private readonly options: ScheduleReconcilerOptions) {}

  async reconcile(now: Date): Promise<void> {
    for (const schedule of this.options.profile.schedules) {
      let cursor = await this.options.cursors.read(schedule.id);
      if (!cursor) {
        await this.options.cursors.initialize(schedule.id, now);
        continue;
      }
      const occurrences = occurrencesBetween(
        schedule.cron,
        schedule.timezone,
        new Date(cursor.through),
        now,
        this.options.maxOccurrences,
      );
      const latest = occurrences.at(-1);
      if (!latest) continue;
      const scheduledFor = latest.toISOString();
      const claim = await this.options.triggers.claim({
        sourceKey: ["schedule", schedule.id, scheduledFor],
        target: { kind: "chat", chatId: schedule.delivery.chatId },
        ingress: {
          scheduleId: schedule.id,
          scheduledFor,
          text: schedule.input,
        },
      });
      await this.options.cursors.advance(schedule.id, latest);
      cursor = { version: 1, scheduleId: schedule.id, through: scheduledFor };
      void cursor;
      if (!claim.created) continue;
      await this.options.process(claim.record.triggerKey, async () => ({
        kind: "schedule",
        scheduleId: schedule.id,
        scheduledFor,
        text: schedule.input,
      }));
    }
  }
}
