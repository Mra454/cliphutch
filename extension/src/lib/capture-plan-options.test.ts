import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_PLAN_OPTIONS_STORAGE_KEY,
  canonicalizeCaptureHeaderLeaseIdsByItemId,
  capturePlanOptionRequestMatches,
  clearUnreferencedCapturePlanOptions,
  getCapturePlanOptions,
  saveCapturePlanOptions,
  type CapturePlanOptionsRecordV1,
} from "./capture-plan-options";

const values: Record<string, unknown> = {};

beforeEach(() => {
  for (const key of Object.keys(values)) delete values[key];
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async () => ({ ...values })),
        set: vi.fn(async (next: Record<string, unknown>) => Object.assign(values, next)),
      },
    },
  });
});

function record(planId = "plan-1"): CapturePlanOptionsRecordV1 {
  return {
    schemaVersion: 1,
    planId,
    commandId: "capture-plan-123e4567-e89b-42d3-a456-426614174000",
    draftId: "draft-1",
    draftRevision: 2,
    choices: [{ itemId: "item-1", optionId: `capture-option-v1-${"a".repeat(40)}` }],
    options: [{
      itemId: "item-1",
      optionId: `capture-option-v1-${"a".repeat(40)}`,
      kind: "hls",
      label: "1080p",
      estimateConfidence: "unknown",
      supported: true,
    }],
    plan: {
      schemaVersion: 1,
      planId,
      draftId: "draft-1",
      draftRevision: 2,
      generatedAt: 10,
      relativeRoot: "ClipHutch/Pack",
      items: [{
        itemId: "item-1",
        include: true,
        media: {
          mediaId: "media-1",
          kind: "hls",
          url: "https://cdn.example/master.m3u8",
          detectedAt: 1,
          provenance: ["network"],
        },
        plannedRelativePath: "ClipHutch/Pack/example/video.mp4",
        readiness: "needs_choice",
        copyChoice: { candidateId: "media-1", confidence: "exact", reason: "Exact." },
        warnings: [{ code: "QUALITY_SELECTION_REQUIRED", message: "Choose a quality." }],
      }],
      totals: {
        included: 1,
        videos: 1,
        stills: 0,
        unknownSizeCount: 1,
        requiredFreeVideoSlots: 1,
      },
    },
    state: "prepared",
    createdAt: 10,
  };
}

function readyRecord(planId = "plan-ready"): CapturePlanOptionsRecordV1 {
  const value = record(planId);
  value.plan.items[0] = {
    ...value.plan.items[0],
    readiness: "ready",
    qualityChoice: {
      mode: "stream",
      policy: { mode: "manual" },
      variantKind: "hls",
      variantUrl: "https://cdn.example/variant.m3u8",
      estimateConfidence: "unknown",
    },
    warnings: [],
  };
  return value;
}

