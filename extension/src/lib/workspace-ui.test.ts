import { describe, expect, it } from "vitest";
import type { CaptureDraftV1, MediaSnapshotV1 } from "./capture-pack-types";
import {
  WORKSPACE_TAB_GAP_PX,
  WORKSPACE_TAB_MIN_TRACK_PX,
  activeTabLoadIsCurrent,
  binaryTabForKey,
  customerVisibleUrlTitle,
  groupCaptureDraftBySourcePage,
  hutchFocusItemAfterRemoval,
  sourcePageDisplayUrl,
  workspaceTabColumnCount,
  workspaceRouteForKey,
} from "./workspace-ui";

describe("hutchFocusItemAfterRemoval", () => {
  it("prefers the next row, then the previous row, then the Hutch heading", () => {
    const ids = ["one", "two", "three"];
    expect(hutchFocusItemAfterRemoval(ids, "two")).toBe("three");
    expect(hutchFocusItemAfterRemoval(ids, "three")).toBe("two");
    expect(hutchFocusItemAfterRemoval(["only"], "only")).toBeNull();
    expect(hutchFocusItemAfterRemoval(ids, "missing")).toBeNull();
  });
});

const media = (mediaId: string, pageUrl?: string, pageTitle?: string): MediaSnapshotV1 => ({
  mediaId,
  kind: "direct",
  url: `https://cdn.example/${mediaId}.mp4`,
  detectedAt: 1,
  provenance: ["network"],
  ...(pageUrl ? { pageUrl } : {}),
  ...(pageTitle ? { pageTitle } : {}),
});

function draft(): CaptureDraftV1 {
  return {
    schemaVersion: 1,
    draftId: "draft-1",
    revision: 2,
    name: "Hutch",
    createdAt: 1,
    updatedAt: 2,
    orderedItemIds: ["one", "two", "three"],
    items: {
      one: { itemId: "one", addedAt: 1, media: media("one", "https://example.com/a", "Page A") },
      two: { itemId: "two", addedAt: 1, media: media("two", "https://example.com/a") },
      three: { itemId: "three", addedAt: 1, media: media("three", "chrome://settings") },
    },
    preferences: {
      folderMode: "pack_page",
      manifestFormats: ["json"],
      qualityPolicy: { mode: "manual" },
    },
  };
}

describe("workspaceRouteForKey", () => {
  it("wraps arrow navigation and supports Home and End", () => {
    expect(workspaceRouteForKey("shelf", "ArrowLeft")).toBe("activity");
    expect(workspaceRouteForKey("activity", "ArrowRight")).toBe("shelf");
    expect(workspaceRouteForKey("review", "Home")).toBe("shelf");
    expect(workspaceRouteForKey("shelf", "End")).toBe("activity");
    expect(workspaceRouteForKey("hutch", "Enter")).toBeNull();
  });

  it.each([160, 200])("keeps the route grid inside a %ipx zoom-width viewport", (width) => {
    const columns = workspaceTabColumnCount(width);
    const available = width - 32;
    const minimumOccupiedWidth = columns * WORKSPACE_TAB_MIN_TRACK_PX +
      (columns - 1) * WORKSPACE_TAB_GAP_PX;
    expect(columns).toBe(2);
    expect(minimumOccupiedWidth).toBeLessThanOrEqual(available);
  });

  it("uses all four route columns at the normal popup width", () => {
    expect(workspaceTabColumnCount(320)).toBe(4);
  });
});

describe("binaryTabForKey", () => {
  it("provides roving behavior for the Videos and Stills tabs", () => {
    expect(binaryTabForKey("videos", "ArrowRight", "videos", "stills")).toBe("stills");
    expect(binaryTabForKey("stills", "ArrowLeft", "videos", "stills")).toBe("videos");
    expect(binaryTabForKey("stills", "Home", "videos", "stills")).toBe("videos");
    expect(binaryTabForKey("videos", "End", "videos", "stills")).toBe("stills");
    expect(binaryTabForKey("videos", "Space", "videos", "stills")).toBeNull();
  });
});

describe("groupCaptureDraftBySourcePage", () => {
  it("preserves item order, groups exact canonical pages, and isolates unsupported pages", () => {
    expect(groupCaptureDraftBySourcePage(draft())).toEqual([
      {
        key: "https://example.com/a",
        pageUrl: "https://example.com/a",
        pageTitle: "Page A",
        pageHost: "example.com",
        itemIds: ["one", "two"],
      },
      {
        key: "__unassigned__",
        pageUrl: null,
        pageTitle: undefined,
        pageHost: "Unassigned source",
        itemIds: ["three"],
      },
    ]);
  });
});

describe("sourcePageDisplayUrl", () => {
  it("never exposes credentials, signed query values, or fragments", () => {
    const display = sourcePageDisplayUrl(
      "https://user:secret@example.com/private/video?token=signed-secret#account",
    );
    expect(display).toBe("example.com/private/video");
    expect(display).not.toContain("secret");
    expect(sourcePageDisplayUrl(null)).toBe("No supported source page was recorded");
  });

  it("exposes a signed URL in a title only after the full-URL setting is enabled", () => {
    const signed = "https://user:secret@example.com/private/video.mp4?token=signed-secret#account";
    expect(customerVisibleUrlTitle(signed, false)).toBe("example.com/private/video.mp4");
    expect(customerVisibleUrlTitle(signed, false)).not.toContain("secret");
    expect(customerVisibleUrlTitle(signed, true)).toBe(signed);
    expect(customerVisibleUrlTitle(null, false)).toBeUndefined();
  });
});

describe("activeTabLoadIsCurrent", () => {
  it("rejects both superseded generations and same-generation wrong-tab results", () => {
    expect(activeTabLoadIsCurrent({
      currentGeneration: 4,
      loadGeneration: 4,
      currentTabId: 9,
      loadTabId: 9,
    })).toBe(true);
    expect(activeTabLoadIsCurrent({
      currentGeneration: 5,
      loadGeneration: 4,
      currentTabId: 9,
      loadTabId: 9,
    })).toBe(false);
    expect(activeTabLoadIsCurrent({
      currentGeneration: 4,
      loadGeneration: 4,
      currentTabId: 10,
      loadTabId: 9,
    })).toBe(false);
  });

  it("rejects delayed tab A stats after tab B has become current", async () => {
    let currentGeneration = 1;
    let currentTabId: number | null = 11;
    let releaseTabA!: (value: string) => void;
    const delayedTabA = new Promise<string>((resolve) => {
      releaseTabA = resolve;
    });
    const applied: string[] = [];

    const applyWhenCurrent = async (
      loadGeneration: number,
      loadTabId: number,
      result: Promise<string>,
    ) => {
      const value = await result;
      if (activeTabLoadIsCurrent({
        currentGeneration,
        loadGeneration,
        currentTabId,
        loadTabId,
      })) applied.push(value);
    };

    const tabARead = applyWhenCurrent(1, 11, delayedTabA);
    currentGeneration = 2;
    currentTabId = 22;
    await applyWhenCurrent(2, 22, Promise.resolve("tab B"));
    releaseTabA("tab A");
    await tabARead;

    expect(applied).toEqual(["tab B"]);
  });
});
