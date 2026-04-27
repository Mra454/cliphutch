export type VideoKind = "direct" | "hls" | "dash";

export type DetectedVideo = {
  id: string;
  url: string;
  kind: VideoKind;
  detectedAt: number;
  pageUrl?: string;
  pageTitle?: string;
  sizeBytes?: number;
  contentType?: string;
  contentDisposition?: string;
};

export type StreamJobStatus = "running" | "saving" | "complete" | "error" | "cancelled";
export type StreamSaveStatus = "pending" | "complete" | "interrupted";

export type DirectJob = {
  videoId: string;
  tabId: number;
  downloadId: number;
  kind: VideoKind;
  startedAt: number;
  status: "in_progress" | "complete" | "interrupted";
  errorMessage?: string;
};

export type HlsJob = {
  jobId: string;
  videoId: string;
  tabId: number;
  url: string;
  kind: "hls";
  startedAt: number;
  status: StreamJobStatus;
  progress: { done: number; total: number; bytes: number };
  downloadId?: number;
  errorCode?: string;
  errorMessage?: string;
};

export type DashJob = {
  jobId: string;
  videoId: string;
  tabId: number;
  url: string;
  kind: "dash";
  startedAt: number;
  status: StreamJobStatus;
  progress: { videoDone: number; videoTotal: number; audioDone: number; audioTotal: number; bytes: number };
  videoDownloadId?: number;
  audioDownloadId?: number;
  videoSaveStatus?: StreamSaveStatus;
  audioSaveStatus?: StreamSaveStatus;
  errorCode?: string;
  errorMessage?: string;
};
