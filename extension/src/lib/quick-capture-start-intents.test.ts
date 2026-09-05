import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureReviewPlanV1 } from "./capture-pack-types";
import { createSingleCapturePlan } from "./capture-single-plan";
import {
  abandonQuickCaptureStartIntent,
  createQuickCaptureStartIntent,
  deriveQuickCaptureStartIdentity,
  getNewestUnresolvedQuickCaptureStartIntent,
  getQuickCaptureStartIntent,
  isQuickCaptureStartIntentUnresolved,
  listQuickCaptureStartIntents,
  MAX_SETTLED_QUICK_CAPTURE_START_INTENTS,
  QUICK_CAPTURE_START_INTENTS_STORAGE_KEY,
  quickCaptureStartRequestMatches,
  updateQuickCaptureStartIntentDisposition,
  type QuickCaptureStartIntentCreateInput,
  type QuickCaptureStartHeaderLeaseV1,
  type QuickCaptureStartIntentV1,
} from "./quick-capture-start-intents";

const storage: Record<string, unknown> = {};
let failGet = false;
let failNextGet = false;
let setFailure: "none" | "before" | "after" = "none";

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  failGet = false;
  failNextGet = false;
  setFailure = "none";
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
          if (setFailure === "before") throw new Error("set failed before commit");
          Object.assign(storage, values);
          if (setFailure === "after") throw new Error("set acknowledgement lost");
        }),
      },
    },
  });
});

function command(index = 1): string {
  return `download-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function plan(index = 1, commandId = command(index)): CaptureReviewPlanV1 {
  const identity = deriveQuickCaptureStartIdentity(commandId);
  if (!identity) throw new Error("test command must be valid");
  const generatedAt = index * 10;
  const relativeRoot = "ClipHutch/Quick Capture";
  return {
    schemaVersion: 1,
    planId: identity.planId,
    draftId: identity.draftId,
    draftRevision: 1,
    generatedAt,
    relativeRoot,
    items: [{
      itemId: identity.itemId,
      include: true,
      media: {
        mediaId: `media-${index}`,
        kind: "direct",
        url: `https://cdn.example/video-${index}.mp4`,
        detectedAt: generatedAt - 1,
        contentType: "video/mp4",
        provenance: ["network"],
      },
      plannedRelativePath: `${relativeRoot}/example.test - Lesson/video-${index}.mp4`,
      readiness: "ready",
      copyChoice: {
        candidateId: `media-${index}`,
        confidence: "exact",
        reason: "Exact media selected for Quick Capture.",
      },
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

function input(index = 1, licensed = false): QuickCaptureStartIntentCreateInput {
  return { commandId: command(index), plan: plan(index), licensed };
}

function headerLease(index = 1, commandId = command(index)): QuickCaptureStartHeaderLeaseV1 {
  const identity = deriveQuickCaptureStartIdentity(commandId);
  if (!identity) throw new Error("test command must be valid");
  return {
    binding: {
      leaseId: `capture-header-lease-v1:${identity.coordinatorCommandId}`,
      draftId: identity.draftId,
      itemId: identity.itemId,
      mediaId: `media-${index}`,
      sourceTabId: 7,
      pageUrl: "https://example.test/lesson",
      sourceUrl: `https://cdn.example/video-${index}.mp4`,
      replayKind: "direct",
    },
    owner: {
      runId: identity.runId,
      jobId: `capture-job:v1:${index}`,
      attemptId: `capture-attempt:v1:${index}`,
    },
    headerLeaseIdsByItemId: {
      [identity.itemId]: `capture-header-lease-v1:${identity.coordinatorCommandId}`,
    },
    expiresAt: 3_602_000,
  };
}

function currentIndex(): {
  schemaVersion: 1;
  orderedCommandIds: string[];
  records: Record<string, QuickCaptureStartIntentV1>;
} {
  return storage[QUICK_CAPTURE_START_INTENTS_STORAGE_KEY] as ReturnType<typeof currentIndex>;
}

async function accept(index: number): Promise<void> {
  const created = await createQuickCaptureStartIntent(input(index));
  if (!created.ok) throw new Error(`create failed: ${created.reason}`);
  const updated = await updateQuickCaptureStartIntentDisposition({
    commandId: command(index),
    runId: created.intent.runId,
    disposition: "accepted",
  });
  if (!updated.ok) throw new Error(`update failed: ${updated.reason}`);
}

