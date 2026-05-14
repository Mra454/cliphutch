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
export const MIN_STILL_IMAGE_SIZE_BYTES = 100 * 1024;

export const DEFAULT_HLS_SIZE_CAP_BYTES = 512 * 1024 * 1024;
export const HARD_HLS_SIZE_CAP_BYTES = 1024 * 1024 * 1024;
export const WEBM_TRANSCODE_SIZE_CAP_BYTES = 128 * 1024 * 1024;

export const MAX_CONCURRENT_HLS_JOBS = 1;
export const HLS_SEGMENT_FETCH_CONCURRENCY = 4;

export const VIDEO_REQUEST_TYPES: chrome.webRequest.ResourceType[] = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "image",
  "media",
  "other",
];

export const PRICE_USD = 35;
export const CHECKOUT_URL = "https://buy.stripe.com/8x29ATcsIdsW3V31wUfw400";
export const VALIDATE_URL = "https://cliphutch-api.mra454.workers.dev/validate";

// Re-validate the cached license at most once per this interval.
export const REVALIDATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
