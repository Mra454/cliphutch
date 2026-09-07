import { describe, expect, it, vi } from "vitest";
import { createTrailingTaskScheduler } from "./trailing-task-scheduler";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createTrailingTaskScheduler", () => {
  it("runs one trailing pass for requests made while a pass is active", async () => {
    const firstPass = deferred();
    let runs = 0;
    const task = vi.fn(async () => {
      runs += 1;
      if (runs === 1) await firstPass.promise;
    });
    const scheduler = createTrailingTaskScheduler(task);

    const first = scheduler.request();
    const trailing = [
      scheduler.request(),
      scheduler.request(),
      scheduler.request(),
    ];
    firstPass.resolve();

    await Promise.all([first, ...trailing]);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("does not drop a request made after the loop exits but before cleanup", async () => {
    const firstPass = deferred();
    let runs = 0;
    const task = vi.fn(async () => {
      runs += 1;
      if (runs === 1) await firstPass.promise;
    });
    const scheduler = createTrailingTaskScheduler(task);

    const first = scheduler.request();
    // Register after the scheduler's await continuation. Resolving the gate
    // lets the loop exit first, then requests work before its finally runs.
    const trailing = firstPass.promise.then(() => scheduler.request());
    firstPass.resolve();

    await Promise.all([first, trailing]);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("rejects the affected request but permits a later recovery pass", async () => {
    let runs = 0;
    const scheduler = createTrailingTaskScheduler(async () => {
      runs += 1;
      if (runs === 1) throw new Error("temporary");
    });

    await expect(scheduler.request()).rejects.toThrow("temporary");
    await expect(scheduler.request()).resolves.toBeUndefined();
    expect(runs).toBe(2);
  });

  it("does not mistake a thrown undefined value for success", async () => {
    const scheduler = createTrailingTaskScheduler(async () => {
      throw undefined;
    });

    await expect(scheduler.request()).rejects.toBeUndefined();
  });
});
