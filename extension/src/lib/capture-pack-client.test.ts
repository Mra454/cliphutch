import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDetectedMediaToCaptureDraft,
  getCaptureDraft,
  labelCaptureDraftPage,
  removeCaptureDraftPage,
  removeCaptureDraftItem,
  replaceCaptureDraftMedia,
  sendCaptureDraftRequest,
  setCaptureDraftManifestCsv,
} from "./capture-pack-client";
import type { CaptureDraftV1 } from "./capture-pack-types";

const draft: CaptureDraftV1 = {
  schemaVersion: 1,
  draftId: "capture-pack-11111111-1111-4111-8111-111111111111",
  revision: 1,
  name: "Pack",
  createdAt: 1,
  updatedAt: 2,
  orderedItemIds: [],
  items: {},
  preferences: {
    folderMode: "pack_page",
    manifestFormats: ["json"],
    qualityPolicy: { mode: "manual" },
  },
};

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn() },
  };
});

describe("Capture Pack UI client", () => {
  it("returns a guarded draft from the background owner", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      changed: false,
      draft,
    });
    await expect(getCaptureDraft()).resolves.toMatchObject({
      ok: true,
      draft: { draftId: draft.draftId },
    });
  });

  it("sends identifiers and revisions rather than caller-provided media snapshots", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      changed: true,
      draft: { ...draft, revision: 2 },
    });
    await addDetectedMediaToCaptureDraft({
      tabId: 7,
      mediaId: "media-1",
      expectedRevision: 1,
      commandId: "capture-draft-11111111-1111-4111-8111-111111111111",
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "capture-draft-add",
      commandId: "capture-draft-11111111-1111-4111-8111-111111111111",
      expectedRevision: 1,
      tabId: 7,
      mediaId: "media-1",
    });
  });

  it("preserves a conflict's latest guarded draft", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: false,
      reason: "revision_conflict",
      actualRevision: 2,
      draft: { ...draft, revision: 2 },
    });
    await expect(removeCaptureDraftItem({
      itemId: "capture-item-11111111-1111-4111-8111-111111111111",
      expectedRevision: 1,
      commandId: "capture-draft-22222222-2222-4222-8222-222222222222",
    })).resolves.toMatchObject({
      ok: false,
      reason: "revision_conflict",
      actualRevision: 2,
      draft: { revision: 2 },
    });
  });

  it("removes one exact page with a single revisioned command", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      changed: true,
      draft: { ...draft, revision: 2 },
    });
    await removeCaptureDraftPage({
      pageUrl: "https://example.test/gallery/2",
      expectedRevision: 1,
      commandId: "capture-draft-33333333-3333-4333-8333-333333333333",
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "capture-draft-remove-page",
      commandId: "capture-draft-33333333-3333-4333-8333-333333333333",
      expectedRevision: 1,
      pageUrl: "https://example.test/gallery/2",
    });
  });

  it("labels one exact page through a bounded revisioned command", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      changed: true,
      draft: { ...draft, revision: 2 },
    });
    await labelCaptureDraftPage({
      pageUrl: "https://example.test/gallery/2",
      label: "Product stills",
      expectedRevision: 1,
      commandId: "capture-draft-44444444-4444-4444-8444-444444444444",
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "capture-draft-label-page",
      commandId: "capture-draft-44444444-4444-4444-8444-444444444444",
      expectedRevision: 1,
      pageUrl: "https://example.test/gallery/2",
      label: "Product stills",
    });
  });

  it("requests an authoritative alternate replacement without sending a snapshot", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      changed: true,
      draft: { ...draft, revision: 2 },
    });
    await replaceCaptureDraftMedia({
      itemId: "capture-item-11111111-1111-4111-8111-111111111111",
      tabId: 7,
      mediaId: "alternate-2",
      expectedRevision: 1,
      commandId: "capture-draft-55555555-5555-4555-8555-555555555555",
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "capture-draft-replace-media",
      commandId: "capture-draft-55555555-5555-4555-8555-555555555555",
      expectedRevision: 1,
      itemId: "capture-item-11111111-1111-4111-8111-111111111111",
      tabId: 7,
      mediaId: "alternate-2",
    });
  });

  it("toggles only the optional CSV companion through a revisioned command", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({
      ok: true,
      changed: true,
      draft: {
        ...draft,
        revision: 2,
        preferences: { ...draft.preferences, manifestFormats: ["json", "csv"] },
      },
    });
    await setCaptureDraftManifestCsv({
      enabled: true,
      expectedRevision: 1,
      commandId: "capture-draft-66666666-6666-4666-8666-666666666666",
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: "capture-draft-set-manifest-csv",
      commandId: "capture-draft-66666666-6666-4666-8666-666666666666",
      expectedRevision: 1,
      enabled: true,
    });
  });

  it("fails closed on malformed responses and transport failures", async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ ok: true, changed: true, draft: {} });
    await expect(sendCaptureDraftRequest({ type: "capture-draft-get" })).resolves.toEqual({
      ok: false,
      reason: "invalid_background_response",
      draft: null,
    });
    vi.mocked(chrome.runtime.sendMessage).mockRejectedValue(new Error("worker down"));
    await expect(getCaptureDraft()).resolves.toEqual({
      ok: false,
      reason: "background_unavailable",
      draft: null,
    });
  });
});
