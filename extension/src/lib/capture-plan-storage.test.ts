import { beforeEach, describe, expect, it } from "vitest";
import type {
  CaptureDraftV1,
  CaptureReviewPlanV1,
  PersistentStreamQualityChoiceV1,
} from "./capture-pack-types";
import { generateCaptureReviewPlan } from "./capture-plan";
import {
  CAPTURE_PLAN_INDEX_STORAGE_KEY,
  CAPTURE_PLAN_STORAGE_OWNER,
  CAPTURE_PLAN_STORAGE_PREFIX,
  MAX_CAPTURE_PLAN_SERIALIZED_BYTES,
  MAX_CAPTURE_PLAN_STORAGE_BYTES,
  clearUnreferencedCaptureReviewPlans,
  getActiveCaptureReviewPlan,
  getCaptureReviewPlan,
  listCaptureReviewPlans,
  parseStoredCapturePlan,
  parseStoredCapturePlanIndex,
  saveCaptureReviewPlan,
} from "./capture-plan-storage";

let store: Record<string, unknown>;
let setCalls: Record<string, unknown>[];
let removeCalls: string[][];
let failSet: boolean;
let applyThenFailSet: boolean;
let failGet: boolean;
let failReadBack: boolean;
let failRemove: boolean;

function planKey(planId: string): string {
  return `${CAPTURE_PLAN_STORAGE_PREFIX}${planId}`;
}

function plan(planId = "plan-1", generatedAt = 20): CaptureReviewPlanV1 {
  const draft: CaptureDraftV1 = {
    schemaVersion: 1,
    draftId: "draft-1",
    revision: 1,
    name: "Research Pack",
    createdAt: 1,
    updatedAt: 10,
    orderedItemIds: ["item-1"],
    items: {
      "item-1": {
        itemId: "item-1",
        addedAt: 5,
        media: {
          mediaId: "media-1",
          kind: "direct",
          url: "https://cdn.example.test/video.mp4",
          detectedAt: 4,
          pageUrl: "https://example.test/page",
          pageTitle: "Page",
          sizeBytes: 100,
          provenance: ["network"],
        },
      },
    },
    preferences: {
      folderMode: "pack_page",
      manifestFormats: ["json"],
      qualityPolicy: { mode: "manual" },
    },
  };
  const generated = generateCaptureReviewPlan({
    draft,
    expectedDraftRevision: draft.revision,
    planId,
    generatedAt,
    choices: [{ itemId: "item-1", include: true }],
  });
  if (!generated.ok) throw new Error(`Plan fixture failed: ${generated.reason}`);
  return generated.plan;
}

function persistentStreamPlan(
  kind: "hls" | "dash",
  planId = `plan-persistent-${kind}`,
): CaptureReviewPlanV1 {
  const mediaId = `media-${kind}`;
  const draft: CaptureDraftV1 = {
    schemaVersion: 1,
    draftId: `draft-${kind}`,
    revision: 1,
    name: `${kind.toUpperCase()} Research Pack`,
    createdAt: 1,
    updatedAt: 10,
    orderedItemIds: [`item-${kind}`],
    items: {
      [`item-${kind}`]: {
        itemId: `item-${kind}`,
        addedAt: 5,
        media: {
          mediaId,
          kind,
          url: kind === "hls"
            ? "https://cdn.example.test/master.m3u8"
            : "https://cdn.example.test/manifest.mpd",
          detectedAt: 4,
          pageUrl: "https://example.test/page",
          pageTitle: "Page",
          provenance: ["network"],
        },
      },
    },
    preferences: {
      folderMode: "pack_page",
      manifestFormats: ["json"],
      qualityPolicy: { mode: "manual" },
    },
  };
  const qualityChoice: PersistentStreamQualityChoiceV1 = {
    mode: "stream",
    policy: { mode: "manual" },
    selector: {
      kind,
      stableId: `variant-v1-${kind}-${(kind === "hls" ? "a" : "b").repeat(40)}`,
    },
    maxDownloadBytes: 1_000_000,
    label: kind === "hls" ? "HLS 720p" : "DASH 720p",
    width: 1280,
    height: 720,
    combinedBandwidth: 800_000,
    durationSec: 2,
    estimatedBytes: 200_000,
    estimateConfidence: "estimated",
  };
  const generated = generateCaptureReviewPlan({
    draft,
    expectedDraftRevision: draft.revision,
    planId,
    generatedAt: 20,
    choices: [{ itemId: `item-${kind}`, include: true, qualityChoice }],
  });
  if (!generated.ok) throw new Error(`Persistent stream fixture failed: ${generated.reason}`);
  return generated.plan;
}

