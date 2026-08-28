import { beforeEach, describe, expect, it } from "vitest";
import type { CaptureDraftItemV1, CaptureDraftV1 } from "./capture-pack-types";
import {
  CAPTURE_DRAFT_STORAGE_KEY,
  CAPTURE_DRAFT_STORAGE_OWNER,
  MAX_CAPTURE_DRAFT_ITEMS,
  applyCaptureDraftCommand,
  createEmptyCaptureDraftV1,
  getActiveCaptureDraft,
  parseStoredCaptureDraft,
  reduceCaptureDraft,
  serializedCaptureDraftBytes,
} from "./capture-pack-storage";

const item = (
  itemId: string,
  mediaId = `media-${itemId}`,
  pageUrl: string | undefined = "https://example.test/page-a",
): CaptureDraftItemV1 => ({
  itemId,
  addedAt: 10,
  sourceTabId: 1,
  media: {
    mediaId,
    kind: "direct",
    url: `https://cdn.example/${itemId}.mp4`,
    detectedAt: 9,
    pageUrl,
    pageTitle: "Example page",
    provenance: ["network"],
  },
});

function expectDraft(result: ReturnType<typeof reduceCaptureDraft>): CaptureDraftV1 {
  expect(result.ok).toBe(true);
  if (!result.ok || !result.draft) throw new Error("Expected a draft result");
  return result.draft;
}

function firstDraft(firstItem = item("item-1")): CaptureDraftV1 {
  return expectDraft(
    reduceCaptureDraft(null, {
      type: "add",
      expectedRevision: 0,
      at: 10,
      draftId: "draft-1",
      draftName: "Research",
      item: firstItem,
    }),
  );
}

