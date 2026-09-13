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
    if (this.active >= this.maxConcurrent && this.pending.length >= this.maxQueued) {
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

  private drain(): void {
    while (this.active < this.maxConcurrent) {
      const next = this.pending.shift();
      if (!next) return;
      this.active += 1;
      void next
        .task()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
