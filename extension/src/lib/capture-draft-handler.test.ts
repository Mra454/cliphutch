import { describe, expect, it, vi } from "vitest";
import type { DetectedVideo } from "../types";
import { handleCaptureDraftUiRequest, type CaptureDraftHandlerDependencies } from "./capture-draft-handler";
import type { CaptureDraftCommand, CaptureDraftStorageResult } from "./capture-pack-storage";
import { CAPTURE_PACK_SCHEMA_VERSION, type CaptureDraftV1 } from "./capture-pack-types";

const COMMAND_ID = "capture-draft-123e4567-e89b-42d3-a456-426614174000";

function draft(items: CaptureDraftV1["items"] = {}, revision = 0): CaptureDraftV1 {
  return {
    schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
    draftId: "draft-1",
    revision,
    name: "Pack",
    createdAt: 10,
    updatedAt: 10,
    orderedItemIds: Object.keys(items),
    items,
    preferences: {
      folderMode: "pack_page",
      manifestFormats: ["json"],
      qualityPolicy: { mode: "manual" },
    },
  };
}

function detected(): DetectedVideo {
  return {
    id: "media-1",
    url: "https://cdn.example/video.mp4?token=session-only",
    kind: "direct",
    detectedAt: 20,
    pageUrl: "https://example.com/watch",
    pageTitle: "Watch",
    contentType: "video/mp4",
  };
}

function dependencies(
  current: CaptureDraftV1 | null = null,
): CaptureDraftHandlerDependencies & {
  applyCommand: ReturnType<typeof vi.fn>;
  findDetectedMedia: ReturnType<typeof vi.fn>;
  listDetectedMedia: ReturnType<typeof vi.fn>;
  prepareHeaderLease: ReturnType<typeof vi.fn>;
  releaseDraftHeaderLease: ReturnType<typeof vi.fn>;
} {
  const applyCommand = vi.fn(async (command: Exclude<CaptureDraftCommand, { type: "get" }>) => {
    if (command.type !== "add") {
      return { ok: true, changed: true, draft: current } satisfies CaptureDraftStorageResult;
    }
    const next = draft({ [command.item.itemId]: command.item }, (current?.revision ?? 0) + 1);
    return { ok: true, changed: true, draft: next } satisfies CaptureDraftStorageResult;
  });
  const findDetectedMedia = vi.fn(async (_tabId: number, _mediaId: string) => detected());
  const listDetectedMedia = vi.fn(async (tabId: number) => {
    const selected = await findDetectedMedia(tabId, "test-selected-media");
    return selected === undefined ? [] : [selected];
  });
  const prepareHeaderLease = vi.fn(async () => ({ ok: true as const }));
  const releaseDraftHeaderLease = vi.fn(async () => undefined);
  return {
    getDraft: async () => ({ ok: true, changed: false, draft: current }),
    applyCommand,
    findDetectedMedia,
    listDetectedMedia,
    prepareHeaderLease,
    releaseDraftHeaderLease,
    now: () => 30,
  };
}