function legacyQuickStreamPlan(kind: "hls" | "dash"): CaptureReviewPlanV1 {
  const quick = structuredClone(persistentStreamPlan(kind));
  quick.planId = "capture-single-plan:123e4567-e89b-42d3-a456-426614174000";
  delete quick.manifestSpec;
  const item = quick.items[0];
  if (item.readiness !== "ready") throw new Error("Expected ready fixture");
  item.qualityChoice = kind === "hls"
    ? {
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "hls",
        variantUrl: "https://cdn.example.test/video.m3u8?legacy=one",
        label: "Legacy HLS 720p",
        combinedBandwidth: 800_000,
        durationSec: 2,
        estimatedBytes: 200_000,
        estimateConfidence: "estimated",
      }
    : {
        mode: "stream",
        policy: { mode: "manual" },
        variantKind: "dash",
        representationId: "legacy-video-720",
        label: "Legacy DASH 720p",
        combinedBandwidth: 800_000,
        durationSec: 2,
        estimatedBytes: 200_000,
        estimateConfidence: "estimated",
      };
  return quick;
}

beforeEach(() => {
  store = { unrelated: "keep" };
  setCalls = [];
  removeCalls = [];
  failSet = false;
  applyThenFailSet = false;
  failGet = false;
  failReadBack = false;
  failRemove = false;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        get(keys: string | string[] | null) {
          if (failGet || failReadBack) return Promise.reject(new Error("get unavailable"));
          const requested = keys === null
            ? Object.keys(store)
            : Array.isArray(keys) ? keys : [keys];
          const values: Record<string, unknown> = {};
          for (const key of requested) {
            if (Object.prototype.hasOwnProperty.call(store, key)) {
              values[key] = structuredClone(store[key]);
            }
          }
          return Promise.resolve(values);
        },
        set(values: Record<string, unknown>) {
          const cloned = structuredClone(values);
          if (applyThenFailSet) {
            setCalls.push(cloned);
            Object.assign(store, cloned);
            return Promise.reject(new Error("set acknowledgement unavailable"));
          }
          if (failSet) return Promise.reject(new Error("set unavailable"));
          setCalls.push(cloned);
          Object.assign(store, cloned);
          return Promise.resolve();
        },
        remove(keys: string | string[]) {
          if (failRemove) return Promise.reject(new Error("remove unavailable"));
          const requested = Array.isArray(keys) ? keys : [keys];
          removeCalls.push([...requested]);
          for (const key of requested) delete store[key];
          return Promise.resolve();
        },
      },
    },
  };
});

