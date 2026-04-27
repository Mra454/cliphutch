import { downloadHls, type HlsProgress } from "../workers/hls-downloader";
import { downloadDash, type DashProgress } from "../workers/dash-downloader";
import { HlsDownloadError } from "../lib/errors";
import { MAX_CONCURRENT_HLS_JOBS } from "../lib/constants";

console.log("[cliphutch] offscreen document loaded");

type ActiveJob = {
  jobId: string;
  controller: AbortController;
  blobUrl?: string;
  videoBlobUrl?: string;
  audioBlobUrl?: string;
};

const activeJobs = new Map<string, ActiveJob>();

type HlsStartMessage = {
  type: "hls-download-start";
  jobId: string;
  url: string;
  sizeCapBytes: number;
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
};

type DashCancelMessage = {
  type: "dash-download-cancel";
  jobId: string;
};

type DashRevokeMessage = {
  type: "dash-download-revoke";
  jobId: string;
};

type IncomingMessage =
  | HlsStartMessage
  | HlsCancelMessage
  | HlsRevokeMessage
  | DashStartMessage
  | DashCancelMessage
  | DashRevokeMessage;

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
    const result = await downloadDash(msg.url, {
      sizeCapBytes: msg.sizeCapBytes,
      signal: controller.signal,
      onProgress: (p: DashProgress) => {
        send({
          type: "dash-download-progress",
          jobId: msg.jobId,
          videoDone: p.videoDone,
          videoTotal: p.videoTotal,
          audioDone: p.audioDone,
          audioTotal: p.audioTotal,
          bytes: p.bytes,
        });
      },
    });

    const videoBlobUrl = URL.createObjectURL(result.video);
    job.videoBlobUrl = videoBlobUrl;
    let audioBlobUrl: string | undefined;
    if (result.audio) {
      audioBlobUrl = URL.createObjectURL(result.audio);
      job.audioBlobUrl = audioBlobUrl;
    }

    send({
      type: "dash-download-blobs-ready",
      jobId: msg.jobId,
      videoBlobUrl,
      audioBlobUrl,
      videoSizeBytes: result.video.size,
      audioSizeBytes: result.audio?.size,
      videoMimeType: result.videoMimeType,
      audioMimeType: result.audioMimeType,
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
    activeJobs.delete(msg.jobId);
  }
}

function revokeJobBlobs(job: ActiveJob): void {
  if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
  if (job.videoBlobUrl) URL.revokeObjectURL(job.videoBlobUrl);
  if (job.audioBlobUrl) URL.revokeObjectURL(job.audioBlobUrl);
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

  if (m.type === "hls-download-cancel" || m.type === "dash-download-cancel") {
    const job = activeJobs.get(m.jobId);
    if (job) {
      job.controller.abort();
      revokeJobBlobs(job);
      activeJobs.delete(m.jobId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (m.type === "hls-download-revoke" || m.type === "dash-download-revoke") {
    const job = activeJobs.get(m.jobId);
    if (job) {
      revokeJobBlobs(job);
      activeJobs.delete(m.jobId);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