describe("background-owned Capture Pack draft handling", () => {
  it("returns a draft without invoking mutation or media lookup", async () => {
    const deps = dependencies(draft());
    const result = await handleCaptureDraftUiRequest({ type: "capture-draft-get" }, deps);
    expect(result.ok).toBe(true);
    expect(deps.applyCommand).not.toHaveBeenCalled();
    expect(deps.findDetectedMedia).not.toHaveBeenCalled();
  });

  it("resolves a detected item authoritatively and strips undeclared secrets", async () => {
    const deps = dependencies();
    deps.findDetectedMedia.mockResolvedValue({
      ...detected(),
      authorization: "Bearer secret",
      requestHeaders: { Cookie: "secret" },
    });
    const result = await handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 0,
      tabId: 7,
      mediaId: "media-1",
    }, deps);
    expect(result.ok).toBe(true);
    const command = deps.applyCommand.mock.calls[0][0] as Extract<CaptureDraftCommand, { type: "add" }>;
    expect(command.item.itemId).toContain("123e4567-e89b");
    expect(command.item.sourceTabId).toBe(7);
    expect(JSON.stringify(command.item)).not.toContain("Bearer secret");
    expect(JSON.stringify(command.item)).not.toContain("Cookie");
  });

  it("freezes a background-ranked copy choice without persisting alternate media", async () => {
    const deps = dependencies();
    deps.listDetectedMedia.mockResolvedValue([
      {
        id: "image-small",
        kind: "image",
        url: "https://img.example/alternate-small.jpg?private=do-not-freeze",
        detectedAt: 20,
        pageUrl: "https://example.com/gallery",
        familyId: "picture-family-1",
        provenance: ["picture"],
        width: 640,
        height: 480,
      },
      {
        id: "image-large",
        kind: "image",
        url: "https://img.example/selected-large.jpg",
        detectedAt: 21,
        pageUrl: "https://example.com/gallery",
        familyId: "picture-family-1",
        provenance: ["picture"],
        width: 1_920,
        height: 1_080,
      },
    ]);

    const result = await handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 0,
      tabId: 7,
      mediaId: "image-large",
    }, deps);
    expect(result.ok).toBe(true);
    const command = deps.applyCommand.mock.calls[0][0] as Extract<
      CaptureDraftCommand,
      { type: "add" }
    >;
    expect(command.item).toMatchObject({
      media: { mediaId: "image-large" },
      family: { familyId: "picture-family-1" },
      copyChoice: {
        candidateId: "image-large",
        confidence: "high",
        reason: expect.stringContaining("1920 × 1080"),
      },
    });
    expect(JSON.stringify(command.item)).not.toContain("alternate-small");
    expect(JSON.stringify(command.item)).not.toContain("do-not-freeze");
  });

  it("freezes a selected related alternative as an unproven override", async () => {
    const deps = dependencies();
    deps.listDetectedMedia.mockResolvedValue([
      {
        id: "image-small",
        kind: "image",
        url: "https://img.example/small.jpg",
        detectedAt: 20,
        pageUrl: "https://example.com/gallery",
        familyId: "picture-family-1",
        provenance: ["picture"],
        width: 640,
        height: 480,
      },
      {
        id: "image-large",
        kind: "image",
        url: "https://img.example/large.jpg",
        detectedAt: 21,
        pageUrl: "https://example.com/gallery",
        familyId: "picture-family-1",
        provenance: ["picture"],
        width: 1_920,
        height: 1_080,
      },
    ]);

    await handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 0,
      tabId: 7,
      mediaId: "image-small",
    }, deps);
    expect((deps.applyCommand.mock.calls[0][0] as Extract<
      CaptureDraftCommand,
      { type: "add" }
    >).item.copyChoice).toEqual({
      candidateId: "image-small",
      confidence: "unproven",
      reason: "You chose this verified related copy instead of ClipHutch's high-confidence recommendation.",
    });
  });

  it("freezes a background lease into Add and compensates only a proven failed commit", async () => {
    const absent = dependencies();
    absent.findDetectedMedia.mockResolvedValue({
      ...detected(),
      hasCapturedReplayHeaders: true,
    });
    absent.prepareHeaderLease.mockResolvedValue({ ok: true, headerLeaseId: "lease-add" });
    absent.applyCommand.mockResolvedValue({
      ok: false,
      reason: "storage_unavailable",
      operation: "write",
      commitState: "absent",
      draft: null,
    });
    await handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 0,
      tabId: 7,
      mediaId: "media-1",
    }, absent);
    expect(absent.applyCommand.mock.calls[0][0]).toMatchObject({
      type: "add",
      item: { headerLeaseId: "lease-add" },
    });
    expect(absent.releaseDraftHeaderLease).toHaveBeenCalledWith(expect.objectContaining({
      item: expect.objectContaining({ headerLeaseId: "lease-add" }),
    }));

    const unknown = dependencies();
    unknown.findDetectedMedia.mockResolvedValue({
      ...detected(),
      hasCapturedReplayHeaders: true,
    });
    unknown.prepareHeaderLease.mockResolvedValue({ ok: true, headerLeaseId: "lease-add" });
    unknown.applyCommand.mockResolvedValue({
      ok: false,
      reason: "storage_unavailable",
      operation: "write",
      commitState: "unknown",
      draft: null,
    });
    await handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 0,
      tabId: 7,
      mediaId: "media-1",
    }, unknown);
    expect(unknown.releaseDraftHeaderLease).not.toHaveBeenCalled();
  });

  it("fails visibly when required captured headers cannot become a lease", async () => {
    const deps = dependencies();
    deps.findDetectedMedia.mockResolvedValue({
      ...detected(),
      hasCapturedReplayHeaders: true,
    });
    deps.prepareHeaderLease.mockResolvedValue({ ok: false });
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 0,
      tabId: 7,
      mediaId: "media-1",
    }, deps)).resolves.toMatchObject({ ok: false, reason: "header_lease_unavailable" });
    expect(deps.applyCommand).not.toHaveBeenCalled();
  });

  it("fails closed when the shelf item vanished or is invalid", async () => {
    const missing = dependencies();
    missing.findDetectedMedia.mockResolvedValue(undefined);
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 0,
      tabId: 7,
      mediaId: "media-1",
    }, missing)).resolves.toMatchObject({ ok: false, reason: "media_not_found" });

    const invalid = dependencies();
    invalid.findDetectedMedia.mockResolvedValue({ ...detected(), url: "file:///secret" });
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 0,
      tabId: 7,
      mediaId: "media-1",
    }, invalid)).resolves.toMatchObject({ ok: false, reason: "invalid_detected_media" });
  });

  it("returns a revision conflict before looking up media", async () => {
    const deps = dependencies(draft({}, 2));
    const result = await handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      tabId: 7,
      mediaId: "media-1",
    }, deps);
    expect(result).toMatchObject({ ok: false, reason: "revision_conflict", actualRevision: 2 });
    expect(deps.findDetectedMedia).not.toHaveBeenCalled();
  });

  it("reconciles CSV preference replays but rejects a stale different preference", async () => {
    const csvDraft = draft({}, 2);
    csvDraft.preferences.manifestFormats = ["json", "csv"];
    const replayDeps = dependencies(csvDraft);
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-set-manifest-csv",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      enabled: true,
    }, replayDeps)).resolves.toMatchObject({ ok: true, changed: false, draft: { revision: 2 } });
    expect(replayDeps.applyCommand).not.toHaveBeenCalled();

    const conflictDeps = dependencies(csvDraft);
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-set-manifest-csv",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      enabled: false,
    }, conflictDeps)).resolves.toMatchObject({
      ok: false,
      reason: "revision_conflict",
      actualRevision: 2,
    });
    expect(conflictDeps.applyCommand).not.toHaveBeenCalled();
  });

  it("passes a current CSV toggle to the storage owner without media or lease lookup", async () => {
    const current = draft({}, 3);
    const deps = dependencies(current);
    await handleCaptureDraftUiRequest({
      type: "capture-draft-set-manifest-csv",
      commandId: COMMAND_ID,
      expectedRevision: 3,
      enabled: true,
    }, deps);
    expect(deps.applyCommand).toHaveBeenCalledWith({
      type: "set-manifest-csv",
      expectedRevision: 3,
      at: 30,
      enabled: true,
    });
    expect(deps.findDetectedMedia).not.toHaveBeenCalled();
    expect(deps.prepareHeaderLease).not.toHaveBeenCalled();
  });

  it("replays an already committed add by command-derived item ID", async () => {
    const itemId = "capture-item-123e4567-e89b-42d3-a456-426614174000";
    const item = {
      itemId,
      addedAt: 20,
      sourceTabId: 7,
      media: {
        mediaId: "media-1",
        kind: "direct" as const,
        url: "https://cdn.example/video.mp4",
        detectedAt: 20,
        provenance: ["network" as const],
      },
    };
    const deps = dependencies(draft({ [itemId]: item }, 1));
    const result = await handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 0,
      tabId: 7,
      mediaId: "different-replay-payload",
    }, deps);
    expect(result).toMatchObject({ ok: true, changed: false, alreadySelected: true });
    expect(deps.findDetectedMedia).not.toHaveBeenCalled();
    expect(deps.applyCommand).not.toHaveBeenCalled();
  });

  it("reconciles a concurrent same-command commit after a revision conflict", async () => {
    const deps = dependencies();
    const itemId = "capture-item-123e4567-e89b-42d3-a456-426614174000";
    deps.applyCommand.mockResolvedValue({
      ok: false,
      reason: "revision_conflict",
      expectedRevision: 0,
      actualRevision: 1,
      draft: draft({
        [itemId]: {
          itemId,
          addedAt: 30,
          sourceTabId: 7,
          media: { ...detected(), mediaId: "media-1", provenance: ["network"] },
        },
      }, 1),
    });
    const result = await handleCaptureDraftUiRequest({
      type: "capture-draft-add",
      commandId: COMMAND_ID,
      expectedRevision: 0,
      tabId: 7,
      mediaId: "media-1",
    }, deps);
    expect(result).toMatchObject({ ok: true, changed: false, alreadySelected: true });
  });

  it("canonicalizes page removal and generates timestamps in background", async () => {
    const deps = dependencies(draft({}, 1));
    await handleCaptureDraftUiRequest({
      type: "capture-draft-remove-page",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      pageUrl: "https://example.com",
    }, deps);
    expect(deps.applyCommand).toHaveBeenCalledWith({
      type: "remove-page",
      expectedRevision: 1,
      at: 30,
      pageUrl: "https://example.com/",
    });
  });

  it("canonicalizes and forwards an exact-page folder-label mutation", async () => {
    const deps = dependencies(draft({}, 1));
    await handleCaptureDraftUiRequest({
      type: "capture-draft-label-page",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      pageUrl: "https://EXAMPLE.com:443/watch",
      label: "  Interview selects  ",
    }, deps);
    expect(deps.applyCommand).toHaveBeenCalledWith({
      type: "label-page",
      expectedRevision: 1,
      at: 30,
      pageUrl: "https://example.com/watch",
      label: "Interview selects",
    });
  });

  it("reconciles an exact label replay but conflicts a stale different edit", async () => {
    const itemId = "item-1";
    const current = draft({
      [itemId]: {
        itemId,
        addedAt: 20,
        pageFolderLabel: "Interview selects",
        media: {
          mediaId: "media-1",
          kind: "direct",
          url: "https://cdn.example/video.mp4",
          detectedAt: 20,
          pageUrl: "https://example.com/watch",
          provenance: ["network"],
        },
      },
    }, 2);
    const replayDeps = dependencies(current);
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-label-page",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      pageUrl: "https://example.com/watch",
      label: "Interview selects",
    }, replayDeps)).resolves.toMatchObject({ ok: true, changed: false, draft: { revision: 2 } });
    expect(replayDeps.applyCommand).not.toHaveBeenCalled();

    const staleDeps = dependencies(current);
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-label-page",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      pageUrl: "https://example.com/watch",
      label: "Different label",
    }, staleDeps)).resolves.toMatchObject({
      ok: false,
      reason: "revision_conflict",
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(staleDeps.applyCommand).not.toHaveBeenCalled();
  });

  it("resolves and forwards an authoritative alternate-media replacement", async () => {
    const itemId = "item-1";
    const current = draft({
      [itemId]: {
        itemId,
        addedAt: 20,
        pageFolderLabel: "Interview selects",
        media: {
          mediaId: "media-1",
          kind: "direct",
          url: "https://cdn.example/original.mp4",
          detectedAt: 20,
          pageUrl: "https://example.com/watch",
          provenance: ["network"],
        },
      },
    }, 1);
    const deps = dependencies(current);
    deps.findDetectedMedia.mockResolvedValue({
      ...detected(),
      id: "alternate-2",
      url: "https://cdn.example/alternate.mp4",
      authorization: "Bearer secret",
      requestHeaders: { Cookie: "secret" },
    });
    const result = await handleCaptureDraftUiRequest({
      type: "capture-draft-replace-media",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      itemId,
      tabId: 7,
      mediaId: "alternate-2",
    }, deps);
    expect(result.ok).toBe(true);
    const command = deps.applyCommand.mock.calls[0][0] as Extract<
      CaptureDraftCommand,
      { type: "replace-media" }
    >;
    expect(command).toMatchObject({
      type: "replace-media",
      expectedRevision: 1,
      at: 30,
      itemId,
      sourceTabId: 7,
      media: { mediaId: "alternate-2", url: "https://cdn.example/alternate.mp4" },
      copyChoice: {
        candidateId: "alternate-2",
        confidence: "exact",
        reason: "Exact media selected from the Capture Pack draft.",
      },
    });
    expect(JSON.stringify(command)).not.toContain("Bearer secret");
    expect(JSON.stringify(command)).not.toContain("Cookie");
  });

  it("replays an already-applied replacement after revision advance and rejects stale divergence", async () => {
    const itemId = "item-1";
    const current = draft({
      [itemId]: {
        itemId,
        addedAt: 20,
        sourceTabId: 7,
        media: {
          mediaId: "alternate-2",
          kind: "direct",
          url: "https://cdn.example/alternate.mp4",
          detectedAt: 20,
          pageUrl: "https://example.com/watch",
          provenance: ["network"],
        },
      },
    }, 4);
    const replayDeps = dependencies(current);
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-replace-media",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      itemId,
      tabId: 7,
      mediaId: "alternate-2",
    }, replayDeps)).resolves.toMatchObject({ ok: true, changed: false, draft: { revision: 4 } });
    expect(replayDeps.findDetectedMedia).not.toHaveBeenCalled();
    expect(replayDeps.applyCommand).not.toHaveBeenCalled();

    const staleDeps = dependencies(current);
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-replace-media",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      itemId,
      tabId: 7,
      mediaId: "alternate-3",
    }, staleDeps)).resolves.toMatchObject({
      ok: false,
      reason: "revision_conflict",
      expectedRevision: 1,
      actualRevision: 4,
    });
    expect(staleDeps.findDetectedMedia).not.toHaveBeenCalled();
  });

  it("rejects hostile or mismatched detected media without mutating the draft", async () => {
    const itemId = "item-1";
    const current = draft({
      [itemId]: {
        itemId,
        addedAt: 20,
        media: {
          mediaId: "media-1",
          kind: "direct",
          url: "https://cdn.example/original.mp4",
          detectedAt: 20,
          provenance: ["network"],
        },
      },
    }, 1);
    const hostile = dependencies(current);
    hostile.findDetectedMedia.mockResolvedValue({
      ...detected(),
      id: "alternate-2",
      url: "file:///private/alternate.mp4",
    });
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-replace-media",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      itemId,
      tabId: 7,
      mediaId: "alternate-2",
    }, hostile)).resolves.toMatchObject({ ok: false, reason: "invalid_detected_media" });
    expect(hostile.applyCommand).not.toHaveBeenCalled();

    const mismatched = dependencies(current);
    mismatched.findDetectedMedia.mockResolvedValue({ ...detected(), id: "different-id" });
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-replace-media",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      itemId,
      tabId: 7,
      mediaId: "alternate-2",
    }, mismatched)).resolves.toMatchObject({ ok: false, reason: "media_not_found" });
    expect(mismatched.applyCommand).not.toHaveBeenCalled();

    const proxy = dependencies(current);
    proxy.findDetectedMedia.mockResolvedValue(new Proxy({} as DetectedVideo, {
      get() {
        throw new Error("hostile detected getter");
      },
    }));
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-replace-media",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      itemId,
      tabId: 7,
      mediaId: "alternate-2",
    }, proxy)).resolves.toMatchObject({ ok: false, reason: "invalid_detected_media" });
    expect(proxy.applyCommand).not.toHaveBeenCalled();
  });

  it("fails closed for missing targets/media and reconciles an apply-time same-result race", async () => {
    const current = draft({}, 1);
    const missingTarget = dependencies(current);
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-replace-media",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      itemId: "missing-item",
      tabId: 7,
      mediaId: "alternate-2",
    }, missingTarget)).resolves.toMatchObject({ ok: false, reason: "item_not_found" });
    expect(missingTarget.findDetectedMedia).not.toHaveBeenCalled();

    const itemId = "item-1";
    const original = draft({
      [itemId]: {
        itemId,
        addedAt: 20,
        media: {
          mediaId: "media-1",
          kind: "direct",
          url: "https://cdn.example/original.mp4",
          detectedAt: 20,
          provenance: ["network"],
        },
      },
    }, 1);
    const missingMedia = dependencies(original);
    missingMedia.findDetectedMedia.mockResolvedValue(undefined);
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-replace-media",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      itemId,
      tabId: 7,
      mediaId: "alternate-2",
    }, missingMedia)).resolves.toMatchObject({ ok: false, reason: "media_not_found" });
    expect(missingMedia.applyCommand).not.toHaveBeenCalled();

    const raced = dependencies(original);
    raced.findDetectedMedia.mockResolvedValue({ ...detected(), id: "alternate-2" });
    raced.applyCommand.mockResolvedValue({
      ok: false,
      reason: "revision_conflict",
      expectedRevision: 1,
      actualRevision: 2,
      draft: draft({
        [itemId]: {
          itemId,
          addedAt: 20,
          sourceTabId: 7,
          media: {
            mediaId: "alternate-2",
            kind: "direct",
            url: "https://cdn.example/video.mp4?token=session-only",
            detectedAt: 20,
            provenance: ["network"],
          },
        },
      }, 2),
    });
    await expect(handleCaptureDraftUiRequest({
      type: "capture-draft-replace-media",
      commandId: COMMAND_ID,
      expectedRevision: 1,
      itemId,
      tabId: 7,
      mediaId: "alternate-2",
    }, raced)).resolves.toMatchObject({ ok: true, changed: false, draft: { revision: 2 } });
  });
});
