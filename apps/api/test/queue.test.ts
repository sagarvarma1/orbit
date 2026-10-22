import { describe, expect, it } from "vitest";
import { BuildCanceledError, BuildQueue, BuildTimeoutError } from "../src/build/queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake build that runs until aborted or `ms` elapses, recording how it ended. */
function fakeWorker(results: Map<string, string>, ms = 200) {
  let running = 0;
  let peak = 0;
  const worker = (id: string, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      const done = (how: string) => {
        running -= 1;
        results.set(id, how);
        resolve();
      };
      const timer = setTimeout(() => done("ok"), ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        const reason = signal.reason;
        done(reason instanceof BuildTimeoutError ? "timeout" : reason instanceof BuildCanceledError ? "canceled" : "aborted");
      });
    });
  return { worker, peak: () => peak };
}

describe("BuildQueue", () => {
  it("never runs more than `concurrency` builds at once", async () => {
    const results = new Map<string, string>();
    const { worker, peak } = fakeWorker(results, 50);
    const queue = new BuildQueue(worker, 2, 10);
    for (const id of ["a", "b", "c", "d", "e"]) queue.enqueue(id);
    expect(queue.stats()).toMatchObject({ running: 2, queued: 3 });
    await sleep(250);
    expect(peak()).toBe(2);
    expect([...results.values()]).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  it("cancels queued builds without running them and aborts running ones", async () => {
    const results = new Map<string, string>();
    const { worker } = fakeWorker(results, 300);
    const queue = new BuildQueue(worker, 1, 10);
    queue.enqueue("running");
    queue.enqueue("waiting");
    expect(queue.cancel("waiting")).toBe("dequeued");
    expect(queue.cancel("running")).toBe("aborted");
    expect(queue.cancel("unknown")).toBe(false);
    await sleep(20);
    expect(results.get("running")).toBe("canceled");
    expect(results.has("waiting")).toBe(false);
  });

  it("times out builds that run too long", async () => {
    const results = new Map<string, string>();
    const { worker } = fakeWorker(results, 5000);
    const queue = new BuildQueue(worker, 1, 0.1);
    queue.enqueue("slow");
    await sleep(250);
    expect(results.get("slow")).toBe("timeout");
  });
});
