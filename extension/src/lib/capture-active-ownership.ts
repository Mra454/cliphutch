import {
  isCaptureJobV1,
  isCaptureReviewPlanV1,
  isCaptureRunV1,
  isPersistentStreamQualityChoiceV1,
  type CaptureRunV1,
  type MediaSnapshotV1,
  type QualityChoiceV1,
} from "./capture-pack-types";

const ACTIVE_RUN_STATUSES = new Set<CaptureRunV1["status"]>(["queued", "running"]);

function isWebm(media: MediaSnapshotV1): boolean {
  if (media.kind !== "direct") return false;
  if (media.contentType?.split(";")[0].trim().toLowerCase() === "video/webm") return true;
  try {
    return new URL(media.url).pathname.toLowerCase().endsWith(".webm");
  } catch {
    return false;
  }
}

function expectedResourceClass(media: MediaSnapshotV1): "native" | "heavy" {
  return media.kind === "hls" || media.kind === "dash" || isWebm(media)
    ? "heavy"
    : "native";
}

function policiesExecuteSame(
  left: Extract<QualityChoiceV1, { mode: "stream" }>["policy"],
  right: Extract<QualityChoiceV1, { mode: "stream" }>["policy"],
): boolean {
  if (left.mode !== right.mode) return false;
  return left.mode === "manual" || (
    right.mode === "best_under_cap" &&
    left.maxEstimatedBytes === right.maxEstimatedBytes &&
    left.maxHeight === right.maxHeight
  );
}

function qualitiesExecuteSame(left: QualityChoiceV1, right: QualityChoiceV1): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "direct" || right.mode === "direct") return true;
  if (!policiesExecuteSame(left.policy, right.policy)) return false;
  const leftPersistent = isPersistentStreamQualityChoiceV1(left);
  const rightPersistent = isPersistentStreamQualityChoiceV1(right);
  if (leftPersistent || rightPersistent) {
    return leftPersistent && rightPersistent &&
      left.maxDownloadBytes === right.maxDownloadBytes &&
      left.selector.kind === right.selector.kind &&
      left.selector.stableId === right.selector.stableId;
  }
  if (left.variantKind !== right.variantKind) return false;
  if (left.variantKind === "hls" && right.variantKind === "hls") {
    return left.variantUrl === right.variantUrl;
  }
  if (left.variantKind === "dash" && right.variantKind === "dash") {
    return left.representationId === right.representationId;
  }
  if (left.variantKind === undefined && right.variantKind === undefined) {
    return left.fixedVariantId === right.fixedVariantId;
  }
  return false;
}

/**
 * One reviewed plan can own at most one active execution. A later explicit
 * Save again is allowed only after the earlier run becomes terminal.
 */
export function activeRunOwnsReviewPlan(
  runValue: unknown,
  planValue: unknown,
): boolean {
  if (!isCaptureRunV1(runValue) || !isCaptureReviewPlanV1(planValue)) return false;
  return ACTIVE_RUN_STATUSES.has(runValue.status) &&
    runValue.planId === planValue.planId &&
    runValue.draftId === planValue.draftId &&
    runValue.draftRevision === planValue.draftRevision;
}

/**
 * Quick Capture plans use command-derived IDs, so semantic ownership is the
 * immutable execution identity: stable shelf media, exact source URL/resource
 * class, executable quality selector/policy, lease context, and reviewed path.
 * Observation/display metadata (timestamps, title, dimensions, provenance,
 * verified byte size) intentionally does not create a second download.
 */
export function activeJobOwnsQuickPlan(
  jobValue: unknown,
  planValue: unknown,
  incomingHeaderLeaseId?: string,
): boolean {
  if (!isCaptureJobV1(jobValue) || !isCaptureReviewPlanV1(planValue)) return false;
  if (jobValue.state === "complete" || jobValue.state === "failed" ||
      jobValue.state === "cancelled" || jobValue.state === "save_state_unknown") {
    return false;
  }
  const included = planValue.items.filter((item) => item.include);
  if (included.length !== 1 || included[0].readiness !== "ready") return false;
  const item = included[0];
  return jobValue.snapshot.plannedRelativePath === item.plannedRelativePath &&
    jobValue.snapshot.media.mediaId === item.media.mediaId &&
    jobValue.snapshot.media.kind === item.media.kind &&
    jobValue.snapshot.media.url === item.media.url &&
    jobValue.resourceClass === expectedResourceClass(item.media) &&
    jobValue.snapshot.headerLeaseId === incomingHeaderLeaseId &&
    qualitiesExecuteSame(jobValue.snapshot.quality, item.qualityChoice);
}
