import { downloadHls, type HlsProgress } from "../workers/hls-downloader";
import { downloadDash, type DashProgress } from "../workers/dash-downloader";
import { HlsDownloadError } from "../lib/errors";
import { MAX_CONCURRENT_HLS_JOBS } from "../lib/constants";
import { isMasterPlaylist, parseMasterVariants } from "../lib/hls-variants";
import { parseMpd } from "../lib/dash";
import { terminateWebmTranscoder, transcodeWebmToMp4 } from "../workers/webm-transcoder";

console.log("[cliphutch] offscreen document loaded");

type ActiveJob = {
  jobId: string;
  controller: AbortController;
  blobUrl?: string;
};

const activeJobs = new Map<string, ActiveJob>();

type HlsStartMessage = {
  type: "hls-download-start";
  jobId: string;
  url: string;
  sizeCapBytes: number;
  variantUrl?: string;
  audioUrl?: string;
};

type HlsCancelMessage = {
  type: "hls-download-cancel";
  jobId: string;
};

type HlsRevokeMessage = {
  type: "hls-download-revoke";
  jobId: string;
};

type DashStartMessage = {
  type: "dash-download-start";
  jobId: string;
  url: string;
  sizeCapBytes: number;
  videoRepresentationId?: string;
};

type DashCancelMessage = {
  type: "dash-download-cancel";
  jobId: string;
};

type DashRevokeMessage = {
  type: "dash-download-revoke";
  jobId: string;
};

type ListVariantsMessage = {
  type: "list-variants-start";
  url: string;
  kind: "hls" | "dash";
};

type WebmTranscodeStartMessage = {
  type: "webm-transcode-start";
  jobId: string;
  url: string;
  sizeCapBytes: number;
};

type WebmTranscodeCancelMessage = {
  type: "webm-transcode-cancel";
  jobId: string;
};

type WebmTranscodeRevokeMessage = {
  type: "webm-transcode-revoke";
  jobId: string;
};

type IncomingMessage =
  | HlsStartMessage
  | HlsCancelMessage
  | HlsRevokeMessage
  | DashStartMessage
  | DashCancelMessage
  | DashRevokeMessage
  | ListVariantsMessage
  | WebmTranscodeStartMessage
  | WebmTranscodeCancelMessage
  | WebmTranscodeRevokeMessage;

export type VariantOption = {
  id: string; // HLS: resolved URL of variant playlist; DASH: Representation @id
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  // HLS only: resolved URL of the matching audio rendition when the variant
  // references a separate AUDIO group. Carried through to the download
  // request so downloadHls can fetch + mux both streams.
  audioRenditionUrl?: string;
};

export type ListVariantsResult =
  | {
      ok: true;
      kind: "hls" | "dash";
      variants: VariantOption[];
      durationSec?: number;
    }
  | { ok: false; error: string };

function send(msg: object): void {
  void chrome.runtime.sendMessage(msg).catch(() => {
    // background may be temporarily down; retry not required for v1
  });
}

async function runHlsJob(msg: HlsStartMessage): Promise<void> {
  if (activeJobs.size >= MAX_CONCURRENT_HLS_JOBS) {
    send({
      type: "hls-download-error",
      jobId: msg.jobId,
      code: "CONCURRENT_LIMIT",
      userMessage: "Another download is already running. Wait for it to finish.",
    });
    return;
  }

  const controller = new AbortController();
  const job: ActiveJob = { jobId: msg.jobId, controller };
  activeJobs.set(msg.jobId, job);

  try {
    const blob = await downloadHls(msg.url, {
      sizeCapBytes: msg.sizeCapBytes,
      signal: controller.signal,
      variantUrl: msg.variantUrl,
      audioUrl: msg.audioUrl,
      onProgress: (p: HlsProgress) => {
        send({
          type: "hls-download-progress",
          jobId: msg.jobId,
          done: p.done,
          total: p.total,
          bytes: p.bytes,
        });
      },
    });

    const blobUrl = URL.createObjectURL(blob);
    job.blobUrl = blobUrl;

    send({
      type: "hls-download-blob-ready",
      jobId: msg.jobId,
      blobUrl,
      sizeBytes: blob.size,
      containerExt: blob.type === "video/mp4" ? ".mp4" : ".ts",
    });
  } catch (err) {
    if (err instanceof HlsDownloadError) {
      send({
        type: "hls-download-error",
        jobId: msg.jobId,
        code: err.code,
        userMessage: err.userMessage,
      });
    } else {
      send({
        type: "hls-download-error",
        jobId: msg.jobId,
        code: "UNKNOWN",
        userMessage: err instanceof Error ? err.message : "Unknown error",
      });
    }
    controller.abort();
    activeJobs.delete(msg.jobId);
  }
}

