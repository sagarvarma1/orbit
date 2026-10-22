export class BuildTimeoutError extends Error {
  constructor(readonly seconds: number) {
    super(`Build exceeded the ${seconds}s timeout`);
  }
}

export class BuildCanceledError extends Error {
  constructor() {
    super("Build canceled");
  }
}

export class BuildInterruptedError extends Error {
  constructor() {
    super("Build interrupted by a control plane shutdown");
  }
}

export type Worker = (id: string, signal: AbortSignal) => Promise<void>;

/**
 * FIFO build queue with a concurrency limit, per-job timeout and cancellation.
 * Jobs are identified by deployment id; the worker owns persistence and status changes.
 */
export class BuildQueue {
  private readonly pending: string[] = [];
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly worker: Worker,
    private readonly concurrency: number,
    private readonly timeoutSeconds: number,
  ) {}

  enqueue(id: string): void {
    if (this.pending.includes(id) || this.running.has(id)) return;
    this.pending.push(id);
    this.drain();
  }

  /** "dequeued" if it never started, "aborted" if it was running, false if unknown. */
  cancel(id: string): "dequeued" | "aborted" | false {
    const index = this.pending.indexOf(id);
    if (index !== -1) {
      this.pending.splice(index, 1);
      return "dequeued";
    }
    const controller = this.running.get(id);
    if (controller) {
      controller.abort(new BuildCanceledError());
      return "aborted";
    }
    return false;
  }

  /** Stop everything (shutdown). Running builds are killed; queued ones stay queued in the DB. */
  async shutdown(): Promise<void> {
    this.pending.length = 0;
    for (const controller of this.running.values()) controller.abort(new BuildInterruptedError());
    const deadline = Date.now() + 10_000;
    while (this.running.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  }

  position(id: string): number {
    return this.pending.indexOf(id);
  }

  stats(): { running: number; queued: number; concurrency: number } {
    return { running: this.running.size, queued: this.pending.length, concurrency: this.concurrency };
  }

  private drain(): void {
    while (this.running.size < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift()!;
      const controller = new AbortController();
      this.running.set(id, controller);
      const timer = setTimeout(() => controller.abort(new BuildTimeoutError(this.timeoutSeconds)), this.timeoutSeconds * 1000);
      this.worker(id, controller.signal)
        .catch((err) => console.error(`[queue] worker crashed for ${id}`, err))
        .finally(() => {
          clearTimeout(timer);
          this.running.delete(id);
          this.drain();
        });
    }
  }
}
