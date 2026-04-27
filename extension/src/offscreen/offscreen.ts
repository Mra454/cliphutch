import { downloadHls, type HlsProgress } from "../workers/hls-downloader";
import { HlsDownloadError } from "../lib/errors";
import { MAX_CONCURRENT_HLS_JOBS } from "../lib/constants";

console.log("[cliphutch] offscreen document loaded");

type ActiveJob = {
  jobId: string;
  controller: AbortController;
  blobUrl?: string;
};

const activeJobs = new Map<string, ActiveJob>();

type StartMessage = {
  type: "hls-download-start";
  jobId: string;
  url: string;
  sizeCapBytes: number;
};

type CancelMessage = {
  type: "hls-download-cancel";
  jobId: string;
};

type RevokeMessage = {
  type: "hls-download-revoke";
  jobId: string;
};

type IncomingMessage = StartMessage | CancelMessage | RevokeMessage;

function send(msg: object): void {
  void chrome.runtime.sendMessage(msg).catch(() => {
    // background may be temporarily down; retry not required for v1
  });
}

async function runJob(msg: StartMessage): Promise<void> {
  if (activeJobs.size >= MAX_CONCURRENT_HLS_JOBS) {
    send({
      type: "hls-download-error",
      jobId: msg.jobId,
      code: "CONCURRENT_LIMIT",
      userMessage: "Another HLS download is already running. Wait for it to finish.",
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

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const m = message as IncomingMessage;

  if (m.type === "hls-download-start") {
    void runJob(m);
    sendResponse({ ok: true });
    return false;
  }

  if (m.type === "hls-download-cancel") {
    const job = activeJobs.get(m.jobId);
    if (job) {
      job.controller.abort();
      if (job.blobUrl) {
        URL.revokeObjectURL(job.blobUrl);
      }
      activeJobs.delete(m.jobId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (m.type === "hls-download-revoke") {
    const job = activeJobs.get(m.jobId);
    if (job?.blobUrl) {
      URL.revokeObjectURL(job.blobUrl);
    }
    activeJobs.delete(m.jobId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
