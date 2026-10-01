export type QueueSubmission =
  | { accepted: false }
  | { accepted: true; completion: Promise<void> };

type Pending = {
  task: () => Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class RunQueue {
  private active = 0;
  private readonly pending: Pending[] = [];
  private readonly waiting: Pending[] = [];

  constructor(
    readonly maxConcurrent: number,
    readonly maxQueued: number,
  ) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new Error("maxQueued must be a non-negative integer");
    }
  }

  enqueue(task: () => Promise<void>): QueueSubmission {
    if (
      this.active >= this.maxConcurrent &&
      this.pending.length >= this.maxQueued
    ) {
      return { accepted: false };
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.pending.push({ task, resolve, reject });
    this.drain();
    return { accepted: true, completion };
  }

  /** Wait for admission without dropping already accepted, persisted event work. */
  enqueueWhenAvailable(task: () => Promise<void>): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      this.waiting.push({ task, resolve, reject });
    });
    this.drain();
    return completion;
  }

  private promoteWaiting(): void {
    while (
      this.waiting.length > 0 &&
      this.pending.length <
        this.maxQueued + Math.max(0, this.maxConcurrent - this.active)
    ) {
      this.pending.push(this.waiting.shift()!);
    }
  }

  private async execute(next: Pending): Promise<void> {
    try {
      await next.task();
      next.resolve();
    } catch (error) {
      next.reject(error);
    } finally {
      this.active -= 1;
      this.drain();
    }
  }

  private drain(): void {
    this.promoteWaiting();
    while (this.active < this.maxConcurrent) {
      const next = this.pending.shift();
      if (!next) return;
      this.active += 1;
      this.promoteWaiting();
      void this.execute(next);
    }
  }
}
