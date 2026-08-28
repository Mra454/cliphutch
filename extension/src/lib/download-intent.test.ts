import { describe, expect, it } from "vitest";
import {
  PersistentCommandGate,
  claimPendingIntent,
  clearPendingIntent,
  createDownloadCommandId,
  evaluateBulkAvailability,
  isDownloadCommandId,
  type PersistentCommandRecord,
  type PersistentCommandStore,
} from "./download-intent";

type Result = { ok: true; jobId: string } | { ok: false; error: string };

function memoryStore(
  records: Record<string, PersistentCommandRecord<Result>> = {},
): PersistentCommandStore<Result> {
  return {
    async read(commandId) {
      return records[commandId];
    },
    async write(commandId, record) {
      records[commandId] = structuredClone(record);
    },
  };
}

describe("download command ids", () => {
  it("creates and validates a namespaced UUID", () => {
    const commandId = createDownloadCommandId(
      () => "123e4567-e89b-42d3-a456-426614174000",
    );
    expect(commandId).toBe("download-123e4567-e89b-42d3-a456-426614174000");
    expect(isDownloadCommandId(commandId)).toBe(true);
  });

  it("rejects missing, malformed, and attacker-controlled ids", () => {
    expect(isDownloadCommandId(undefined)).toBe(false);
    expect(isDownloadCommandId("download-not-a-uuid")).toBe(false);
    expect(isDownloadCommandId("../../../download-command-records")).toBe(false);
  });
});

describe("synchronous customer-intent guard", () => {
  it("accepts only the first of ten activations before a render", () => {
    const latch = { current: false };
    const accepted = Array.from({ length: 10 }, () => claimPendingIntent(latch));
    expect(accepted.filter(Boolean)).toHaveLength(1);

    clearPendingIntent(latch);
    expect(claimPendingIntent(latch)).toBe(true);
  });
});

describe("PersistentCommandGate", () => {
  it("coalesces ten same-tick activations into one execution", async () => {
    const store = memoryStore();
    const gate = new PersistentCommandGate<Result>(
      store,
      async () => ({ ok: false, error: "interrupted" }),
    );
    let executions = 0;
    const execute = async (): Promise<Result> => {
      executions++;
      await Promise.resolve();
      return { ok: true, jobId: "job-1" };
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => gate.run("command", execute)),
    );

    expect(executions).toBe(1);
    expect(results).toEqual(Array.from({ length: 10 }, () => ({ ok: true, jobId: "job-1" })));
  });

  it("replays a settled result after a simulated worker restart", async () => {
    const records: Record<string, PersistentCommandRecord<Result>> = {};
    const store = memoryStore(records);
    const firstGate = new PersistentCommandGate<Result>(
      store,
      async () => ({ ok: false, error: "interrupted" }),
      () => 10,
    );
    await firstGate.run("command", async () => ({ ok: true, jobId: "job-1" }));

    let executions = 0;
    const restartedGate = new PersistentCommandGate<Result>(
      store,
      async () => ({ ok: false, error: "interrupted" }),
      () => 20,
    );
    const replay = await restartedGate.run("command", async () => {
      executions++;
      return { ok: true, jobId: "job-2" };
    });

    expect(replay).toEqual({ ok: true, jobId: "job-1" });
    expect(executions).toBe(0);
  });

  it("reconciles a persisted pending command without executing it again", async () => {
    const records: Record<string, PersistentCommandRecord<Result>> = {
      command: { version: 1, state: "pending", startedAt: 10 },
    };
    const store = memoryStore(records);
    let executions = 0;
    let recoveries = 0;
    const restartedGate = new PersistentCommandGate<Result>(
      store,
      async () => {
        recoveries++;
        return { ok: true, jobId: "job-already-started" };
      },
      () => 20,
    );

    const result = await restartedGate.run("command", async () => {
      executions++;
      return { ok: true, jobId: "duplicate" };
    });

    expect(result).toEqual({ ok: true, jobId: "job-already-started" });
    expect(recoveries).toBe(1);
    expect(executions).toBe(0);
    expect(records.command).toEqual({
      version: 1,
      state: "settled",
      startedAt: 10,
      settledAt: 20,
      response: { ok: true, jobId: "job-already-started" },
    });
  });

  it("leaves a tombstone when execution throws and reconciles on replay", async () => {
    const records: Record<string, PersistentCommandRecord<Result>> = {};
    const store = memoryStore(records);
    let recoveries = 0;
    const gate = new PersistentCommandGate<Result>(store, async () => {
      recoveries++;
      return { ok: false, error: "start state unknown" };
    });

    await expect(
      gate.run("command", async () => {
        throw new Error("worker interrupted");
      }),
    ).rejects.toThrow("worker interrupted");
    expect(records.command.state).toBe("pending");

    let duplicateExecutions = 0;
    const replay = await gate.run("command", async () => {
      duplicateExecutions++;
      return { ok: true, jobId: "duplicate" };
    });
    expect(replay).toEqual({ ok: false, error: "start state unknown" });
    expect(recoveries).toBe(1);
    expect(duplicateExecutions).toBe(0);
  });
});

describe("evaluateBulkAvailability", () => {
  it("allows an all-direct selection only when the whole quota fits", () => {
    const allowed = evaluateBulkAvailability(
      [
        { isStill: false, requiresOffscreen: false },
        { isStill: false, requiresOffscreen: false },
      ],
      { licensed: false, remainingVideoQuota: 2 },
    );
    expect(allowed.enabled).toBe(true);
    expect(allowed.description).toContain("2 free video downloads will be used");

    const partial = evaluateBulkAvailability(
      [
        { isStill: false, requiresOffscreen: false },
        { isStill: false, requiresOffscreen: false },
      ],
      { licensed: false, remainingVideoQuota: 1 },
    );
    expect(partial.enabled).toBe(false);
    expect(partial.reason).toContain("needs 2 video downloads");
  });

  it("keeps still-only bulk available at the video limit", () => {
    const result = evaluateBulkAvailability(
      [
        { isStill: true, requiresOffscreen: false },
        { isStill: true, requiresOffscreen: false },
      ],
      { licensed: false, remainingVideoQuota: 0 },
    );
    expect(result.enabled).toBe(true);
    expect(result.quotaRequired).toBe(0);
  });

  it("disables mixed/offscreen bulk instead of silently skipping items", () => {
    const result = evaluateBulkAvailability(
      [
        { isStill: false, requiresOffscreen: false },
        { isStill: false, requiresOffscreen: true },
      ],
      { licensed: true, remainingVideoQuota: 0 },
    );
    expect(result.enabled).toBe(false);
    expect(result.reason).toContain("HLS, DASH, or WebM");
  });
});
