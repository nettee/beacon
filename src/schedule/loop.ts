import type { Profile } from "../config/profile.js";
import { nextOccurrence } from "./cron.js";

type Reconciler = { reconcile(now: Date): Promise<void> };

const MAX_TIMER_MS = 2_147_000_000;

export class ScheduleLoop {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private active: Promise<void> | undefined;

  constructor(
    private readonly profile: Profile,
    private readonly reconciler: Reconciler,
    private readonly onFatal: (error: Error) => void,
  ) {}

  start(after: Date = new Date()): void {
    if (this.stopped || this.profile.schedules.length === 0) return;
    const next = this.profile.schedules
      .map((schedule) =>
        nextOccurrence(schedule.cron, schedule.timezone, after),
      )
      .sort((left, right) => left.getTime() - right.getTime())[0];
    if (!next) return;
    const delay = Math.max(
      0,
      Math.min(MAX_TIMER_MS, next.getTime() - Date.now()),
    );
    this.timer = setTimeout(() => {
      const now = new Date();
      const active = this.reconciler
        .reconcile(now)
        .then(() => this.start(now))
        .catch((error: unknown) =>
          this.onFatal(
            error instanceof Error ? error : new Error(String(error)),
          ),
        )
        .finally(() => {
          if (this.active === active) this.active = undefined;
        });
      this.active = active;
    }, delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async drain(): Promise<void> {
    await this.active;
  }
}