describe("Capture Review plan parsing", () => {
  it("distinguishes empty, valid, corrupt, future, oversized, and hostile values", () => {
    expect(parseStoredCapturePlan(undefined)).toEqual({ status: "empty" });
    expect(parseStoredCapturePlan(plan())).toMatchObject({ status: "valid" });
    expect(parseStoredCapturePlan({ schemaVersion: 1, planId: "broken" })).toEqual({
      status: "invalid",
      reason: "corrupt",
    });
    expect(parseStoredCapturePlan({ schemaVersion: 2 })).toEqual({
      status: "invalid",
      reason: "future_schema",
      schemaVersion: 2,
    });
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile getter");
      },
    });
    expect(() => parseStoredCapturePlan(hostile)).not.toThrow();
    expect(parseStoredCapturePlan(hostile)).toMatchObject({ status: "invalid" });

    const base = plan();
    const items = Array.from({ length: 70 }, (_, index) => ({
      ...base.items[0],
      itemId: `item-${index}`,
      media: {
        ...base.items[0].media,
        mediaId: `media-${index}`,
        url: `https://cdn.example.test/${"x".repeat(15_000)}/${index}.mp4`,
      },
      plannedRelativePath: `ClipHutch/Research Pack/Page/video-${index}.mp4`,
      copyChoice: { ...base.items[0].copyChoice, candidateId: `media-${index}` },
    }));
    const oversized: CaptureReviewPlanV1 = {
      ...base,
      items,
      totals: {
        included: 70,
        videos: 70,
        stills: 0,
        estimatedBytes: 7_000,
        unknownSizeCount: 0,
        requiredFreeVideoSlots: 70,
      },
    };
    const parsed = parseStoredCapturePlan(oversized);
    expect(parsed).toMatchObject({ status: "invalid", reason: "serialized_byte_limit" });
    expect(parsed.status === "invalid" && parsed.measuredBytes).toBeGreaterThan(
      MAX_CAPTURE_PLAN_SERIALIZED_BYTES,
    );
  });

  it("accepts safe frozen recommendation states but rejects cross-media or unsafe reasons", () => {
    for (const confidence of ["high", "unproven"] as const) {
      const recommended = plan(`plan-${confidence}`);
      recommended.items[0].copyChoice = {
        candidateId: recommended.items[0].media.mediaId,
        confidence,
        reason: confidence === "high"
          ? "Largest verified responsive image."
          : "Customer selected a verified related copy.",
      };
      expect(parseStoredCapturePlan(recommended)).toMatchObject({
        status: "valid",
        plan: { items: [{ copyChoice: { confidence } }] },
      });
    }

    const mismatched = plan("plan-mismatch");
    mismatched.items[0].copyChoice.candidateId = "different-media";
    expect(parseStoredCapturePlan(mismatched)).toMatchObject({
      status: "invalid",
      reason: "corrupt",
    });

    const unsafe = plan("plan-unsafe");
    unsafe.items[0].copyChoice.reason = "Unsafe\u202ereason";
    expect(parseStoredCapturePlan(unsafe)).toMatchObject({
      status: "invalid",
      reason: "corrupt",
    });
  });

  it("revalidates the exact canonical clone when accessors change after validation", () => {
    const accessorBacked = plan() as CaptureReviewPlanV1;
    let planIdReads = 0;
    Object.defineProperty(accessorBacked, "planId", {
      configurable: true,
      enumerable: true,
      get() {
        planIdReads += 1;
        return planIdReads <= 3 ? "plan-1" : "";
      },
    });
    expect(parseStoredCapturePlan(accessorBacked)).toEqual({
      status: "invalid",
      reason: "corrupt",
    });
    expect(planIdReads).toBeGreaterThanOrEqual(4);
  });

  it("rejects duplicate, dangling, and future plan indexes", () => {
    expect(parseStoredCapturePlanIndex(undefined)).toEqual({ status: "empty" });
    expect(parseStoredCapturePlanIndex({
      schemaVersion: 1,
      activePlanId: "plan-1",
      orderedPlanIds: ["plan-1", "plan-1"],
    })).toMatchObject({ status: "invalid", reason: "corrupt" });
    expect(parseStoredCapturePlanIndex({
      schemaVersion: 1,
      activePlanId: "missing",
      orderedPlanIds: ["other"],
    })).toMatchObject({ status: "invalid", reason: "corrupt" });
    expect(parseStoredCapturePlanIndex({ schemaVersion: 7 })).toEqual({
      status: "invalid",
      reason: "future_schema",
      schemaVersion: 7,
    });
    expect(parseStoredCapturePlanIndex({
      schemaVersion: 1,
      activePlanId: null,
      orderedPlanIds: ["protected-run-plan"],
    })).toMatchObject({
      status: "valid",
      index: { activePlanId: null, orderedPlanIds: ["protected-run-plan"] },
    });
  });

  it("rejects valid-shaped stored plans with duplicate canonical paths", () => {
    const base = plan();
    const duplicate: CaptureReviewPlanV1 = {
      ...base,
      items: [
        base.items[0],
        {
          ...base.items[0],
          itemId: "item-2",
          media: { ...base.items[0].media, mediaId: "media-2" },
          plannedRelativePath: base.items[0].plannedRelativePath.toUpperCase(),
          copyChoice: { ...base.items[0].copyChoice, candidateId: "media-2" },
        },
      ],
      totals: {
        included: 2,
        videos: 2,
        stills: 0,
        estimatedBytes: 200,
        unknownSizeCount: 0,
        requiredFreeVideoSlots: 2,
      },
    };
    expect(parseStoredCapturePlan(duplicate)).toMatchObject({
      status: "invalid",
      reason: "corrupt",
    });
  });

  it("rejects a persistent selector whose kind does not match its stream", () => {
    const mismatched = persistentStreamPlan("hls");
    if (mismatched.items[0].readiness !== "ready") throw new Error("Expected ready fixture");
    mismatched.items[0].qualityChoice = {
      ...mismatched.items[0].qualityChoice,
      selector: {
        kind: "dash",
        stableId: `variant-v1-dash-${"c".repeat(40)}`,
      },
    } as PersistentStreamQualityChoiceV1;
    expect(parseStoredCapturePlan(mismatched)).toEqual({
      status: "invalid",
      reason: "corrupt",
    });
  });

  it.each(["hls", "dash"] as const)(
    "keeps read-only legacy Quick %s plans parseable",
    (kind) => {
      expect(parseStoredCapturePlan(legacyQuickStreamPlan(kind))).toMatchObject({
        status: "valid",
        plan: {
          planId: "capture-single-plan:123e4567-e89b-42d3-a456-426614174000",
          items: [{ media: { kind }, qualityChoice: { variantKind: kind } }],
        },
      });
    },
  );
});