async function runDashJob(msg: DashStartMessage): Promise<void> {
  if (activeJobs.size >= MAX_CONCURRENT_HLS_JOBS) {
    send({
      type: "dash-download-error",
      jobId: msg.jobId,
      code: "CONCURRENT_LIMIT",
      userMessage: "Another download is already running. Wait for it to finish.",
    });
    return;
  }

  const controller = new AbortController();
  const job: ActiveJob = { jobId: msg.jobId, controller };
  activeJobs.set(msg.jobId, job);

  try {
    const blob = await downloadDash(msg.url, {
      sizeCapBytes: msg.sizeCapBytes,
      signal: controller.signal,
      videoRepresentationId: msg.videoRepresentationId,
      onProgress: (p: DashProgress) => {
        send({
          type: "dash-download-progress",
          jobId: msg.jobId,
          done: p.videoDone + p.audioDone,
          total: p.videoTotal + p.audioTotal,
          bytes: p.bytes,
        });
      },
    });

    const blobUrl = URL.createObjectURL(blob);
    job.blobUrl = blobUrl;

    send({
      type: "dash-download-blob-ready",
      jobId: msg.jobId,
      blobUrl,
      sizeBytes: blob.size,
    });
  } catch (err) {
    if (err instanceof HlsDownloadError) {
      send({
        type: "dash-download-error",
        jobId: msg.jobId,
        code: err.code,
        userMessage: err.userMessage,
      });
    } else {
      send({
        type: "dash-download-error",
        jobId: msg.jobId,
        code: "UNKNOWN",
        userMessage: err instanceof Error ? err.message : "Unknown error",
      });
    }
    controller.abort();
    activeJobs.delete(msg.jobId);
  }
}

async function runWebmTranscodeJob(msg: WebmTranscodeStartMessage): Promise<void> {
  if (activeJobs.size >= MAX_CONCURRENT_HLS_JOBS) {
    send({
      type: "webm-transcode-error",
      jobId: msg.jobId,
      code: "CONCURRENT_LIMIT",
      userMessage: "Another download is already running. Wait for it to finish.",
    });
    return;
  }

  const controller = new AbortController();
  const job: ActiveJob = { jobId: msg.jobId, controller };
  activeJobs.set(msg.jobId, job);

  try {
    const blob = await transcodeWebmToMp4(msg.url, {
      sizeCapBytes: msg.sizeCapBytes,
      signal: controller.signal,
      onProgress: (ratio, message) => {
        send({
          type: "webm-transcode-progress",
          jobId: msg.jobId,
          ratio,
          message,
        });
      },
    });

    const blobUrl = URL.createObjectURL(blob);
    job.blobUrl = blobUrl;

    send({
      type: "webm-transcode-blob-ready",
      jobId: msg.jobId,
      blobUrl,
      sizeBytes: blob.size,
    });
  } catch (err) {
    if (err instanceof HlsDownloadError) {
      send({
        type: "webm-transcode-error",
        jobId: msg.jobId,
        code: err.code,
        userMessage: err.userMessage,
      });
    } else {
      send({
        type: "webm-transcode-error",
        jobId: msg.jobId,
        code: "TRANSCODE_FAILED",
        userMessage: err instanceof Error ? err.message : "WebM transcode failed.",
      });
    }
    controller.abort();
    activeJobs.delete(msg.jobId);
  }
}

function revokeJobBlobs(job: ActiveJob): void {
  if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
}

async function listVariants(msg: ListVariantsMessage): Promise<ListVariantsResult> {
  try {
    const res = await fetch(msg.url, { credentials: "include" });
    if (!res.ok) return { ok: false, error: `Manifest ${res.status}` };
    const text = await res.text();

    if (msg.kind === "hls") {
      if (!isMasterPlaylist(text)) {
        // Variant playlist (no STREAM-INF). One implicit variant — the URL itself.
        return { ok: true, kind: "hls", variants: [{ id: msg.url, bandwidth: 0 }] };
      }
      const parsed = parseMasterVariants(text);
      const variants: VariantOption[] = parsed.map((v) => ({
        id: new URL(v.uri, msg.url).href,
        bandwidth: v.bandwidth,
        width: v.width,
        height: v.height,
        codecs: v.codecs,
        audioRenditionUrl: v.audioRenditionUri
          ? new URL(v.audioRenditionUri, msg.url).href
          : undefined,
      }));
      return { ok: true, kind: "hls", variants };
    }

    const manifest = parseMpd(text, msg.url);
    if (manifest.drm.protected) return { ok: false, error: `DRM-protected (${manifest.drm.scheme ?? "unknown"})` };
    if (manifest.type === "dynamic") return { ok: false, error: "Live stream" };
    const variants: VariantOption[] = manifest.video.map((r) => ({
      id: r.id,
      bandwidth: r.bandwidth,
      width: r.width,
      height: r.height,
      codecs: r.codecs,
    }));
    return { ok: true, kind: "dash", variants, durationSec: manifest.durationSec };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Manifest fetch failed" };
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const m = message as IncomingMessage;

  if (m.type === "hls-download-start") {
    void runHlsJob(m);
    sendResponse({ ok: true });
    return false;
  }

  if (m.type === "dash-download-start") {
    void runDashJob(m);
    sendResponse({ ok: true });
    return false;
  }

  if (m.type === "webm-transcode-start") {
    void runWebmTranscodeJob(m);
    sendResponse({ ok: true });
    return false;
  }

  if (
    m.type === "hls-download-cancel" ||
    m.type === "dash-download-cancel" ||
    m.type === "webm-transcode-cancel"
  ) {
    const job = activeJobs.get(m.jobId);
    if (job) {
      job.controller.abort();
      if (m.type === "webm-transcode-cancel") terminateWebmTranscoder();
      revokeJobBlobs(job);
      activeJobs.delete(m.jobId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (
    m.type === "hls-download-revoke" ||
    m.type === "dash-download-revoke" ||
    m.type === "webm-transcode-revoke"
  ) {
    const job = activeJobs.get(m.jobId);
    if (job) {
      revokeJobBlobs(job);
      activeJobs.delete(m.jobId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (m.type === "list-variants-start") {
    void listVariants(m).then(sendResponse);
    return true;
  }

  return false;
});
