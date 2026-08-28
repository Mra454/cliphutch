import type { CaptureDraftItemV1, CaptureDraftV1 } from "./capture-pack-types";

export const WORKSPACE_ROUTES = ["shelf", "hutch", "review", "activity"] as const;
export const WORKSPACE_TAB_GAP_PX = 5;
export const WORKSPACE_TAB_MIN_TRACK_PX = 60;

export type WorkspaceRoute = typeof WORKSPACE_ROUTES[number];
export type WorkspaceSurface = "popup" | "sidepanel";

export const WORKSPACE_ROUTE_LABELS: Record<WorkspaceRoute, string> = {
  shelf: "This Page",
  hutch: "Hutch",
  review: "Review",
  activity: "Activity",
};

/** Mirrors the auto-fit route grid, using the side panel's 16px gutters. */
export function workspaceTabColumnCount(
  viewportWidthPx: number,
  horizontalPaddingPx = 32,
): number {
  const width = Number.isFinite(viewportWidthPx) && viewportWidthPx > 0
    ? viewportWidthPx
    : 0;
  const padding = Number.isFinite(horizontalPaddingPx) && horizontalPaddingPx > 0
    ? horizontalPaddingPx
    : 0;
  const available = Math.max(0, width - padding);
  return Math.max(1, Math.min(
    WORKSPACE_ROUTES.length,
    Math.floor((available + WORKSPACE_TAB_GAP_PX) /
      (WORKSPACE_TAB_MIN_TRACK_PX + WORKSPACE_TAB_GAP_PX)),
  ));
}

/** Returns the route a horizontal ARIA tablist should focus and activate. */
export function workspaceRouteForKey(
  current: WorkspaceRoute,
  key: string,
): WorkspaceRoute | null {
  const index = WORKSPACE_ROUTES.indexOf(current);
  if (key === "Home") return WORKSPACE_ROUTES[0];
  if (key === "End") return WORKSPACE_ROUTES[WORKSPACE_ROUTES.length - 1];
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const delta = key === "ArrowRight" ? 1 : -1;
  return WORKSPACE_ROUTES[
    (index + delta + WORKSPACE_ROUTES.length) % WORKSPACE_ROUTES.length
  ];
}

export function binaryTabForKey<T extends string>(
  current: T,
  key: string,
  first: T,
  second: T,
): T | null {
  if (key === "Home") return first;
  if (key === "End") return second;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    return current === first ? second : first;
  }
  return null;
}

export type HutchSourcePageGroup = {
  key: string;
  pageUrl: string | null;
  pageTitle?: string;
  pageHost: string;
  itemIds: string[];
};

function canonicalHttpPageUrl(rawUrl?: string): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function pageHost(pageUrl: string | null): string {
  if (pageUrl === null) return "Unassigned source";
  try {
    return new URL(pageUrl).hostname;
  } catch {
    return pageUrl;
  }
}

/** Customer-safe source identity: credentials, query values, and fragments never render. */
export function sourcePageDisplayUrl(pageUrl: string | null, maxLength = 180): string {
  if (pageUrl === null) return "No supported source page was recorded";
  try {
    const url = new URL(pageUrl);
    const value = `${url.hostname}${url.pathname}`;
    if (value.length <= maxLength) return value;
    return `${value.slice(0, Math.max(1, maxLength - 1))}…`;
  } catch {
    return "Source page unavailable";
  }
}

/**
 * Keeps signed URLs out of hover/accessibility text unless the customer has
 * deliberately enabled the existing full-URL setting.
 */
export function customerVisibleUrlTitle(
  rawUrl: string | null,
  showFullUrls: boolean,
): string | undefined {
  if (rawUrl === null) return undefined;
  return showFullUrls ? rawUrl : sourcePageDisplayUrl(rawUrl);
}

/** Groups the background-owned draft in its stable item order without reading remote URLs. */
export function groupCaptureDraftBySourcePage(
  draft: CaptureDraftV1 | null,
): HutchSourcePageGroup[] {
  if (!draft) return [];
  const groups = new Map<string, HutchSourcePageGroup>();
  for (const itemId of draft.orderedItemIds) {
    const item: CaptureDraftItemV1 | undefined = draft.items[itemId];
    if (!item) continue;
    const pageUrl = canonicalHttpPageUrl(item.media.pageUrl);
    const key = pageUrl ?? "__unassigned__";
    const group = groups.get(key);
    if (group) {
      group.itemIds.push(itemId);
      if (!group.pageTitle && item.media.pageTitle) group.pageTitle = item.media.pageTitle;
      continue;
    }
    groups.set(key, {
      key,
      pageUrl,
      ...(item.media.pageTitle ? { pageTitle: item.media.pageTitle } : {}),
      pageHost: pageHost(pageUrl),
      itemIds: [itemId],
    });
  }
  return [...groups.values()];
}

/** Rejects late async media loads after the panel has followed another tab. */
export function activeTabLoadIsCurrent(input: {
  currentGeneration: number;
  loadGeneration: number;
  currentTabId: number | null;
  loadTabId: number;
}): boolean {
  return input.currentGeneration === input.loadGeneration &&
    input.currentTabId === input.loadTabId;
}

/**
 * Keeps keyboard focus near a Hutch row that is about to disappear. Prefer the
 * following item so repeated Remove presses move forward; fall back to the
 * previous item, then the Hutch heading when the pack becomes empty.
 */
export function hutchFocusItemAfterRemoval(
  orderedItemIds: readonly string[],
  removedItemId: string,
): string | null {
  const index = orderedItemIds.indexOf(removedItemId);
  if (index < 0) return null;
  return orderedItemIds[index + 1] ?? orderedItemIds[index - 1] ?? null;
}
