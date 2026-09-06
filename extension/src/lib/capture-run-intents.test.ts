import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureReviewPlanV1 } from "./capture-pack-types";
import {
  abandonCaptureRunIntent,
  CAPTURE_RUN_INTENTS_STORAGE_KEY,
  MAX_SETTLED_CAPTURE_RUN_INTENTS,
  captureRunIntentDecisionMatches,
  captureRunIntentRequestMatches,
  createCaptureRunIntent,
  digestCaptureRunExecutionPlan,
  finalizeCaptureRunIntent,
  getCaptureRunIntent,
  getNewestUnresolvedCaptureRunIntent,
  isCaptureRunIntentUnresolved,
  listCaptureRunIntents,
  repairCaptureRunIntentJournal,
  updateCaptureRunIntentAutoReconcileState,
  type CaptureRunIntentCreateInput,
  type CaptureRunIntentV1,
} from "./capture-run-intents";

const storage: Record<string, unknown> = {};
let failGet = false;
let failSet = false;
let applyThenFailSet = false;
let failNextGet = false;

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  failGet = false;
  failSet = false;
  applyThenFailSet = false;
  failNextGet = false;
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => {
          if (failGet || failNextGet) {
            failNextGet = false;
            throw new Error("get failed");
          }
          return Object.prototype.hasOwnProperty.call(storage, key)
            ? { [key]: storage[key] }
            : {};
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          if (applyThenFailSet) {
            Object.assign(storage, values);
            throw new Error("acknowledgement lost");
          }
          if (failSet) throw new Error("set failed");
          Object.assign(storage, values);
        }),
      },
    },
  });
});