describe("capture plan option retention", () => {
  it("stores a canonical redacted record and matches the original request", async () => {
    expect(await saveCapturePlanOptions(record())).toMatchObject({ ok: true });
    const read = await getCapturePlanOptions("plan-1");
    expect(read).toMatchObject({ ok: true, record: record() });
    if (read.ok && read.record) {
      expect(capturePlanOptionRequestMatches(read.record, record())).toBe(true);
      expect(capturePlanOptionRequestMatches(read.record, { ...record(), choices: [] })).toBe(false);
    }
  });

  it("retains one supported confirmation suggestion and rejects ambiguous markers", async () => {
    const suggested = record("plan-suggested");
    suggested.options[0].suggestedForConfirmation = true;
    expect(await saveCapturePlanOptions(suggested)).toMatchObject({ ok: true });
    expect(await getCapturePlanOptions("plan-suggested")).toMatchObject({
      ok: true,
      record: { options: [{ suggestedForConfirmation: true }] },
    });

    const ambiguous = record("plan-ambiguous-suggestion");
    ambiguous.options.push({
      ...ambiguous.options[0],
      optionId: `capture-option-v1-${"b".repeat(40)}`,
      suggestedForConfirmation: true,
    });
    ambiguous.options[0].suggestedForConfirmation = true;
    expect(await saveCapturePlanOptions(ambiguous)).toMatchObject({
      ok: false,
      reason: "invalid_input",
    });
  });

  it("retains only the six most recent records", async () => {
    for (let index = 0; index < 8; index += 1) {
      await saveCapturePlanOptions({ ...record(`plan-${index}`), choices: [], options: [] });
    }
    const stored = values[CAPTURE_PLAN_OPTIONS_STORAGE_KEY] as { orderedPlanIds: string[] };
    expect(stored.orderedPlanIds).toEqual(["plan-7", "plan-6", "plan-5", "plan-4", "plan-3", "plan-2"]);
    await expect(getCapturePlanOptions("plan-0")).resolves.toEqual({ ok: true, record: null });
  });

  it("clears Review options while preserving only run-owned records", async () => {
    await saveCapturePlanOptions(record("plan-protected"));
    await saveCapturePlanOptions(record("plan-review"));
    await expect(clearUnreferencedCapturePlanOptions(["plan-protected"]))
      .resolves.toEqual({
        ok: true,
        removedPlanIds: ["plan-review"],
        preservedPlanIds: ["plan-protected"],
      });
    await expect(getCapturePlanOptions("plan-protected")).resolves.toMatchObject({
      ok: true,
      record: { planId: "plan-protected" },
    });
    await expect(getCapturePlanOptions("plan-review")).resolves.toEqual({
      ok: true,
      record: null,
    });
    await expect(clearUnreferencedCapturePlanOptions(["duplicate", "duplicate"]))
      .resolves.toEqual({ ok: false, reason: "invalid_input" });
  });

  it("rejects raw URL-shaped option IDs and corrupt storage", async () => {
    expect(await saveCapturePlanOptions({
      ...record(),
      choices: [{ itemId: "item-1", optionId: "variant.m3u8" }],
    })).toEqual({ ok: false, reason: "invalid_input" });
    values[CAPTURE_PLAN_OPTIONS_STORAGE_KEY] = { schemaVersion: 1, orderedPlanIds: ["missing"], records: {} };
    await expect(getCapturePlanOptions("plan-1")).resolves.toEqual({ ok: false, reason: "storage_corrupt" });
  });

  it("allows only the prepared-to-committed transition for identical command content", async () => {
    expect(await saveCapturePlanOptions(record())).toMatchObject({
      ok: true,
      record: { state: "prepared" },
    });
    expect(await saveCapturePlanOptions({ ...record(), state: "committed" })).toMatchObject({
      ok: true,
      record: { state: "committed" },
    });
    expect(await saveCapturePlanOptions(record())).toMatchObject({
      ok: true,
      record: { state: "committed" },
    });
    expect(await saveCapturePlanOptions({
      ...record(),
      plan: { ...record().plan, relativeRoot: "ClipHutch/Different" },
    })).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("freezes a defensive background-only lease map in canonical plan order", async () => {
    const value = readyRecord();
    const second = {
      ...value.plan.items[0],
      itemId: "item-2",
      media: {
        ...value.plan.items[0].media,
        mediaId: "media-2",
        url: "https://cdn.example/master-2.m3u8",
      },
      plannedRelativePath: "ClipHutch/Pack/example/video-2.mp4",
      copyChoice: { ...value.plan.items[0].copyChoice, candidateId: "media-2" },
    };
    value.plan.items = [second, value.plan.items[0]];
    value.plan.totals = {
      included: 2,
      videos: 2,
      stills: 0,
      unknownSizeCount: 2,
      requiredFreeVideoSlots: 2,
    };
    const mutableMap = { "item-1": "lease-1", "item-2": "lease-2" };
    value.headerLeaseIdsByItemId = mutableMap;

    expect(await saveCapturePlanOptions(value)).toMatchObject({ ok: true });
    mutableMap["item-1"] = "lease-mutated";
    const read = await getCapturePlanOptions(value.planId);
    expect(read).toMatchObject({
      ok: true,
      record: { headerLeaseIdsByItemId: { "item-2": "lease-2", "item-1": "lease-1" } },
    });
    if (!read.ok || !read.record) throw new Error("fixture failed");
    expect(Object.keys(read.record.headerLeaseIdsByItemId ?? {})).toEqual(["item-2", "item-1"]);
    expect(read.record.options[0]).not.toHaveProperty("headerLeaseId");
    expect(read.record.options[0]).not.toHaveProperty("headerLeaseIdsByItemId");

    (read.record.headerLeaseIdsByItemId as Record<string, string>)["item-1"] = "changed";
    await expect(getCapturePlanOptions(value.planId)).resolves.toMatchObject({
      ok: true,
      record: { headerLeaseIdsByItemId: { "item-1": "lease-1" } },
    });
  });

  it("rejects lease bindings for unknown, excluded, or unready items and changed replays", async () => {
    await expect(saveCapturePlanOptions({
      ...record(),
      headerLeaseIdsByItemId: { "item-1": "lease-1" },
    })).resolves.toEqual({ ok: false, reason: "invalid_input" });

    const excluded = readyRecord("plan-excluded");
    excluded.plan.items.push({
      ...excluded.plan.items[0],
      itemId: "item-excluded",
      include: false,
      readiness: "stale",
      plannedRelativePath: "ClipHutch/Pack/example/excluded.mp4",
      media: {
        ...excluded.plan.items[0].media,
        mediaId: "media-excluded",
        url: "https://cdn.example/excluded.m3u8",
      },
      copyChoice: { ...excluded.plan.items[0].copyChoice, candidateId: "media-excluded" },
      warnings: [{ code: "STALE", message: "Stale." }],
      qualityChoice: undefined,
    } as typeof excluded.plan.items[number]);
    await expect(saveCapturePlanOptions({
      ...excluded,
      headerLeaseIdsByItemId: { "item-excluded": "lease-excluded" },
    })).resolves.toEqual({ ok: false, reason: "invalid_input" });

    const ready = readyRecord("plan-conflict");
    await expect(saveCapturePlanOptions({
      ...ready,
      headerLeaseIdsByItemId: { "item-1": "lease-1" },
    })).resolves.toMatchObject({ ok: true });
    await expect(saveCapturePlanOptions({
      ...ready,
      headerLeaseIdsByItemId: { "item-1": "lease-2" },
    })).resolves.toEqual({ ok: false, reason: "invalid_input" });
  });

  it("rejects unsafe, duplicate, oversized, accessor, and undeclared lease-map data", async () => {
    const ready = readyRecord();
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(ready.plan, {
      "item-1": "https://evil.test/lease",
    })).toBeUndefined();

    const twoItems = readyRecord("plan-two");
    twoItems.plan.items.push({
      ...twoItems.plan.items[0],
      itemId: "item-2",
      plannedRelativePath: "ClipHutch/Pack/example/video-2.mp4",
      media: {
        ...twoItems.plan.items[0].media,
        mediaId: "media-2",
        url: "https://cdn.example/two.m3u8",
      },
      copyChoice: { ...twoItems.plan.items[0].copyChoice, candidateId: "media-2" },
    });
    twoItems.plan.totals = {
      included: 2,
      videos: 2,
      stills: 0,
      unknownSizeCount: 2,
      requiredFreeVideoSlots: 2,
    };
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(twoItems.plan, {
      "item-1": "lease-same",
      "item-2": "lease-same",
    })).toBeUndefined();

    const oversized = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [`item-${index}`, `lease-${index}`]),
    );
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(ready.plan, oversized)).toBeUndefined();

    const accessor = {} as Record<string, string>;
    Object.defineProperty(accessor, "item-1", { enumerable: true, get: () => "lease-1" });
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(ready.plan, accessor)).toBeUndefined();

    const nullPrototype = Object.create(null) as Record<string, string>;
    nullPrototype["item-1"] = "lease-1";
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(ready.plan, nullPrototype))
      .toEqual({ "item-1": "lease-1" });
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(
      ready.plan,
      Object.create({ "item-1": "lease-1" }),
    )).toBeUndefined();

    const symbolMap = { "item-1": "lease-1" } as Record<PropertyKey, string>;
    symbolMap[Symbol("hidden")] = "lease-hidden";
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(ready.plan, symbolMap)).toBeUndefined();
    const nonEnumerable = {} as Record<string, string>;
    Object.defineProperty(nonEnumerable, "item-1", { value: "lease-1" });
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(ready.plan, nonEnumerable)).toBeUndefined();
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(ready.plan, {
      "item-1": "x".repeat(257),
    })).toBeUndefined();
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(ready.plan, {
      "item-1": "lease with spaces",
    })).toBeUndefined();
    const revocable = Proxy.revocable({ "item-1": "lease-1" }, {});
    revocable.revoke();
    expect(canonicalizeCaptureHeaderLeaseIdsByItemId(ready.plan, revocable.proxy)).toBeUndefined();
    await expect(saveCapturePlanOptions({
      ...ready,
      extra: true,
    } as CapturePlanOptionsRecordV1)).resolves.toEqual({ ok: false, reason: "invalid_input" });
  });
});