describe("reduceCaptureDraft", () => {
  it("gets an isolated copy without changing the revision", () => {
    const original = firstDraft();
    const result = reduceCaptureDraft(original, { type: "get" });
    const read = expectDraft(result);
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(read.revision).toBe(1);
    read.items["item-1"].media.url = "https://mutated.invalid";
    expect(original.items["item-1"].media.url).toBe("https://cdn.example/item-1.mp4");
  });

  it("adds an immutable snapshot and preserves ordering", () => {
    const source = item("item-1");
    source.copyChoice = {
      candidateId: source.media.mediaId,
      confidence: "high",
      reason: "Background-ranked copy.",
    };
    const draft = firstDraft(source);
    source.media.url = "https://mutated.invalid";
    source.media.provenance.push("metadata");
    source.copyChoice.reason = "Mutated recommendation.";
    expect(draft.orderedItemIds).toEqual(["item-1"]);
    expect(draft.items["item-1"].media.url).toBe("https://cdn.example/item-1.mp4");
    expect(draft.items["item-1"].media.provenance).toEqual(["network"]);
    expect(draft.items["item-1"].copyChoice).toEqual({
      candidateId: "media-item-1",
      confidence: "high",
      reason: "Background-ranked copy.",
    });
  });

  it("rejects a draft copy choice that does not address its immutable media", () => {
    const mismatched = item("item-1");
    mismatched.copyChoice = {
      candidateId: "some-other-media",
      confidence: "high",
      reason: "Hostile cross-item pointer.",
    };
    expect(reduceCaptureDraft(null, {
      type: "add",
      expectedRevision: 0,
      at: 10,
      draftId: "draft-1",
      item: mismatched,
    })).toMatchObject({ ok: false, reason: "invalid_item" });
  });

  it("conflicts before considering an exact stale retry", () => {
    const draft = firstDraft();
    const result = reduceCaptureDraft(draft, {
      type: "add",
      expectedRevision: 0,
      at: 11,
      item: item("item-1", "media-item-1", "https://example.test/page-a"),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "revision_conflict",
      expectedRevision: 0,
      actualRevision: 1,
    });
  });

  it("returns alreadySelected only for the same canonical item at the current revision", () => {
    const draft = firstDraft();
    const result = reduceCaptureDraft(draft, {
      type: "add",
      expectedRevision: 1,
      at: 11,
      item: item("item-1", "media-item-1", "https://example.test/page-a"),
    });
    const unchanged = expectDraft(result);
    expect(result).toMatchObject({ ok: true, changed: false, alreadySelected: true });
    expect(unchanged.revision).toBe(1);
  });

  it("rejects a semantic page/media duplicate with a different item id", () => {
    const draft = firstDraft();
    const result = reduceCaptureDraft(draft, {
      type: "add",
      expectedRevision: 1,
      at: 11,
      item: item("different-item", "media-item-1", "https://example.test/page-a"),
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "duplicate_page_media",
      existingItemId: "item-1",
    });
  });

  it("allows the same media id from a genuinely different page", () => {
    const draft = firstDraft();
    const result = reduceCaptureDraft(draft, {
      type: "add",
      expectedRevision: 1,
      at: 11,
      item: item("item-2", "media-item-1", "https://example.test/page-b"),
    });
    const updated = expectDraft(result);
    expect(updated.orderedItemIds).toEqual(["item-1", "item-2"]);
    expect(updated.revision).toBe(2);
  });

  it("returns the latest draft instead of applying a stale state change", () => {
    const draft = firstDraft();
    const result = reduceCaptureDraft(draft, {
      type: "rename",
      expectedRevision: 0,
      at: 11,
      name: "Stale rename",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "revision_conflict",
      expectedRevision: 0,
      actualRevision: 1,
    });
    expect(result.draft?.name).toBe("Research");
  });

  it("does not overwrite an existing item id with a different snapshot", () => {
    const draft = firstDraft();
    const result = reduceCaptureDraft(draft, {
      type: "add",
      expectedRevision: 1,
      at: 11,
      item: item("item-1", "different-media", "https://example.test/page-b"),
    });
    expect(result).toMatchObject({ ok: false, reason: "duplicate_item_id" });
    expect(result.draft?.items["item-1"].media.mediaId).toBe("media-item-1");
  });

  it("makes cross-realm stale writers conflict through the shared revision", () => {
    const committed = firstDraft();
    const realmA = structuredClone(committed);
    const realmB = structuredClone(committed);
    const afterA = expectDraft(
      reduceCaptureDraft(committed, {
        type: "add",
        expectedRevision: realmA.revision,
        at: 11,
        item: item("item-2"),
      }),
    );
    const staleB = reduceCaptureDraft(afterA, {
      type: "rename",
      expectedRevision: realmB.revision,
      at: 12,
      name: "Realm B rename",
    });
    expect(staleB).toMatchObject({
      ok: false,
      reason: "revision_conflict",
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(staleB.draft?.name).toBe("Research");
  });

  it("removes one item, all items from one page, and then clears the draft", () => {
    let draft = firstDraft();
    draft = expectDraft(
      reduceCaptureDraft(draft, {
        type: "add",
        expectedRevision: 1,
        at: 11,
        item: item("item-2", "media-2", "https://example.test/page-b"),
      }),
    );
    draft = expectDraft(
      reduceCaptureDraft(draft, {
        type: "add",
        expectedRevision: 2,
        at: 12,
        item: item("item-3", "media-3", "https://example.test/page-b"),
      }),
    );
    draft = expectDraft(
      reduceCaptureDraft(draft, {
        type: "remove",
        expectedRevision: 3,
        at: 13,
        itemId: "item-1",
      }),
    );
    expect(draft.orderedItemIds).toEqual(["item-2", "item-3"]);

    draft = expectDraft(
      reduceCaptureDraft(draft, {
        type: "remove-page",
        expectedRevision: 4,
        at: 14,
        pageUrl: "https://example.test/page-b",
      }),
    );
    expect(draft.orderedItemIds).toEqual([]);

    const clear = reduceCaptureDraft(draft, {
      type: "clear",
      expectedRevision: 5,
      at: 15,
    });
    expect(clear).toMatchObject({ ok: true, changed: false });
  });

  it("renames with normalization and rejects empty names", () => {
    const draft = firstDraft();
    const renamed = expectDraft(
      reduceCaptureDraft(draft, {
        type: "rename",
        expectedRevision: 1,
        at: 11,
        name: "  Campaign research  ",
      }),
    );
    expect(renamed.name).toBe("Campaign research");
    expect(renamed.revision).toBe(2);
    expect(
      reduceCaptureDraft(renamed, {
        type: "rename",
        expectedRevision: 2,
        at: 12,
        name: "   ",
      }),
    ).toMatchObject({ ok: false, reason: "invalid_name" });
  });

  it("toggles only optional CSV while preserving mandatory JSON and revision ordering", () => {
    const draft = firstDraft();
    const enabled = expectDraft(reduceCaptureDraft(draft, {
      type: "set-manifest-csv",
      expectedRevision: draft.revision,
      at: 11,
      enabled: true,
    }));
    expect(enabled.preferences.manifestFormats).toEqual(["json", "csv"]);
    expect(enabled.revision).toBe(draft.revision + 1);

    const replay = reduceCaptureDraft(enabled, {
      type: "set-manifest-csv",
      expectedRevision: enabled.revision,
      at: 12,
      enabled: true,
    });
    expect(replay).toMatchObject({ ok: true, changed: false });
    expect(replay.draft?.revision).toBe(enabled.revision);

    const disabled = expectDraft(reduceCaptureDraft(enabled, {
      type: "set-manifest-csv",
      expectedRevision: enabled.revision,
      at: 13,
      enabled: false,
    }));
    expect(disabled.preferences.manifestFormats).toEqual(["json"]);
    expect(disabled.revision).toBe(enabled.revision + 1);
  });

  it("atomically labels only one normalized page and resets it with one revision bump", () => {
    let draft = firstDraft(item(
      "item-1",
      "media-1",
      "https://example.test/page-a",
    ));
    draft = expectDraft(reduceCaptureDraft(draft, {
      type: "add",
      expectedRevision: 1,
      at: 11,
      item: item("item-2", "media-2", "https://example.test:443/page-a"),
    }));
    draft = expectDraft(reduceCaptureDraft(draft, {
      type: "add",
      expectedRevision: 2,
      at: 12,
      item: item("item-3", "media-3", "https://example.test/page-b"),
    }));

    const labelledResult = reduceCaptureDraft(draft, {
      type: "label-page",
      expectedRevision: 3,
      at: 13,
      pageUrl: "https://EXAMPLE.test:443/page-a",
      label: "  Interview selects  ",
    });
    const labelled = expectDraft(labelledResult);
    expect(labelledResult).toMatchObject({ ok: true, changed: true });
    expect(labelled.revision).toBe(4);
    expect(labelled.items["item-1"].pageFolderLabel).toBe("Interview selects");
    expect(labelled.items["item-2"].pageFolderLabel).toBe("Interview selects");
    expect(labelled.items["item-3"].pageFolderLabel).toBeUndefined();

    const resetResult = reduceCaptureDraft(labelled, {
      type: "label-page",
      expectedRevision: 4,
      at: 14,
      pageUrl: "https://example.test/page-a",
      label: "   ",
    });
    const reset = expectDraft(resetResult);
    expect(reset.revision).toBe(5);
    expect(reset.items["item-1"].pageFolderLabel).toBeUndefined();
    expect(reset.items["item-2"].pageFolderLabel).toBeUndefined();
    expect(reset.items["item-3"].pageFolderLabel).toBeUndefined();
    expect("pageFolderLabel" in reset.items["item-1"]).toBe(false);

    const replayAtCurrentRevision = reduceCaptureDraft(reset, {
      type: "label-page",
      expectedRevision: 5,
      at: 15,
      pageUrl: "https://example.test/page-a",
      label: null,
    });
    expect(replayAtCurrentRevision).toMatchObject({ ok: true, changed: false });
    expect(replayAtCurrentRevision.draft?.revision).toBe(5);

    expect(reduceCaptureDraft(reset, {
      type: "label-page",
      expectedRevision: 4,
      at: 15,
      pageUrl: "https://example.test/page-a",
      label: "Stale overwrite",
    })).toMatchObject({
      ok: false,
      reason: "revision_conflict",
      expectedRevision: 4,
      actualRevision: 5,
    });
  });

  it("rejects unsafe page labels, invalid URLs, and oversized label candidates", () => {
    const draft = firstDraft();
    expect(reduceCaptureDraft(draft, {
      type: "label-page",
      expectedRevision: 1,
      at: 11,
      pageUrl: "file:///private/page",
      label: "Private",
    })).toMatchObject({ ok: false, reason: "invalid_page_url" });
    expect(reduceCaptureDraft(draft, {
      type: "label-page",
      expectedRevision: 1,
      at: 11,
      pageUrl: "https://example.test/page-a",
      label: "unsafe\u2066label",
    })).toMatchObject({ ok: false, reason: "invalid_page_label" });

    const currentBytes = serializedCaptureDraftBytes(draft);
    if (currentBytes === undefined) throw new Error("Expected serialized bytes");
    const rejected = reduceCaptureDraft(draft, {
      type: "label-page",
      expectedRevision: 1,
      at: 11,
      pageUrl: "https://example.test/page-a",
      label: "x".repeat(120),
    }, { maxItems: 200, maxSerializedBytes: currentBytes + 10 });
    expect(rejected).toMatchObject({ ok: false, reason: "serialized_byte_limit" });
    expect(rejected.draft?.revision).toBe(1);
    expect(rejected.draft?.items["item-1"].pageFolderLabel).toBeUndefined();
  });

  it("inherits a page label when another item from that normalized page is added", () => {
    const first = firstDraft();
    const labelled = expectDraft(reduceCaptureDraft(first, {
      type: "label-page",
      expectedRevision: 1,
      at: 11,
      pageUrl: "https://example.test/page-a",
      label: "Interview selects",
    }));
    const incoming = item("item-2", "media-2", "https://example.test:443/page-a");
    incoming.pageFolderLabel = "Caller must not split the page";
    const added = expectDraft(reduceCaptureDraft(labelled, {
      type: "add",
      expectedRevision: 2,
      at: 12,
      item: incoming,
    }));
    expect(added.items["item-1"].pageFolderLabel).toBe("Interview selects");
    expect(added.items["item-2"].pageFolderLabel).toBe("Interview selects");
  });

  it("atomically replaces media while preserving stable item state and a same-page label", () => {
    const original = item("item-1", "media-1", "https://example.test/page-a");
    original.pageFolderLabel = "Interview selects";
    original.family = { familyId: "old-family" };
    original.headerLeaseId = "old-lease";
    const draft = firstDraft(original);
    const alternate = item(
      "ignored-item-id",
      "media-alternate",
      "https://example.test:443/page-a",
    ).media;
    alternate.url = "https://cdn.example/alternate.mp4";

    const replacedResult = reduceCaptureDraft(draft, {
      type: "replace-media",
      expectedRevision: 1,
      at: 12,
      itemId: "item-1",
      sourceTabId: 9,
      media: alternate,
    });
    const replaced = expectDraft(replacedResult);
    expect(replacedResult).toMatchObject({ ok: true, changed: true });
    expect(replaced.revision).toBe(2);
    expect(replaced.orderedItemIds).toEqual(["item-1"]);
    expect(replaced.items["item-1"]).toMatchObject({
      itemId: "item-1",
      addedAt: 10,
      sourceTabId: 9,
      pageFolderLabel: "Interview selects",
      media: { mediaId: "media-alternate", url: "https://cdn.example/alternate.mp4" },
    });
    expect(replaced.items["item-1"].family).toBeUndefined();
    expect(replaced.items["item-1"].headerLeaseId).toBeUndefined();

    const exactNoOp = reduceCaptureDraft(replaced, {
      type: "replace-media",
      expectedRevision: 2,
      at: 13,
      itemId: "item-1",
      sourceTabId: 9,
      media: alternate,
    });
    expect(exactNoOp).toMatchObject({ ok: true, changed: false });
    expect(exactNoOp.draft?.revision).toBe(2);
  });

  it("atomically replaces and clones the background-owned copy status", () => {
    const draft = firstDraft();
    const replacementMedia = item(
      "replacement",
      "media-recommended",
      "https://example.test/page-a",
    ).media;
    replacementMedia.kind = "image";
    replacementMedia.url = "https://img.example/recommended.jpg";
    replacementMedia.familyId = "picture-family-1";
    const copyChoice = {
      candidateId: "media-recommended",
      confidence: "high" as const,
      reason: "Largest verified responsive image.",
    };
    const replaced = expectDraft(reduceCaptureDraft(draft, {
      type: "replace-media",
      expectedRevision: 1,
      at: 12,
      itemId: "item-1",
      sourceTabId: 9,
      media: replacementMedia,
      family: { familyId: "picture-family-1" },
      copyChoice,
    }));
    copyChoice.reason = "Mutated after reducer call.";
    expect(replaced.items["item-1"]).toMatchObject({
      family: { familyId: "picture-family-1" },
      copyChoice: {
        candidateId: "media-recommended",
        confidence: "high",
        reason: "Largest verified responsive image.",
      },
    });
  });

  it("drops an old page label after a page change and inherits the target page label", () => {
    const first = item("item-1", "media-1", "https://example.test/page-a");
    first.pageFolderLabel = "Page A";
    let draft = firstDraft(first);
    const targetPeer = item("item-2", "media-2", "https://example.test/page-b");
    targetPeer.pageFolderLabel = "Page B";
    draft = expectDraft(reduceCaptureDraft(draft, {
      type: "add",
      expectedRevision: 1,
      at: 11,
      item: targetPeer,
    }));

    const movedToUnlabelled = expectDraft(reduceCaptureDraft(draft, {
      type: "replace-media",
      expectedRevision: 2,
      at: 12,
      itemId: "item-1",
      sourceTabId: 3,
      media: item("replacement", "media-3", "https://example.test/page-c").media,
    }));
    expect(movedToUnlabelled.items["item-1"].pageFolderLabel).toBeUndefined();

    const movedToLabelled = expectDraft(reduceCaptureDraft(movedToUnlabelled, {
      type: "replace-media",
      expectedRevision: 3,
      at: 13,
      itemId: "item-1",
      sourceTabId: 3,
      media: item("replacement-2", "media-4", "https://example.test:443/page-b").media,
    }));
    expect(movedToLabelled.items["item-1"].pageFolderLabel).toBe("Page B");
  });

  it("atomically replaces the old header lease with the authoritative new lease", () => {
    const original = item("item-1");
    original.headerLeaseId = "lease-old";
    const draft = firstDraft(original);
    const replacementMedia = item(
      "replacement",
      "media-replacement",
      "https://example.test/page-a",
    ).media;
    const replaced = expectDraft(reduceCaptureDraft(draft, {
      type: "replace-media",
      expectedRevision: 1,
      at: 12,
      itemId: "item-1",
      sourceTabId: 9,
      media: replacementMedia,
      headerLeaseId: "lease-new",
    }));
    expect(replaced.items["item-1"].headerLeaseId).toBe("lease-new");

    expect(reduceCaptureDraft(replaced, {
      type: "replace-media",
      expectedRevision: 2,
      at: 13,
      itemId: "item-1",
      sourceTabId: 9,
      media: replacementMedia,
      headerLeaseId: " ",
    })).toMatchObject({ ok: false, reason: "invalid_item" });
  });

  it("rejects duplicate, hostile, oversized, and stale alternate replacements", () => {
    let draft = firstDraft();
    draft = expectDraft(reduceCaptureDraft(draft, {
      type: "add",
      expectedRevision: 1,
      at: 11,
      item: item("item-2", "media-2", "https://example.test/page-a"),
    }));
    expect(reduceCaptureDraft(draft, {
      type: "replace-media",
      expectedRevision: 2,
      at: 12,
      itemId: "item-1",
      sourceTabId: 1,
      media: item("target", "media-2", "https://example.test/page-a").media,
    })).toMatchObject({
      ok: false,
      reason: "duplicate_page_media",
      existingItemId: "item-2",
    });

    expect(reduceCaptureDraft(draft, {
      type: "replace-media",
      expectedRevision: 2,
      at: 12,
      itemId: "item-1",
      sourceTabId: 1,
      media: { ...item("bad").media, url: "file:///private/video.mp4" },
    })).toMatchObject({ ok: false, reason: "invalid_item" });

    const currentBytes = serializedCaptureDraftBytes(draft);
    if (currentBytes === undefined) throw new Error("Expected serialized bytes");
    const large = item("large", "media-large", "https://example.test/page-a").media;
    large.pageTitle = "x".repeat(1_024);
    expect(reduceCaptureDraft(draft, {
      type: "replace-media",
      expectedRevision: 2,
      at: 12,
      itemId: "item-1",
      sourceTabId: 1,
      media: large,
    }, { maxItems: 200, maxSerializedBytes: currentBytes + 10 })).toMatchObject({
      ok: false,
      reason: "serialized_byte_limit",
      draft: { revision: 2 },
    });

    const realmA = structuredClone(draft);
    const realmB = structuredClone(draft);
    const committed = expectDraft(reduceCaptureDraft(draft, {
      type: "replace-media",
      expectedRevision: realmA.revision,
      at: 12,
      itemId: "item-1",
      sourceTabId: 1,
      media: item("new-a", "media-a", "https://example.test/page-a").media,
    }));
    expect(reduceCaptureDraft(committed, {
      type: "replace-media",
      expectedRevision: realmB.revision,
      at: 13,
      itemId: "item-1",
      sourceTabId: 1,
      media: item("new-b", "media-b", "https://example.test/page-a").media,
    })).toMatchObject({
      ok: false,
      reason: "revision_conflict",
      expectedRevision: 2,
      actualRevision: 3,
    });
  });

  it("enforces the item cap without changing the current draft", () => {
    let draft = firstDraft();
    draft = expectDraft(
      reduceCaptureDraft(
        draft,
        {
          type: "add",
          expectedRevision: 1,
          at: 11,
          item: item("item-2"),
        },
        { maxItems: 2, maxSerializedBytes: 1_000_000 },
      ),
    );
    const rejected = reduceCaptureDraft(
      draft,
      {
        type: "add",
        expectedRevision: 2,
        at: 12,
        item: item("item-3"),
      },
      { maxItems: 2, maxSerializedBytes: 1_000_000 },
    );
    expect(rejected).toMatchObject({ ok: false, reason: "item_limit", limit: 2 });
    expect(rejected.draft?.orderedItemIds).toEqual(["item-1", "item-2"]);
  });

  it("measures UTF-8 bytes and rejects an oversized candidate", () => {
    const oversized = item("item-big");
    oversized.media.pageTitle = "🎬".repeat(500);
    const rejected = reduceCaptureDraft(
      null,
      {
        type: "add",
        expectedRevision: 0,
        at: 10,
        draftId: "draft-big",
        item: oversized,
      },
      { maxItems: 200, maxSerializedBytes: 800 },
    );
    expect(rejected).toMatchObject({
      ok: false,
      reason: "serialized_byte_limit",
      limit: 800,
    });
    if (rejected.ok || rejected.reason !== "serialized_byte_limit") {
      throw new Error("Expected byte limit result");
    }
    expect(rejected.measuredBytes).toBeGreaterThan(800);
  });
});

describe("parseStoredCaptureDraft", () => {
  it("distinguishes empty, corrupt, and future-schema storage", () => {
    expect(parseStoredCaptureDraft(undefined)).toEqual({ status: "empty" });
    expect(parseStoredCaptureDraft({ schemaVersion: 1, draftId: "broken" })).toEqual({
      status: "invalid",
      reason: "corrupt",
    });
    expect(parseStoredCaptureDraft({ schemaVersion: 2, future: true })).toEqual({
      status: "invalid",
      reason: "future_schema",
      schemaVersion: 2,
    });

    const cyclic: Record<string, unknown> = { schemaVersion: 1 };
    cyclic.self = cyclic;
    expect(parseStoredCaptureDraft(cyclic)).toEqual({ status: "invalid", reason: "corrupt" });
  });

  it("enforces the 200-item bound when reading an otherwise valid record", () => {
    const base = createEmptyCaptureDraftV1({ draftId: "draft-many", name: "Many", now: 10 });
    const entries = Array.from({ length: MAX_CAPTURE_DRAFT_ITEMS + 1 }, (_, index) => {
      const next = item(`item-${index}`);
      return [next.itemId, next] as const;
    });
    const overLimit: CaptureDraftV1 = {
      ...base,
      orderedItemIds: entries.map(([itemId]) => itemId),
      items: Object.fromEntries(entries),
    };
    expect(parseStoredCaptureDraft(overLimit)).toEqual({
      status: "invalid",
      reason: "item_limit",
    });
  });

  it("returns a copy and reports the serialized byte count", () => {
    const draft = firstDraft();
    const parsed = parseStoredCaptureDraft(draft);
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") throw new Error("Expected valid parse");
    expect(parsed.serializedBytes).toBe(serializedCaptureDraftBytes(draft));
    parsed.draft.name = "Changed";
    expect(draft.name).toBe("Research");
  });

  it("canonicalizes allowlisted fields instead of retaining undeclared storage data", () => {
    const draft = firstDraft();
    const rawDraft = draft as CaptureDraftV1 & { undeclared?: string };
    const rawItem = rawDraft.items["item-1"] as CaptureDraftItemV1 & { secret?: string };
    const rawMedia = rawItem.media as CaptureDraftItemV1["media"] & { internal?: string };
    const rawPreferences = rawDraft.preferences as CaptureDraftV1["preferences"] & {
      experimental?: boolean;
    };
    rawDraft.undeclared = "drop-me";
    rawItem.secret = "drop-me";
    rawItem.pageFolderLabel = "Interview selects";
    rawItem.copyChoice = {
      candidateId: rawItem.media.mediaId,
      confidence: "high",
      reason: "Largest verified responsive image.",
    };
    (rawItem.copyChoice as typeof rawItem.copyChoice & { alternateUrl?: string }).alternateUrl =
      "https://private.example/alternate.jpg";
    rawMedia.internal = "drop-me";
    rawPreferences.experimental = true;

    const parsed = parseStoredCaptureDraft(rawDraft);
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") throw new Error("Expected valid parse");
    expect("undeclared" in parsed.draft).toBe(false);
    expect("secret" in parsed.draft.items["item-1"]).toBe(false);
    expect(parsed.draft.items["item-1"].pageFolderLabel).toBe("Interview selects");
    expect(parsed.draft.items["item-1"].copyChoice).toEqual({
      candidateId: "media-item-1",
      confidence: "high",
      reason: "Largest verified responsive image.",
    });
    expect("alternateUrl" in (parsed.draft.items["item-1"].copyChoice ?? {})).toBe(false);
    expect("internal" in parsed.draft.items["item-1"].media).toBe(false);
    expect("experimental" in parsed.draft.preferences).toBe(false);
  });
});

describe("chrome.storage.session adapter", () => {
  let store: Record<string, unknown>;
  let writes: number;

  beforeEach(() => {
    store = {};
    writes = 0;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get(key: string) {
            return Promise.resolve(key in store ? { [key]: structuredClone(store[key]) } : {});
          },
          set(values: Record<string, unknown>) {
            writes += 1;
            Object.assign(store, structuredClone(values));
            return Promise.resolve();
          },
        },
      },
    };
  });

  it("stores and reads the single active draft", async () => {
    expect(CAPTURE_DRAFT_STORAGE_OWNER).toBe("background-service-worker");
    const added = await applyCaptureDraftCommand({
      type: "add",
      expectedRevision: 0,
      at: 10,
      draftId: "draft-1",
      draftName: "Research",
      item: item("item-1"),
    });
    expect(added).toMatchObject({ ok: true, changed: true });
    expect(writes).toBe(1);
    expect(store[CAPTURE_DRAFT_STORAGE_KEY]).toBeDefined();

    const read = await getActiveCaptureDraft();
    expect(read).toMatchObject({ ok: true, changed: false });
    expect(read.draft?.orderedItemIds).toEqual(["item-1"]);
    expect(writes).toBe(1);
  });

  it("serializes concurrent writers and returns a revision conflict without clobbering", async () => {
    await applyCaptureDraftCommand({
      type: "add",
      expectedRevision: 0,
      at: 10,
      draftId: "draft-1",
      item: item("item-1"),
    });
    const [first, second] = await Promise.all([
      applyCaptureDraftCommand({
        type: "add",
        expectedRevision: 1,
        at: 11,
        item: item("item-2"),
      }),
      applyCaptureDraftCommand({
        type: "add",
        expectedRevision: 1,
        at: 11,
        item: item("item-3"),
      }),
    ]);
    expect(first).toMatchObject({ ok: true, changed: true });
    expect(second).toMatchObject({
      ok: false,
      reason: "revision_conflict",
      actualRevision: 2,
    });
    const read = await getActiveCaptureDraft();
    expect(read.draft?.orderedItemIds).toEqual(["item-1", "item-2"]);
  });

  it("does not overwrite corrupt or future-schema storage", async () => {
    store[CAPTURE_DRAFT_STORAGE_KEY] = { schemaVersion: 1, draftId: "broken" };
    const corrupt = await getActiveCaptureDraft();
    expect(corrupt).toMatchObject({ ok: false, reason: "storage_corrupt" });
    expect(writes).toBe(0);

    store[CAPTURE_DRAFT_STORAGE_KEY] = { schemaVersion: 9, future: true };
    const future = await applyCaptureDraftCommand({
      type: "add",
      expectedRevision: 0,
      at: 10,
      draftId: "replacement",
      item: item("item-1"),
    });
    expect(future).toMatchObject({
      ok: false,
      reason: "storage_future_schema",
      schemaVersion: 9,
    });
    expect(writes).toBe(0);
    expect(store[CAPTURE_DRAFT_STORAGE_KEY]).toEqual({ schemaVersion: 9, future: true });
  });

  it("returns typed storage_unavailable results for get and set failures", async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get() {
            return Promise.reject(new Error("session unavailable"));
          },
          set() {
            return Promise.resolve();
          },
        },
      },
    };
    await expect(getActiveCaptureDraft()).resolves.toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "read",
      draft: null,
    });

    const existing = firstDraft();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get(key: string) {
            return Promise.resolve({ [key]: structuredClone(existing) });
          },
          set() {
            return Promise.reject(new Error("write failed"));
          },
        },
      },
    };
    const write = await applyCaptureDraftCommand({
      type: "rename",
      expectedRevision: 1,
      at: 11,
      name: "Not persisted",
    });
    expect(write).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "write",
      commitState: "absent",
    });
    expect(write.draft?.name).toBe("Research");
    expect(write.draft?.revision).toBe(1);
  });

  it("recovers a committed draft when storage rejects after applying the write", async () => {
    const existing = firstDraft();
    store[CAPTURE_DRAFT_STORAGE_KEY] = structuredClone(existing);
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get(key: string) {
            return Promise.resolve(key in store ? { [key]: structuredClone(store[key]) } : {});
          },
          set(values: Record<string, unknown>) {
            Object.assign(store, structuredClone(values));
            return Promise.reject(new Error("acknowledgement lost"));
          },
        },
      },
    };

    const write = await applyCaptureDraftCommand({
      type: "rename",
      expectedRevision: 1,
      at: 11,
      name: "Persisted despite rejection",
    });
    expect(write).toMatchObject({
      ok: true,
      changed: true,
      draft: { revision: 2, name: "Persisted despite rejection" },
    });
  });

  it("reports an unknown commit when read-back differs from both old and intended drafts", async () => {
    const existing = firstDraft();
    store[CAPTURE_DRAFT_STORAGE_KEY] = structuredClone(existing);
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        session: {
          get(key: string) {
            return Promise.resolve(key in store ? { [key]: structuredClone(store[key]) } : {});
          },
          set() {
            store[CAPTURE_DRAFT_STORAGE_KEY] = {
              ...structuredClone(existing),
              revision: 2,
              name: "Concurrent state",
              updatedAt: 12,
            };
            return Promise.reject(new Error("write state unknown"));
          },
        },
      },
    };

    const write = await applyCaptureDraftCommand({
      type: "rename",
      expectedRevision: 1,
      at: 11,
      name: "Intended state",
    });
    expect(write).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "write",
      commitState: "unknown",
      draft: { revision: 2, name: "Concurrent state" },
    });
  });
});