function command(index = 1): string {
  return `capture-run-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function input(index = 1): CaptureRunIntentCreateInput {
  return {
    commandId: command(index),
    planId: `plan-${index}`,
    draftId: "draft-1",
    draftRevision: 3,
    requestedFreeVideoItemIds: ["video-a"],
    licensed: false,
    allocatedVideoItemIds: ["video-a"],
    executionPlanDigest: String(index % 10).repeat(64),
    createdAt: index,
  };
}

function plan(): CaptureReviewPlanV1 {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    draftId: "draft-1",
    draftRevision: 3,
    generatedAt: 10,
    relativeRoot: "ClipHutch/Pack",
    items: [{
      itemId: "video-a",
      include: true,
      media: {
        mediaId: "media-a",
        kind: "direct",
        url: "https://cdn.example/video.mp4",
        detectedAt: 1,
        provenance: ["network"],
      },
      plannedRelativePath: "ClipHutch/Pack/example/video.mp4",
      readiness: "ready",
      copyChoice: { candidateId: "media-a", confidence: "exact", reason: "Exact." },
      qualityChoice: { mode: "direct" },
      warnings: [],
    }],
    totals: {
      included: 1,
      videos: 1,
      stills: 0,
      unknownSizeCount: 1,
      requiredFreeVideoSlots: 1,
    },
  };
}

function currentIndex(): {
  schemaVersion: 1;
  orderedCommandIds: string[];
  records: Record<string, CaptureRunIntentV1>;
} {
  return storage[CAPTURE_RUN_INTENTS_STORAGE_KEY] as ReturnType<typeof currentIndex>;
}

describe("Capture Run intent journal", () => {
  it("freezes the first decision and replays it when entitlement changes", async () => {
    const created = await createCaptureRunIntent(input());
    expect(created).toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      intent: { licensed: false, allocatedVideoItemIds: ["video-a"], status: "pending" },
    });

    const retry = await createCaptureRunIntent({
      ...input(),
      licensed: true,
      allocatedVideoItemIds: ["video-a", "video-b"],
      executionPlanDigest: "f".repeat(64),
      createdAt: 999,
    });
    expect(retry).toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
      intent: {
        licensed: false,
        allocatedVideoItemIds: ["video-a"],
        executionPlanDigest: "1".repeat(64),
        createdAt: 1,
      },
    });
  });

  it("defaults and persists automatic reconcile state for old-shape records", async () => {
    const created = await createCaptureRunIntent(input());
    expect(created).toMatchObject({
      ok: true,
      intent: {
        autoReconcileAttemptCount: 0,
        needsManualReconcile: false,
      },
    });
    const stored = currentIndex().records[command()];
    delete (stored as Record<string, unknown>).autoReconcileAttemptCount;
    delete (stored as Record<string, unknown>).needsManualReconcile;
    delete (stored as Record<string, unknown>).autoReconcileLastAttemptAt;

    await expect(getCaptureRunIntent(command())).resolves.toMatchObject({
      ok: true,
      intent: {
        autoReconcileAttemptCount: 0,
        needsManualReconcile: false,
      },
    });

    await expect(updateCaptureRunIntentAutoReconcileState({
      commandId: command(),
      state: {
        autoReconcileAttemptCount: 5,
        autoReconcileLastAttemptAt: 50_000,
        needsManualReconcile: true,
      },
    })).resolves.toMatchObject({
      ok: true,
      intent: {
        autoReconcileAttemptCount: 5,
        autoReconcileLastAttemptAt: 50_000,
        needsManualReconcile: true,
      },
    });
  });

  it("resets automatic reconcile state when a run intent becomes accepted", async () => {
    const created = await createCaptureRunIntent(input());
    if (!created.ok) throw new Error("create failed");
    await updateCaptureRunIntentAutoReconcileState({
      commandId: command(),
      state: {
        autoReconcileAttemptCount: 2,
        autoReconcileLastAttemptAt: 20_000,
        needsManualReconcile: true,
      },
    });
    await expect(finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:00000000-0000-4000-8000-000000000001",
      disposition: "accepted",
    })).resolves.toMatchObject({
      ok: true,
      intent: {
        autoReconcileAttemptCount: 0,
        needsManualReconcile: false,
      },
    });
    expect(currentIndex().records[command()].autoReconcileLastAttemptAt).toBeUndefined();
  });

  it("canonicalizes command UUID casing before journal ownership", async () => {
    const uppercaseCommand = `capture-run-${command().slice("capture-run-".length).toUpperCase()}`;
    await expect(createCaptureRunIntent({ ...input(), commandId: uppercaseCommand }))
      .resolves.toMatchObject({
        ok: true,
        replayed: false,
        intent: { commandId: command() },
      });
    await expect(createCaptureRunIntent(input())).resolves.toMatchObject({
      ok: true,
      replayed: true,
      intent: { commandId: command() },
    });
    expect(currentIndex().orderedCommandIds).toEqual([command()]);
  });

  it("conflicts when the same command is reused for a different UI request", async () => {
    await createCaptureRunIntent(input());
    await expect(createCaptureRunIntent({ ...input(), planId: "plan-other" })).resolves.toMatchObject({
      ok: false,
      reason: "command_conflict",
      commandId: command(),
      intent: { planId: "plan-1" },
    });
    await expect(createCaptureRunIntent({
      ...input(),
      requestedFreeVideoItemIds: ["video-b"],
      allocatedVideoItemIds: ["video-b"],
    })).resolves.toMatchObject({ ok: false, reason: "command_conflict" });
  });

  it("freezes the exact lease map and conflicts a same-command map change", async () => {
    const mutableMap = { "video-a": "lease-a", "image-b": "lease-b" };
    const created = await createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: mutableMap,
    });
    expect(created).toMatchObject({
      ok: true,
      intent: { headerLeaseIdsByItemId: { "video-a": "lease-a", "image-b": "lease-b" } },
    });
    mutableMap["video-a"] = "lease-mutated";
    await expect(getCaptureRunIntent(command())).resolves.toMatchObject({
      ok: true,
      intent: { headerLeaseIdsByItemId: { "video-a": "lease-a", "image-b": "lease-b" } },
    });
    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: { "image-b": "lease-b", "video-a": "lease-a" },
    })).resolves.toMatchObject({
      ok: true,
      replayed: true,
    });
    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: { "video-a": "lease-changed", "image-b": "lease-b" },
    })).resolves.toMatchObject({ ok: false, reason: "command_conflict" });
  });

  it("finalizes idempotently and rejects a second run owner", async () => {
    await createCaptureRunIntent(input());
    const finalized = await finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:one",
      disposition: "accepted",
    });
    expect(finalized).toMatchObject({
      ok: true,
      changed: true,
      intent: {
        status: "committed",
        runId: "capture-run:v1:one",
        reconciliationDisposition: "accepted",
      },
    });
    await expect(finalizeCaptureRunIntent({
      commandId: `capture-run-${command().slice("capture-run-".length).toUpperCase()}`,
      runId: "capture-run:v1:one",
      disposition: "accepted",
    })).resolves.toMatchObject({ ok: true, changed: false });
    await expect(finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:other",
      disposition: "accepted",
    })).resolves.toMatchObject({
      ok: false,
      reason: "run_conflict",
      existingRunId: "capture-run:v1:one",
    });
  });

  it("keeps ambiguous commits unresolved and promotes same-run disposition monotonically", async () => {
    await createCaptureRunIntent(input());
    await expect(finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:one",
      disposition: "commit_state_unknown",
    })).resolves.toMatchObject({
      ok: true,
      changed: true,
      intent: { reconciliationDisposition: "commit_state_unknown" },
    });
    await expect(createCaptureRunIntent(input(2))).resolves.toMatchObject({
      ok: false,
      reason: "unresolved_intent",
      commandId: command(),
    });
    await expect(getNewestUnresolvedCaptureRunIntent()).resolves.toMatchObject({
      ok: true,
      intent: { commandId: command(), reconciliationDisposition: "commit_state_unknown" },
    });

    await finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:one",
      disposition: "recovery_needed",
    });
    await expect(finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:one",
      disposition: "commit_state_unknown",
    })).resolves.toMatchObject({
      ok: true,
      changed: false,
      intent: { reconciliationDisposition: "recovery_needed" },
    });
    await expect(finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:one",
      disposition: "accepted",
    })).resolves.toMatchObject({
      ok: true,
      changed: true,
      intent: { reconciliationDisposition: "accepted" },
    });
    await expect(finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:one",
      disposition: "recovery_needed",
    })).resolves.toMatchObject({
      ok: true,
      changed: false,
      intent: { reconciliationDisposition: "accepted" },
    });
    await expect(getNewestUnresolvedCaptureRunIntent()).resolves.toMatchObject({
      ok: true,
      intent: null,
    });
    await expect(createCaptureRunIntent(input(2))).resolves.toMatchObject({ ok: true });
  });

  it("normalizes legacy committed records to unresolved and repairs them canonically", async () => {
    await createCaptureRunIntent(input());
    await finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:one",
      disposition: "accepted",
    });
    const legacy = currentIndex().records[command()] as unknown as Record<string, unknown>;
    delete legacy.reconciliationDisposition;
    delete legacy.headerLeaseIdsByItemId;

    const listed = await listCaptureRunIntents();
    expect(listed).toMatchObject({
      ok: true,
      repairNeeded: true,
      intents: [{
        status: "committed",
        reconciliationDisposition: "commit_state_unknown",
      }],
    });
    if (!listed.ok) throw new Error("legacy fixture failed");
    expect(isCaptureRunIntentUnresolved(listed.intents[0])).toBe(true);
    await expect(repairCaptureRunIntentJournal()).resolves.toMatchObject({
      ok: true,
      changed: true,
    });
    expect(currentIndex().records[command()]).toMatchObject({
      reconciliationDisposition: "commit_state_unknown",
      headerLeaseIdsByItemId: {},
    });
  });

  it("abandons only the exact pending decision after definitive rejection", async () => {
    await createCaptureRunIntent(input());
    await expect(abandonCaptureRunIntent({
      commandId: command(),
      executionPlanDigest: "f".repeat(64),
    })).resolves.toMatchObject({ ok: false, reason: "command_conflict" });
    await expect(abandonCaptureRunIntent({
      commandId: command(),
      executionPlanDigest: "1".repeat(64),
    })).resolves.toEqual({ ok: true, changed: true, commitState: "committed" });
    await expect(getCaptureRunIntent(command())).resolves.toMatchObject({ ok: true, intent: null });

    await createCaptureRunIntent(input(2));
    await finalizeCaptureRunIntent({
      commandId: command(2),
      runId: "capture-run:v1:two",
      disposition: "accepted",
    });
    await expect(abandonCaptureRunIntent({
      commandId: command(2),
      executionPlanDigest: "2".repeat(64),
    })).resolves.toMatchObject({ ok: false, reason: "run_conflict" });
  });

  it("reads and lists defensive canonical clones", async () => {
    await createCaptureRunIntent(input(1));
    await finalizeCaptureRunIntent({
      commandId: command(1),
      runId: "capture-run:v1:one",
      disposition: "accepted",
    });
    await createCaptureRunIntent(input(2));
    const listed = await listCaptureRunIntents();
    expect(listed).toMatchObject({
      ok: true,
      repairNeeded: false,
      intents: [{ commandId: command(2) }, { commandId: command(1) }],
    });
    if (!listed.ok) return;
    listed.intents[0].allocatedVideoItemIds.push("mutated");
    (listed.intents[0].headerLeaseIdsByItemId as Record<string, string>)["video-a"] = "mutated";
    const reread = await getCaptureRunIntent(command(2));
    expect(reread).toMatchObject({
      ok: true,
      intent: { allocatedVideoItemIds: ["video-a"], headerLeaseIdsByItemId: {} },
    });
  });

  it("reports exact absent, committed, and unknown outcomes after rejected writes", async () => {
    failSet = true;
    await expect(createCaptureRunIntent(input())).resolves.toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      commitState: "absent",
    });

    failSet = false;
    applyThenFailSet = true;
    await expect(createCaptureRunIntent(input(2))).resolves.toMatchObject({
      ok: true,
      changed: true,
      commitState: "committed",
      intent: { commandId: command(2) },
    });

    applyThenFailSet = false;
    await finalizeCaptureRunIntent({
      commandId: command(2),
      runId: "capture-run:v1:two",
      disposition: "accepted",
    });
    failSet = true;
    const originalSet = chrome.storage.session.set;
    chrome.storage.session.set = vi.fn(async (values) => {
      failNextGet = true;
      return originalSet(values);
    });
    await expect(createCaptureRunIntent(input(3))).resolves.toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      commitState: "unknown",
    });
  });

  it("classifies a rejected finalize write against the previous pending record as absent", async () => {
    await createCaptureRunIntent(input());
    failSet = true;
    await expect(finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:one",
      disposition: "recovery_needed",
    })).resolves.toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      commitState: "absent",
    });
    await expect(getCaptureRunIntent(command())).resolves.toMatchObject({
      ok: true,
      intent: { status: "pending" },
    });
  });

  it("atomically blocks a different command while an intent is unresolved", async () => {
    await expect(createCaptureRunIntent(input(1))).resolves.toMatchObject({ ok: true });
    await expect(createCaptureRunIntent(input(2))).resolves.toMatchObject({
      ok: false,
      reason: "unresolved_intent",
      commandId: command(1),
      intent: { commandId: command(1), status: "pending" },
    });
    await expect(createCaptureRunIntent(input(1))).resolves.toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(currentIndex().orderedCommandIds).toEqual([command(1)]);
  });

  it("retains 200 settled decisions and prunes only the oldest settled record", async () => {
    for (let index = 1; index <= MAX_SETTLED_CAPTURE_RUN_INTENTS + 1; index += 1) {
      expect((await createCaptureRunIntent(input(index))).ok).toBe(true);
      expect((await finalizeCaptureRunIntent({
        commandId: command(index),
        runId: `capture-run:v1:${index}`,
        disposition: "accepted",
      })).ok).toBe(true);
    }
    expect(currentIndex().orderedCommandIds).toHaveLength(MAX_SETTLED_CAPTURE_RUN_INTENTS);
    expect(currentIndex().records[command(1)]).toBeUndefined();
    expect(currentIndex().records[command(MAX_SETTLED_CAPTURE_RUN_INTENTS + 1)]).toBeDefined();

    const unresolvedIndex = MAX_SETTLED_CAPTURE_RUN_INTENTS + 2;
    await createCaptureRunIntent(input(unresolvedIndex));
    await finalizeCaptureRunIntent({
      commandId: command(unresolvedIndex),
      runId: `capture-run:v1:${unresolvedIndex}`,
      disposition: "recovery_needed",
    });
    await repairCaptureRunIntentJournal();
    expect(currentIndex().records[command(unresolvedIndex)]).toMatchObject({
      reconciliationDisposition: "recovery_needed",
    });
    expect(currentIndex().orderedCommandIds).toHaveLength(MAX_SETTLED_CAPTURE_RUN_INTENTS + 1);
  });

  it("repairs duplicate ordering and valid records missing from the order hint", async () => {
    await createCaptureRunIntent(input(1));
    await finalizeCaptureRunIntent({
      commandId: command(1),
      runId: "capture-run:v1:one",
      disposition: "accepted",
    });
    await createCaptureRunIntent(input(2));
    currentIndex().orderedCommandIds = [command(1), command(1)];
    await expect(getCaptureRunIntent(command())).resolves.toMatchObject({
      ok: true,
      intent: { commandId: command() },
      repairNeeded: true,
    });
    const repaired = await repairCaptureRunIntentJournal();
    expect(repaired).toMatchObject({ ok: true, changed: true, prunedCommandIds: [] });
    expect(currentIndex().orderedCommandIds).toEqual([command(2), command(1)]);
  });

  it("fails closed when an order hint is the only evidence of command ownership", async () => {
    await createCaptureRunIntent(input());
    currentIndex().orderedCommandIds = [command(99), command()];
    await expect(createCaptureRunIntent(input(99))).resolves.toEqual({
      ok: false,
      reason: "storage_corrupt",
      key: CAPTURE_RUN_INTENTS_STORAGE_KEY,
    });
  });

  it("does not mistake a canonicalized read for an applied repair write", async () => {
    await createCaptureRunIntent(input(1));
    await finalizeCaptureRunIntent({
      commandId: command(1),
      runId: "capture-run:v1:one",
      disposition: "accepted",
    });
    await createCaptureRunIntent(input(2));
    currentIndex().orderedCommandIds = [command(1), command(1)];
    failSet = true;
    await expect(repairCaptureRunIntentJournal()).resolves.toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      commitState: "absent",
    });
    expect(currentIndex().orderedCommandIds).toEqual([command(1), command(1)]);
  });

  it("serializes concurrent different-command creates and admits exactly one", async () => {
    const results = await Promise.all([
      createCaptureRunIntent(input(1)),
      createCaptureRunIntent(input(2)),
      createCaptureRunIntent(input(3)),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok).every(
      (result) => !result.ok && result.reason === "unresolved_intent",
    )).toBe(true);
    expect(currentIndex().orderedCommandIds).toHaveLength(1);
  });

  it("lets exactly one concurrent same-command decision win", async () => {
    const [first, second] = await Promise.all([
      createCaptureRunIntent(input()),
      createCaptureRunIntent({
        ...input(),
        licensed: true,
        allocatedVideoItemIds: ["video-a", "video-b"],
        executionPlanDigest: "f".repeat(64),
      }),
    ]);
    expect(first).toMatchObject({ ok: true, replayed: false, intent: { licensed: false } });
    expect(second).toMatchObject({ ok: true, replayed: true, intent: { licensed: false } });
    expect(currentIndex().orderedCommandIds).toEqual([command()]);
  });

  it("rejects noncanonical, URL-shaped, duplicate, and inconsistent inputs", async () => {
    await expect(createCaptureRunIntent({
      ...input(),
      extra: true,
    } as CaptureRunIntentCreateInput)).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    await expect(createCaptureRunIntent({
      ...input(),
      planId: "https://example.test/plan",
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    await expect(createCaptureRunIntent({
      ...input(),
      requestedFreeVideoItemIds: ["video-a", "video-a"],
      allocatedVideoItemIds: ["video-a", "video-a"],
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    await expect(createCaptureRunIntent({
      ...input(),
      allocatedVideoItemIds: ["video-b"],
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });

    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: { "video-a": "https://evil.test/lease" },
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: { "video-a": "lease-same", "video-b": "lease-same" },
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [`item-${index}`, `lease-${index}`]),
      ),
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });

    const accessorMap = {} as Record<string, string>;
    Object.defineProperty(accessorMap, "video-a", {
      enumerable: true,
      get: () => "lease-a",
    });
    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: accessorMap,
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });

    const symbolMap = { "video-a": "lease-a" } as Record<PropertyKey, string>;
    symbolMap[Symbol("hidden")] = "lease-hidden";
    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: symbolMap,
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });

    const nonEnumerableMap = {} as Record<string, string>;
    Object.defineProperty(nonEnumerableMap, "video-a", {
      enumerable: false,
      value: "lease-a",
    });
    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: nonEnumerableMap,
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: Object.create({ "video-a": "lease-a" }),
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });

    const revocable = Proxy.revocable({ "video-a": "lease-a" }, {});
    revocable.revoke();
    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: revocable.proxy,
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    await expect(createCaptureRunIntent({
      ...input(),
      headerLeaseIdsByItemId: { "video-a": "x".repeat(257) },
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("fails closed on corrupt records and makes hostile public inputs total", async () => {
    storage[CAPTURE_RUN_INTENTS_STORAGE_KEY] = {
      schemaVersion: 1,
      orderedCommandIds: [command()],
      records: { [command()]: { schemaVersion: 1, status: "pending", url: "https://evil.test" } },
    };
    await expect(listCaptureRunIntents()).resolves.toEqual({
      ok: false,
      reason: "storage_corrupt",
      key: CAPTURE_RUN_INTENTS_STORAGE_KEY,
    });

    const { proxy, revoke } = Proxy.revocable(input(), {});
    revoke();
    await expect(createCaptureRunIntent(proxy)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_input",
    });
    expect(captureRunIntentRequestMatches(proxy, proxy)).toBe(false);
    expect(captureRunIntentDecisionMatches(proxy, proxy)).toBe(false);
  });

  it("matches request and decision fields independently", async () => {
    const created = await createCaptureRunIntent(input());
    if (!created.ok) throw new Error("fixture failed");
    expect(captureRunIntentRequestMatches(created.intent, input())).toBe(true);
    expect(captureRunIntentRequestMatches(created.intent, { ...input(), draftRevision: 4 })).toBe(false);
    expect(captureRunIntentDecisionMatches(created.intent, {
      licensed: false,
      allocatedVideoItemIds: ["video-a"],
      executionPlanDigest: "1".repeat(64),
    })).toBe(true);
    expect(captureRunIntentDecisionMatches(created.intent, {
      licensed: true,
      allocatedVideoItemIds: ["video-a"],
      executionPlanDigest: "1".repeat(64),
    })).toBe(false);

    await finalizeCaptureRunIntent({
      commandId: command(),
      runId: "capture-run:v1:one",
      disposition: "accepted",
    });
    const withLease = await createCaptureRunIntent({
      ...input(2),
      headerLeaseIdsByItemId: { "video-a": "lease-a" },
    });
    if (!withLease.ok) throw new Error("lease fixture failed");
    expect(captureRunIntentDecisionMatches(withLease.intent, {
      licensed: false,
      allocatedVideoItemIds: ["video-a"],
      headerLeaseIdsByItemId: { "video-a": "lease-a" },
      executionPlanDigest: "2".repeat(64),
    })).toBe(true);
    expect(captureRunIntentDecisionMatches(withLease.intent, {
      licensed: false,
      allocatedVideoItemIds: ["video-a"],
      headerLeaseIdsByItemId: { "video-a": "lease-b" },
      executionPlanDigest: "2".repeat(64),
    })).toBe(false);
  });

  it("digests only a guarded canonical execution plan", async () => {
    const first = await digestCaptureRunExecutionPlan(plan());
    const second = await digestCaptureRunExecutionPlan(plan());
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(await digestCaptureRunExecutionPlan({ ...plan(), draftRevision: 4 })).not.toBe(first);
    const withLease = await digestCaptureRunExecutionPlan(plan(), { "video-a": "lease-a" });
    const changedLease = await digestCaptureRunExecutionPlan(plan(), { "video-a": "lease-b" });
    expect(withLease).toMatch(/^[0-9a-f]{64}$/);
    expect(withLease).not.toBe(first);
    expect(changedLease).not.toBe(withLease);
    expect(await digestCaptureRunExecutionPlan(plan(), { unknown: "lease-a" })).toBeUndefined();

    const withManifest = plan();
    withManifest.manifestSpec = {
      schemaVersion: 1,
      formats: ["json"],
      packName: "Pack",
      createdAt: 0,
      itemAddedAt: { "video-a": 2 },
    };
    const manifestDigest = await digestCaptureRunExecutionPlan(withManifest);
    expect(manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestDigest).not.toBe(first);
    withManifest.manifestSpec.formats = ["json", "csv"];
    expect(await digestCaptureRunExecutionPlan(withManifest)).not.toBe(manifestDigest);

    const multi = plan();
    multi.items.push({
      ...multi.items[0],
      itemId: "video-b",
      media: {
        ...multi.items[0].media,
        mediaId: "media-b",
        url: "https://cdn.example/video-b.mp4",
      },
      plannedRelativePath: "ClipHutch/Pack/example/video-b.mp4",
      copyChoice: { ...multi.items[0].copyChoice, candidateId: "media-b" },
    });
    multi.totals = {
      included: 2,
      videos: 2,
      stills: 0,
      unknownSizeCount: 2,
      requiredFreeVideoSlots: 2,
    };
    expect(await digestCaptureRunExecutionPlan(multi, {
      "video-b": "lease-b",
      "video-a": "lease-a",
    })).toBe(await digestCaptureRunExecutionPlan(multi, {
      "video-a": "lease-a",
      "video-b": "lease-b",
    }));
    const { proxy, revoke } = Proxy.revocable(plan(), {});
    revoke();
    await expect(digestCaptureRunExecutionPlan(proxy)).resolves.toBeUndefined();
  });

  it("never persists plan contents, URLs, or filenames", async () => {
    await createCaptureRunIntent(input());
    const serialized = JSON.stringify(storage[CAPTURE_RUN_INTENTS_STORAGE_KEY]);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain(".mp4");
    expect(serialized).not.toContain("plannedRelativePath");
    expect(serialized).toContain("executionPlanDigest");
  });
});