describe("Quick Capture start intent journal", () => {
  it("derives one canonical coordinator/run/plan identity", () => {
    const uppercase = command().toUpperCase().replace("DOWNLOAD-", "download-");
    expect(deriveQuickCaptureStartIdentity(uppercase)).toEqual({
      commandId: command(),
      coordinatorCommandId: "00000000-0000-4000-8000-000000000001",
      runId: "capture-run:v1:00000000-0000-4000-8000-000000000001",
      planId: "capture-single-plan:00000000-0000-4000-8000-000000000001",
      draftId: "capture-single-draft:00000000-0000-4000-8000-000000000001",
      itemId: "capture-single-item:00000000-0000-4000-8000-000000000001",
    });
    expect(deriveQuickCaptureStartIdentity("capture-run-not-this-namespace")).toBeUndefined();
  });

  it("accepts the production one-item planner output without adaptation", async () => {
    const prepared = createSingleCapturePlan({
      commandId: command(),
      tabId: 7,
      generatedAt: 20,
      filenameTemplate: "auto",
      media: {
        id: "media-production",
        kind: "direct",
        url: "https://cdn.example/production.mp4",
        pageUrl: "https://example.test/lesson",
        pageTitle: "Lesson",
        detectedAt: 10,
        contentType: "video/mp4",
        provenance: ["network"],
      },
      qualityChoice: { mode: "direct" },
    });
    if (!prepared.ok) throw new Error("production planner unexpectedly rejected fixture");
    await expect(createQuickCaptureStartIntent({
      commandId: command(),
      plan: prepared.plan,
      licensed: false,
    })).resolves.toMatchObject({
      ok: true,
      intent: {
        coordinatorCommandId: prepared.commandUuid,
        runId: `capture-run:v1:${prepared.commandUuid}`,
        plan: { planId: prepared.plan.planId },
      },
    });
  });

  it("freezes the canonical one-item plan and first entitlement decision", async () => {
    const raw = input();
    const media = raw.plan.items[0]!.media as unknown as Record<string, unknown>;
    media.authorization = "Bearer must-not-persist";
    media.secretUrl = "https://attacker.invalid/extra";
    const result = await createQuickCaptureStartIntent(raw);
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      intent: {
        commandId: command(),
        licensed: false,
        status: "pending",
      },
    });
    expect(JSON.stringify(currentIndex())).not.toContain("must-not-persist");
    expect(JSON.stringify(currentIndex())).not.toContain("attacker.invalid");

    raw.plan.items[0]!.media.url = "https://mutated.invalid/video.mp4";
    const stored = await getQuickCaptureStartIntent(command());
    expect(stored).toMatchObject({
      ok: true,
      intent: { plan: { items: [{ media: { url: "https://cdn.example/video-1.mp4" } }] } },
    });

    const replay = await createQuickCaptureStartIntent(input(1, true));
    expect(replay).toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
      intent: { licensed: false },
    });
    expect(quickCaptureStartRequestMatches(
      (replay as { intent: QuickCaptureStartIntentV1 }).intent,
      input(1, true),
    )).toBe(true);
  });

  it("round-trips the persisted Quick Capture header lease reference", async () => {
    const raw = {
      ...input(),
      headerLease: headerLease(),
    };
    const result = await createQuickCaptureStartIntent(raw);
    expect(result).toMatchObject({
      ok: true,
      intent: {
        headerLease: {
          headerLeaseIdsByItemId: {
            [deriveQuickCaptureStartIdentity(command())!.itemId]:
              `capture-header-lease-v1:${deriveQuickCaptureStartIdentity(command())!.coordinatorCommandId}`,
          },
          binding: { leaseId: `capture-header-lease-v1:${deriveQuickCaptureStartIdentity(command())!.coordinatorCommandId}` },
        },
      },
    });
    const stored = await getQuickCaptureStartIntent(command());
    expect(stored).toMatchObject({
      ok: true,
      intent: { headerLease: raw.headerLease },
    });
  });

  it("conflicts on any same-command plan change", async () => {
    await createQuickCaptureStartIntent(input());
    const changed = input();
    changed.plan.items[0]!.media.url = "https://cdn.example/different.mp4";
    await expect(createQuickCaptureStartIntent(changed)).resolves.toMatchObject({
      ok: false,
      reason: "command_conflict",
      commandId: command(),
    });
    const existing = await getQuickCaptureStartIntent(command());
    expect(existing).toMatchObject({
      ok: true,
      intent: { plan: { items: [{ media: { url: "https://cdn.example/video-1.mp4" } }] } },
    });
  });

  it("rejects non-ready/non-single/misbound plans and hostile data objects", async () => {
    const excluded = input();
    excluded.plan.items[0]!.include = false;
    excluded.plan.totals = {
      included: 0,
      videos: 0,
      stills: 0,
      estimatedBytes: 0,
      unknownSizeCount: 0,
      requiredFreeVideoSlots: 0,
    };
    await expect(createQuickCaptureStartIntent(excluded)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_input",
    });

    const misbound = input();
    misbound.plan.planId = "capture-single-plan:00000000-0000-4000-8000-999999999999";
    await expect(createQuickCaptureStartIntent(misbound)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_input",
    });

    let accessorReads = 0;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(accessor, {
      commandId: {
        enumerable: true,
        get: () => {
          accessorReads += 1;
          return command();
        },
      },
      plan: { enumerable: true, value: plan() },
      licensed: { enumerable: true, value: false },
    });
    await expect(createQuickCaptureStartIntent(
      accessor as unknown as QuickCaptureStartIntentCreateInput,
    )).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    expect(accessorReads).toBe(0);

    const cyclic = input();
    (cyclic.plan as unknown as Record<string, unknown>).cycle = cyclic.plan;
    await expect(createQuickCaptureStartIntent(cyclic)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_input",
    });
  });

  it("serializes creation and blocks every different command while unresolved", async () => {
    const [first, second] = await Promise.all([
      createQuickCaptureStartIntent(input(1)),
      createQuickCaptureStartIntent(input(2)),
    ]);
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({
      ok: false,
      reason: "unresolved_intent",
      commandId: command(1),
    });

    const same = await Promise.all([
      createQuickCaptureStartIntent(input(1)),
      createQuickCaptureStartIntent(input(1, true)),
    ]);
    expect(same.every((result) => result.ok && result.replayed)).toBe(true);
  });

  it("keeps ambiguous dispositions unresolved and promotes monotonically", async () => {
    const created = await createQuickCaptureStartIntent(input());
    if (!created.ok) throw new Error("expected create");
    const runId = created.intent.runId;
    await expect(updateQuickCaptureStartIntentDisposition({
      commandId: command(),
      runId,
      disposition: "commit_state_unknown",
    })).resolves.toMatchObject({
      ok: true,
      changed: true,
      intent: { reconciliationDisposition: "commit_state_unknown" },
    });
    expect(isQuickCaptureStartIntentUnresolved(
      (await getQuickCaptureStartIntent(command()) as { intent: unknown }).intent,
    )).toBe(true);
    await expect(createQuickCaptureStartIntent(input(2))).resolves.toMatchObject({
      ok: false,
      reason: "unresolved_intent",
    });

    await updateQuickCaptureStartIntentDisposition({
      commandId: command(), runId, disposition: "recovery_needed",
    });
    await expect(updateQuickCaptureStartIntentDisposition({
      commandId: command(), runId, disposition: "commit_state_unknown",
    })).resolves.toMatchObject({
      ok: true,
      changed: false,
      intent: { reconciliationDisposition: "recovery_needed" },
    });
    await updateQuickCaptureStartIntentDisposition({
      commandId: command(), runId, disposition: "accepted",
    });
    await expect(updateQuickCaptureStartIntentDisposition({
      commandId: command(), runId, disposition: "recovery_needed",
    })).resolves.toMatchObject({
      ok: true,
      changed: false,
      intent: { reconciliationDisposition: "accepted" },
    });
    await expect(createQuickCaptureStartIntent(input(2))).resolves.toMatchObject({
      ok: true,
      replayed: false,
    });
  });

  it("rejects a non-deterministic coordinator run owner", async () => {
    await createQuickCaptureStartIntent(input());
    await expect(updateQuickCaptureStartIntentDisposition({
      commandId: command(),
      runId: "capture-run:v1:00000000-0000-4000-8000-999999999999",
      disposition: "accepted",
    })).resolves.toMatchObject({
      ok: false,
      reason: "run_conflict",
      expectedRunId: deriveQuickCaptureStartIdentity(command())!.runId,
    });
  });

  it("returns the newest unresolved intent independently of settled records", async () => {
    await accept(1);
    await createQuickCaptureStartIntent(input(2));
    await expect(getNewestUnresolvedQuickCaptureStartIntent()).resolves.toMatchObject({
      ok: true,
      intent: { commandId: command(2), status: "pending" },
    });
    const listed = await listQuickCaptureStartIntents();
    expect(listed.ok && listed.intents.map((intent) => intent.commandId)).toEqual([
      command(2), command(1),
    ]);
  });

  it("bounds settled retention while never pruning the unresolved record", async () => {
    for (let index = 1; index <= MAX_SETTLED_QUICK_CAPTURE_START_INTENTS + 2; index += 1) {
      await accept(index);
    }
    let listed = await listQuickCaptureStartIntents();
    expect(listed.ok && listed.intents).toHaveLength(MAX_SETTLED_QUICK_CAPTURE_START_INTENTS);
    await expect(getQuickCaptureStartIntent(command(1))).resolves.toEqual({ ok: true, intent: null });

    const pendingIndex = MAX_SETTLED_QUICK_CAPTURE_START_INTENTS + 3;
    await createQuickCaptureStartIntent(input(pendingIndex));
    listed = await listQuickCaptureStartIntents();
    expect(listed.ok && listed.intents).toHaveLength(
      MAX_SETTLED_QUICK_CAPTURE_START_INTENTS + 1,
    );
    await expect(getNewestUnresolvedQuickCaptureStartIntent()).resolves.toMatchObject({
      ok: true,
      intent: { commandId: command(pendingIndex), status: "pending" },
    });
  });

  it("distinguishes applied, absent, and unknown storage acknowledgements", async () => {
    setFailure = "after";
    await expect(createQuickCaptureStartIntent(input())).resolves.toMatchObject({
      ok: true,
      commitState: "committed",
    });

    for (const key of Object.keys(storage)) delete storage[key];
    setFailure = "before";
    await expect(createQuickCaptureStartIntent(input())).resolves.toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      commitState: "absent",
    });

    setFailure = "before";
    failNextGet = false;
    const sessionGet = chrome.storage.session.get as ReturnType<typeof vi.fn>;
    sessionGet.mockImplementationOnce(async () => ({}));
    sessionGet.mockImplementationOnce(async () => {
      throw new Error("read-back unavailable");
    });
    await expect(createQuickCaptureStartIntent(input())).resolves.toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      commitState: "unknown",
    });
  });

  it("abandons only an exact pending plan and never erases ambiguous ownership", async () => {
    const created = await createQuickCaptureStartIntent(input());
    if (!created.ok) throw new Error("expected create");
    const wrong = plan();
    wrong.items[0]!.media.url = "https://cdn.example/wrong.mp4";
    await expect(abandonQuickCaptureStartIntent({ commandId: command(), plan: wrong }))
      .resolves.toMatchObject({ ok: false, reason: "command_conflict" });
    await expect(abandonQuickCaptureStartIntent({ commandId: command(), plan: plan() }))
      .resolves.toEqual({ ok: true, changed: true, commitState: "committed" });

    const recreated = await createQuickCaptureStartIntent(input());
    if (!recreated.ok) throw new Error("expected recreate");
    await updateQuickCaptureStartIntentDisposition({
      commandId: command(),
      runId: recreated.intent.runId,
      disposition: "commit_state_unknown",
    });
    await expect(abandonQuickCaptureStartIntent({ commandId: command(), plan: plan() }))
      .resolves.toMatchObject({
        ok: false,
        reason: "intent_committed",
        disposition: "commit_state_unknown",
      });
  });

  it("fails closed on corrupt prototypes, accessors, and noncanonical indexes", async () => {
    await createQuickCaptureStartIntent(input());
    const index = currentIndex();
    Object.setPrototypeOf(index.records[command()], { polluted: true });
    await expect(getQuickCaptureStartIntent(command())).resolves.toMatchObject({
      ok: false,
      reason: "storage_corrupt",
    });

    storage[QUICK_CAPTURE_START_INTENTS_STORAGE_KEY] = {
      schemaVersion: 1,
      orderedCommandIds: [command()],
      records: Object.create(null),
    };
    Object.defineProperty(
      (storage[QUICK_CAPTURE_START_INTENTS_STORAGE_KEY] as { records: object }).records,
      command(),
      { enumerable: true, get: () => ({}) },
    );
    await expect(listQuickCaptureStartIntents()).resolves.toMatchObject({
      ok: false,
      reason: "storage_corrupt",
    });
  });
});