describe("background-owned Capture Review plan storage", () => {
  it("round-trips a frozen high-confidence copy choice", async () => {
    const recommended = plan("plan-recommended");
    recommended.items[0].copyChoice = {
      candidateId: recommended.items[0].media.mediaId,
      confidence: "high",
      reason: "Largest verified responsive image.",
    };
    await expect(saveCaptureReviewPlan(recommended)).resolves.toMatchObject({
      ok: true,
      changed: true,
      plan: { items: [{ copyChoice: { confidence: "high" } }] },
    });
    await expect(getCaptureReviewPlan(recommended.planId)).resolves.toMatchObject({
      ok: true,
      plan: {
        items: [{
          copyChoice: {
            candidateId: "media-1",
            confidence: "high",
            reason: "Largest verified responsive image.",
          },
        }],
      },
    });
  });

  it.each(["hls", "dash"] as const)(
    "round-trips a persistence-safe %s selector through parse, save, and read",
    async (kind) => {
      const persistent = persistentStreamPlan(kind);
      const parsed = parseStoredCapturePlan(persistent);
      expect(parsed).toMatchObject({
        status: "valid",
        plan: {
          items: [{
            media: { kind },
            qualityChoice: { selector: { kind } },
          }],
        },
      });

      await expect(saveCaptureReviewPlan(persistent)).resolves.toMatchObject({
        ok: true,
        changed: true,
      });
      await expect(getCaptureReviewPlan(persistent.planId)).resolves.toMatchObject({
        ok: true,
        plan: {
          items: [{
            media: { kind },
            qualityChoice: {
              mode: "stream",
              selector: { kind },
              maxDownloadBytes: 1_000_000,
            },
          }],
        },
      });
    },
  );

  it("persists only canonical fields and returns isolated active/id/list reads", async () => {
    expect(CAPTURE_PLAN_STORAGE_OWNER).toBe("background-service-worker");
    const raw = plan() as CaptureReviewPlanV1 & { licenseKey?: string };
    raw.licenseKey = "secret-license";
    (raw.items[0].media as CaptureReviewPlanV1["items"][number]["media"] & { headers?: string })
      .headers = "secret-header";
    (raw.items[0].qualityChoice as CaptureReviewPlanV1["items"][number]["qualityChoice"] & {
      rawManifest?: string;
    }).rawManifest = "secret-manifest";
    (raw.items[0].copyChoice as CaptureReviewPlanV1["items"][number]["copyChoice"] & {
      alternateUrl?: string;
    }).alternateUrl = "https://private.example/secret-alternate.jpg";

    const saved = await saveCaptureReviewPlan(raw);
    expect(saved).toMatchObject({ ok: true, changed: true, prunedPlanIds: [] });
    expect(JSON.stringify(setCalls[0])).not.toContain("secret");
    expect(store.unrelated).toBe("keep");

    const active = await getActiveCaptureReviewPlan();
    const byId = await getCaptureReviewPlan("plan-1");
    const listed = await listCaptureReviewPlans();
    expect(active).toMatchObject({ ok: true, plan: { planId: "plan-1" } });
    expect(byId).toMatchObject({ ok: true, plan: { planId: "plan-1" } });
    expect(listed).toMatchObject({ ok: true, activePlanId: "plan-1" });
    if (active.ok && active.plan) active.plan.items[0].media.provenance.push("metadata");
    expect(await getActiveCaptureReviewPlan()).toMatchObject({
      ok: true,
      plan: { items: [{ media: { provenance: ["network"] } }] },
    });
  });

  it("retains the active plan plus five recent plans and removes only pruned plan keys", async () => {
    expect(MAX_CAPTURE_PLAN_STORAGE_BYTES).toBe(
      6 * MAX_CAPTURE_PLAN_SERIALIZED_BYTES + 16 * 1024,
    );
    for (let index = 1; index <= 7; index += 1) {
      expect(await saveCaptureReviewPlan(plan(`plan-${index}`, 20 + index))).toMatchObject({
        ok: true,
        changed: true,
      });
    }
    const listed = await listCaptureReviewPlans();
    expect(listed.ok && listed.activePlanId).toBe("plan-7");
    expect(listed.ok && listed.plans.map((value) => value.planId)).toEqual([
      "plan-7",
      "plan-6",
      "plan-5",
      "plan-4",
      "plan-3",
      "plan-2",
    ]);
    expect(store[planKey("plan-1")]).toBeUndefined();
    expect(removeCalls.at(-1)).toEqual([planKey("plan-1")]);
  });

  it("replays an exact plan idempotently and rejects a different plan under the same id", async () => {
    const first = plan();
    expect(await saveCaptureReviewPlan(first)).toMatchObject({ ok: true, changed: true });
    const writes = setCalls.length;
    expect(await saveCaptureReviewPlan(first)).toMatchObject({ ok: true, changed: false });
    expect(setCalls).toHaveLength(writes);
    expect(await saveCaptureReviewPlan({ ...first, generatedAt: first.generatedAt + 1 })).toMatchObject({
      ok: false,
      reason: "conflict",
      conflict: "plan_id_exists",
      planId: "plan-1",
      committed: false,
    });
  });

  it("does not report an exact older plan as active after a newer plan supersedes it", async () => {
    const older = plan("plan-older", 20);
    await saveCaptureReviewPlan(older);
    await saveCaptureReviewPlan(plan("plan-newer", 21));
    expect(await saveCaptureReviewPlan(older)).toMatchObject({
      ok: false,
      reason: "conflict",
      conflict: "plan_superseded",
      planId: "plan-older",
      activePlanId: "plan-newer",
      committed: false,
    });
  });

  it("repairs exact index-only and plan-only partial commits on retry", async () => {
    const indexOnly = plan("plan-index-only", 21);
    store[CAPTURE_PLAN_INDEX_STORAGE_KEY] = {
      schemaVersion: 1,
      activePlanId: indexOnly.planId,
      orderedPlanIds: [indexOnly.planId],
    };
    expect(await saveCaptureReviewPlan(indexOnly)).toMatchObject({
      ok: true,
      changed: true,
      plan: { planId: "plan-index-only" },
    });
    expect(store[planKey(indexOnly.planId)]).toBeDefined();

    store = { unrelated: "keep" };
    const planOnly = plan("plan-record-only", 22);
    store[planKey(planOnly.planId)] = structuredClone(planOnly);
    expect(await saveCaptureReviewPlan(planOnly)).toMatchObject({
      ok: true,
      changed: true,
      plan: { planId: "plan-record-only" },
    });
    expect(store[CAPTURE_PLAN_INDEX_STORAGE_KEY]).toMatchObject({
      activePlanId: "plan-record-only",
    });
  });

  it("sweeps a previously unindexed orphan before committing another plan", async () => {
    await saveCaptureReviewPlan(plan("plan-active", 21));
    store[planKey("plan-orphan")] = plan("plan-orphan", 20);
    const saved = await saveCaptureReviewPlan(plan("plan-next", 22));
    expect(saved).toMatchObject({
      ok: true,
      changed: true,
      prunedPlanIds: ["plan-orphan"],
    });
    expect(store[planKey("plan-orphan")]).toBeUndefined();
  });

  it("fails closed when an indexed record is missing, corrupt, or from a future schema", async () => {
    store[CAPTURE_PLAN_INDEX_STORAGE_KEY] = {
      schemaVersion: 1,
      activePlanId: "missing",
      orderedPlanIds: ["missing"],
    };
    expect(await getActiveCaptureReviewPlan()).toMatchObject({
      ok: false,
      reason: "storage_corrupt",
      key: planKey("missing"),
    });
    store[planKey("missing")] = { schemaVersion: 9 };
    expect(await getActiveCaptureReviewPlan()).toMatchObject({
      ok: false,
      reason: "storage_future_schema",
      key: planKey("missing"),
      schemaVersion: 9,
    });
  });

  it("classifies set rejection by exact read-back instead of blindly retrying", async () => {
    failSet = true;
    expect(await saveCaptureReviewPlan(plan())).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      committed: false,
    });

    failSet = false;
    applyThenFailSet = true;
    expect(await saveCaptureReviewPlan(plan("plan-applied", 21))).toMatchObject({
      ok: true,
      changed: true,
      plan: { planId: "plan-applied" },
    });

    applyThenFailSet = false;
    failSet = true;
    const originalSet = chrome.storage.session.set;
    chrome.storage.session.set = async (values) => {
      failReadBack = true;
      return originalSet(values);
    };
    expect(await saveCaptureReviewPlan(plan("plan-unknown", 22))).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      committed: true,
    });
  });

  it("reports cleanup failure as committed after the new active plan is durable", async () => {
    for (let index = 1; index <= 6; index += 1) {
      await saveCaptureReviewPlan(plan(`plan-${index}`, 20 + index));
    }
    failRemove = true;
    const result = await saveCaptureReviewPlan(plan("plan-7", 27));
    expect(result).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "remove",
      committed: true,
    });
    expect(store[CAPTURE_PLAN_INDEX_STORAGE_KEY]).toMatchObject({ activePlanId: "plan-7" });
    expect(store[planKey("plan-1")]).toBeDefined();
  });

  it("returns typed read failures without overwriting storage", async () => {
    failGet = true;
    expect(await getActiveCaptureReviewPlan()).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "get",
      committed: false,
    });
    expect(setCalls).toEqual([]);
  });

  it("clears active Review state while preserving only run-owned plans", async () => {
    await saveCaptureReviewPlan(plan("plan-protected", 21));
    await saveCaptureReviewPlan(plan("plan-review", 22));
    const cleared = await clearUnreferencedCaptureReviewPlans(["plan-protected"]);
    expect(cleared).toEqual({
      ok: true,
      removedPlanIds: ["plan-review"],
      preservedPlanIds: ["plan-protected"],
    });
    await expect(getActiveCaptureReviewPlan()).resolves.toEqual({ ok: true, plan: null });
    await expect(getCaptureReviewPlan("plan-protected")).resolves.toMatchObject({
      ok: true,
      plan: { planId: "plan-protected" },
    });
    await expect(getCaptureReviewPlan("plan-review")).resolves.toEqual({ ok: true, plan: null });
    expect(store.unrelated).toBe("keep");
  });

  it("fails closed on invalid protection sets and reports committed remove failure", async () => {
    await saveCaptureReviewPlan(plan("plan-review", 21));
    await expect(clearUnreferencedCaptureReviewPlans(["plan-review", "plan-review"]))
      .resolves.toMatchObject({ ok: false, reason: "invalid_plan", committed: false });
    failRemove = true;
    await expect(clearUnreferencedCaptureReviewPlans([])).resolves.toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "remove",
      committed: true,
    });
    expect(store[CAPTURE_PLAN_INDEX_STORAGE_KEY]).toMatchObject({
      activePlanId: null,
      orderedPlanIds: [],
    });
  });
});
