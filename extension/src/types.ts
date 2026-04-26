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
