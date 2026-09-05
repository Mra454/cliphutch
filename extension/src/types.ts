export type VideoKind = "direct" | "hls" | "dash";
export type MediaKind = VideoKind | "image";

export type MediaProvenance =
  | "network"
  | "rendered-image"
  | "picture"
  | "metadata"
  | "poster";

export type DetectedVideo = {
  id: string;
  url: string;
  kind: MediaKind;
  detectedAt: number;
  // Optional for session records written before metadata preservation landed.
  firstSeenAt?: number;
  lastSeenAt?: number;
  pageUrl?: string;
  pageTitle?: string;
  sizeBytes?: number;
  contentType?: string;
  contentDisposition?: string;
  width?: number;
  height?: number;
  provenance?: MediaProvenance[];
  /**
   * The background captured replayable request headers for this exact shelf
   * record. Capture-Pack Add must either freeze them into a bounded lease or
   * fail visibly; absence from the ordinary header registry is not permission
   * to silently downgrade this record to a public source.
   */
  hasCapturedReplayHeaders?: boolean;
  /**
   * Query-redacted HLS child playlist URLs discovered from a parsed master.
   * This is shelf presentation metadata only; execution revalidates manifests.
   */
  childUrls?: string[];
  // Only set for an authoritative family (for example, one img/srcset tree).
  // Filename, title, and CDN-directory similarities are not family evidence.
  familyId?: string;
};

export type StreamJobStatus =
  | "running"
  | "delivery_pending"
  | "saving"
  | "complete"
  | "error"
  | "cancelled";
export type StreamSaveStatus = "pending" | "complete" | "interrupted";

export type DirectJob = {
  // Stable identifier for the explicit popup intent that created this job.
  // Optional for backward compatibility with existing session records.
  commandId?: string;
  videoId: string;
  tabId: number;
  downloadId: number;
  kind: MediaKind;
  startedAt: number;
  status: "in_progress" | "complete" | "interrupted";
  // Reserved when a free-tier video download starts. Released if the download
  // fails before completion.
  quotaReservationId?: string;
  countsAgainstQuota?: boolean;
  quotaRecorded?: boolean;
  errorMessage?: string;
};

export type HlsJob = {
  // Optional so jobs written by older extension builds remain readable.
  commandId?: string;
  jobId: string;
  videoId: string;
  tabId: number;
  url: string;
  kind: "hls";
  startedAt: number;
  status: StreamJobStatus;
  progress: { done: number; total: number; bytes: number };
  downloadId?: number;
  containerExt?: ".mp4" | ".ts";
  // Resolution/quality label for the picked variant (e.g. "1080p"), used to
  // qualify the saved filename.
  variantLabel?: string;
  // Frozen before execution so delivery does not depend on the source tab's
  // transient media shelf still existing after navigation or tab closure.
  plannedFilename?: string;
  // Reserved when a free-tier video download starts. Released if the download
  // fails before completion.
  quotaReservationId?: string;
  countsAgainstQuota?: boolean;
  // Set once the free-tier quota has been charged or reserved.
  quotaRecorded?: boolean;
  errorCode?: string;
  errorMessage?: string;
};

export type DashJob = {
  // Optional so jobs written by older extension builds remain readable.
  commandId?: string;
  jobId: string;
  videoId: string;
  tabId: number;
  url: string;
  kind: "dash";
  startedAt: number;
  status: StreamJobStatus;
  // done/total are combined video + audio segment counts. The downloader
  // fetches them separately but we mux into one file before saving, so the
  // popup UI doesn't need the breakdown.
  progress: { done: number; total: number; bytes: number };
  downloadId?: number;
  // Resolution/quality label for the picked variant (e.g. "1080p"), used to
  // qualify the saved filename.
  variantLabel?: string;
  // Optional for backward compatibility with jobs created before snapshots.
  plannedFilename?: string;
  // Reserved when a free-tier video download starts. Released if the download
  // fails before completion.
  quotaReservationId?: string;
  countsAgainstQuota?: boolean;
  // Set once the free-tier quota has been charged or reserved.
  quotaRecorded?: boolean;
  errorCode?: string;
  errorMessage?: string;
};

export type WebmTranscodeJob = {
  // Optional so jobs written by older extension builds remain readable.
  commandId?: string;
  jobId: string;
  videoId: string;
  tabId: number;
  url: string;
  kind: "direct";
  startedAt: number;
  status: StreamJobStatus;
  progress: { ratio: number; message?: string };
  downloadId?: number;
  // Frozen MP4 filename used after the tab shelf has been cleared.
  plannedFilename?: string;
  // Reserved when a free-tier video download starts. Released if the download
  // fails before completion.
  quotaReservationId?: string;
  countsAgainstQuota?: boolean;
  // Set once the free-tier quota has been charged or reserved.
  quotaRecorded?: boolean;
  errorCode?: string;
  errorMessage?: string;
};
