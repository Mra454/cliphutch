import type { DetectedVideo } from "../types";
import { createMediaSnapshotFromDetected } from "./capture-media-snapshot";
import { buildRelativeDownloadPath } from "./download-path";
import { inferFilename } from "./filename";
import { isWebmDirectVideo } from "./media-format";
import { generateCaptureReviewPlan } from "./capture-plan";
import {
  CAPTURE_PACK_SCHEMA_VERSION,
  isCaptureReviewPlanV1,
  isQualityChoiceV1,
  type CaptureDraftV1,
  type CaptureReviewPlanV1,
  type QualityChoiceV1,
} from "./capture-pack-types";
import type { FilenameTemplate } from "./storage-local";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CreateSingleCapturePlanInput = {
  commandId: string;
  tabId: number;
  media: DetectedVideo;
  generatedAt: number;
  filenameTemplate: FilenameTemplate;
  qualityChoice?: QualityChoiceV1;
  customStem?: string;
};

export type CreateSingleCapturePlanResult =
  | {
      ok: true;
      plan: CaptureReviewPlanV1;
      commandUuid: string;
      itemId: string;
    }
  | {
      ok: false;
      reason: "invalid_input" | "invalid_media" | "invalid_quality" | "plan_generation_failed";
    };

function commandUuid(commandId: string): string | undefined {
  if (!commandId.startsWith("download-")) return undefined;
  const uuid = commandId.slice("download-".length);
  return UUID_PATTERN.test(uuid) ? uuid.toLowerCase() : undefined;
}

function isFilenameTemplate(value: unknown): value is FilenameTemplate {
  return value === "auto" || value === "pageTitle" ||
    value === "urlBasename" || value === "timestamp";
}

function pageHost(media: DetectedVideo): string | undefined {
  try {
    return new URL(media.pageUrl ?? media.url).hostname.replace(/^www\./i, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds the immutable one-item plan used by the toolbar's fast Download
 * action. It deliberately does not mutate the customer's session Hutch.
 */
export function createSingleCapturePlan(
  input: CreateSingleCapturePlanInput,
): CreateSingleCapturePlanResult {
  try {
    const uuid = commandUuid(input.commandId);
    if (
      !uuid || !Number.isSafeInteger(input.tabId) || input.tabId < 0 ||
      !Number.isSafeInteger(input.generatedAt) || input.generatedAt < 0 ||
      !isFilenameTemplate(input.filenameTemplate)
    ) {
      return { ok: false, reason: "invalid_input" };
    }
    if (input.qualityChoice !== undefined && !isQualityChoiceV1(input.qualityChoice)) {
      return { ok: false, reason: "invalid_quality" };
    }
    const media = createMediaSnapshotFromDetected(input.media);
    const itemId = `capture-single-item:${uuid}`;
    const draft: CaptureDraftV1 = {
      schemaVersion: CAPTURE_PACK_SCHEMA_VERSION,
      draftId: `capture-single-draft:${uuid}`,
      revision: 1,
      name: "Quick Capture",
      createdAt: input.generatedAt,
      updatedAt: input.generatedAt,
      orderedItemIds: [itemId],
      items: {
        [itemId]: {
          itemId,
          addedAt: input.generatedAt,
          sourceTabId: input.tabId,
          media,
          ...(input.customStem === undefined ? {} : { customStem: input.customStem }),
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
      planId: `capture-single-plan:${uuid}`,
      generatedAt: input.generatedAt,
      choices: [{
        itemId,
        include: true,
        ...(input.qualityChoice === undefined ? {} : { qualityChoice: input.qualityChoice }),
      }],
    });
    if (!generated.ok || !isCaptureReviewPlanV1(generated.plan)) {
      return { ok: false, reason: "plan_generation_failed" };
    }
    const [item] = generated.plan.items;
    if (!item || item.readiness !== "ready") {
      return {
        ok: false,
        reason: media.kind === "hls" || media.kind === "dash"
          ? "invalid_quality"
          : "plan_generation_failed",
      };
    }
    const forcedExtension = media.kind === "hls" || media.kind === "dash" ||
      isWebmDirectVideo(input.media)
      ? ".mp4"
      : undefined;
    const filename = inferFilename(input.media, {
      template: input.filenameTemplate,
      ...(input.customStem === undefined ? {} : { customStem: input.customStem }),
      ...(forcedExtension === undefined ? {} : { forcedExtension }),
      ...(input.qualityChoice?.mode === "stream" && input.qualityChoice.label
        ? { variantLabel: input.qualityChoice.label }
        : {}),
    });
    const plan: CaptureReviewPlanV1 = {
      ...generated.plan,
      items: [{
        ...item,
        plannedRelativePath: buildRelativeDownloadPath({
          packName: "Quick Capture",
          pageHost: pageHost(input.media),
          pageTitle: input.media.pageTitle,
          filename,
        }),
      }],
    };
    if (!isCaptureReviewPlanV1(plan)) {
      return { ok: false, reason: "plan_generation_failed" };
    }
    return { ok: true, plan, commandUuid: uuid, itemId };
  } catch {
    return { ok: false, reason: "invalid_media" };
  }
}
