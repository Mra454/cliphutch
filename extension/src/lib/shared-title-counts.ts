import type { DetectedVideo } from "../types";
import { cleanTitle } from "./filename";
import { partitionCoveredByManifests } from "./manifest-coverage";
import { groupMedia } from "./media-identity";
import { isStillImage } from "./media-format";

function titleKey(title?: string): string | undefined {
  const cleaned = cleanTitle(title);
  const key = cleaned?.trim().toLocaleLowerCase("en-US");
  return key || undefined;
}

export function sharedCleanTitleCountsByMediaId(
  media: readonly DetectedVideo[],
): Map<string, number> {
  const visibleVideos = partitionCoveredByManifests(media).visible.filter((item) => !isStillImage(item));
  const groups = groupMedia(visibleVideos);
  const titleGroups = new Map<string, Set<string>>();

  for (const group of groups) {
    const key = titleKey(group.primary.pageTitle);
    if (!key) continue;
    const groupIds = titleGroups.get(key) ?? new Set<string>();
    groupIds.add(group.groupId);
    titleGroups.set(key, groupIds);
  }

  const countsByMediaId = new Map<string, number>();
  for (const group of groups) {
    const key = titleKey(group.primary.pageTitle);
    const count = key ? titleGroups.get(key)?.size ?? 1 : 1;
    for (const member of group.members) countsByMediaId.set(member.id, count);
  }
  return countsByMediaId;
}
