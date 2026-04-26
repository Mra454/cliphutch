export const DIRECT_VIDEO_EXTENSIONS = [
  ".mp4",
  ".webm",
  ".mov",
  ".m4v",
  ".mkv",
  ".ogv",
] as const;

export const PLAYLIST_EXTENSIONS = [".m3u8", ".mpd"] as const;

export const SEGMENT_EXTENSIONS = [".ts", ".m4s", ".cmfv", ".cmfa"] as const;

export const MAX_VIDEOS_PER_TAB = 50;
export const MAX_URL_DISPLAY_LENGTH = 120;

export const DEFAULT_HLS_SIZE_CAP_BYTES = 512 * 1024 * 1024;
export const HARD_HLS_SIZE_CAP_BYTES = 1024 * 1024 * 1024;

export const MAX_CONCURRENT_HLS_JOBS = 1;
export const HLS_SEGMENT_FETCH_CONCURRENCY = 4;

export const VIDEO_REQUEST_TYPES: chrome.webRequest.ResourceType[] = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "media",
  "other",
];
