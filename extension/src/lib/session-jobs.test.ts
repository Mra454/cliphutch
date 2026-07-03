import { beforeEach, describe, expect, it } from "vitest";
import { putJobRecord, updateJobRecord, withKeyLock } from "./session-jobs";

type Job = { jobId: string; status: string; progress?: number };

const KEY = "jobs";
let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get(key: string) {
          return Promise.resolve(key in store ? { [key]: store[key] } : {});
        },
        set(items: Record<string, unknown>) {
          // Emulate a real async write: clone so callers can't mutate the
          // stored copy after the fact.
          Object.assign(store, structuredClone(items));
          return Promise.resolve();
        },
      },
    },
  };
});

const record = () => (store[KEY] ?? {}) as Record<string, Job>;

describe("updateJobRecord — terminal guard", () => {
  it("does not resurrect a job whose status changed to terminal", async () => {
    await putJobRecord<Job>(KEY, "a", { jobId: "a", status: "running" });

    // Two writers race: an error handler moves the job to a terminal state,
    // and a progress handler that should only apply while still running.
    await Promise.all([
      updateJobRecord<Job>(KEY, "a", (j) => {
        j.status = "error";
      }),
      updateJobRecord<Job>(KEY, "a", (j) => {
        if (j.status !== "running") return false;
        j.progress = 50;
      }),
    ]);

    // Whichever ordering the lock imposes, the job must not end up "running".
    expect(record().a.status).not.toBe("running");
    expect(record().a.status).toBe("error");
  });
});

describe("putJobRecord / updateJobRecord — no lost siblings", () => {
  it("serializes concurrent writes to different jobs in one record", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        putJobRecord<Job>(KEY, `job${i}`, { jobId: `job${i}`, status: "running" }),
      ),
    );
    expect(Object.keys(record())).toHaveLength(20);
  });

  it("does not lose a concurrent update to a different job", async () => {
    await putJobRecord<Job>(KEY, "a", { jobId: "a", status: "running" });
    await putJobRecord<Job>(KEY, "b", { jobId: "b", status: "running" });

    await Promise.all([
      updateJobRecord<Job>(KEY, "a", (j) => {
        j.status = "complete";
      }),
      updateJobRecord<Job>(KEY, "b", (j) => {
        j.status = "error";
      }),
    ]);

    expect(record().a.status).toBe("complete");
    expect(record().b.status).toBe("error");
  });
});

describe("updateJobRecord — absent job", () => {
  it("returns undefined and writes nothing when the job is gone", async () => {
    const out = await updateJobRecord<Job>(KEY, "missing", (j) => {
      j.status = "error";
    });
    expect(out).toBeUndefined();
    expect(store[KEY]).toBeUndefined();
  });
});

describe("withKeyLock — isolation and resilience", () => {
  it("runs operations for one key in submission order", async () => {
    const seen: number[] = [];
    await Promise.all([
      withKeyLock(KEY, async () => {
        await Promise.resolve();
        seen.push(1);
      }),
      withKeyLock(KEY, async () => {
        seen.push(2);
      }),
    ]);
    expect(seen).toEqual([1, 2]);
  });

  it("a rejected operation does not break later operations", async () => {
    await expect(
      withKeyLock(KEY, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await expect(withKeyLock(KEY, async () => "ok")).resolves.toBe("ok");
  });
});
