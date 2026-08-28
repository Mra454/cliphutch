import { downloadHls, type HlsProgress } from "../workers/hls-downloader";
import { downloadDash, type DashProgress } from "../workers/dash-downloader";
import { HlsDownloadError } from "../lib/errors";
import { MAX_CONCURRENT_HLS_JOBS } from "../lib/constants";
import { isMasterPlaylist, parseMasterVariants } from "../lib/hls-variants";
import { parseMpd } from "../lib/dash";
import { terminateWebmTranscoder, transcodeWebmToMp4 } from "../workers/webm-transcoder";
import {
  OffscreenAttemptRegistry,
  parseOffscreenIncomingMessage,
  type AttemptIdentity,
  type CaptureVariantInspectMessageV1,
  type DashStartMessage,
  type HeavyControlMessage,
  type HeavyJobKind,
  type HeavyStartMessage,
  type HlsStartMessage,
  type ListVariantsMessage,
  type WebmStartMessage,
} from "../lib/offscreen-attempts";
import { StreamVariantFetchRuntimeV1 } from "../lib/stream-variant-fetch";
import {
  readResponseTextBounded,
  ResponseBodyTooLargeError,
} from "../lib/bounded-response-text";
import {
  CaptureManifestBlobRegistry,
  parseCaptureManifestBlobMessage,
} from "../lib/capture-manifest-blob";

console.log("[cliphutch] offscreen document loaded");

type AttemptResource = {
  kind: HeavyJobKind;
  controller: AbortController;
  authorizationTimer?: ReturnType<typeof setTimeout>;
};

const activeAttempts = new OffscreenAttemptRegistry<AttemptResource>(
  MAX_CONCURRENT_HLS_JOBS,
  256,
  32,
);
const captureManifestBlobs = new CaptureManifestBlobRegistry();
// One document-global instance owns the shared three-request HTTP lane and
// per-review aggregate inspection budgets.
const streamVariantFetchRuntime = new StreamVariantFetchRuntimeV1();
let captureManifestBlobExpiryTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleCaptureManifestBlobExpiry(): void {
  if (captureManifestBlobExpiryTimer !== undefined) {
    clearTimeout(captureManifestBlobExpiryTimer);
    captureManifestBlobExpiryTimer = undefined;
  }
  const expiresAt = captureManifestBlobs.nextExpiryAt();
  if (expiresAt === undefined) return;
  captureManifestBlobExpiryTimer = setTimeout(() => {
    captureManifestBlobExpiryTimer = undefined;
    captureManifestBlobs.sweepExpired();
    scheduleCaptureManifestBlobExpiry();
  }, Math.max(0, expiresAt - Date.now()));
}

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
  | { ok: false; error: string; code?: "TIMEOUT" | "MANIFEST_TOO_LARGE" | "FETCH_FAILED" };

const MANIFEST_PREFLIGHT_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_PREFLIGHT_BYTES = 2 * 1024 * 1024;

function send(msg: object): void {
  try {
    void chrome.runtime.sendMessage(msg).catch(() => {
      // Background may be temporarily down. Ownership remains queryable so
      // reconciliation can decide whether to revoke or resume the attempt.
    });
  } catch {
    // Context invalidation can throw synchronously while the document closes.
  }
}

function identityOf(message: AttemptIdentity): AttemptIdentity {
  return message.attemptId === undefined
    ? { jobId: message.jobId }
    : { jobId: message.jobId, attemptId: message.attemptId };
}

function sendForAttempt(identity: AttemptIdentity, message: Record<string, unknown>): void {
  send(
    identity.attemptId === undefined
      ? message
      : { ...message, attemptId: identity.attemptId },
  );
}

function messageForAttempt(
  identity: AttemptIdentity,
  message: Record<string, unknown>,
): Record<string, unknown> {
  return identity.attemptId === undefined
    ? message
    : { ...message, attemptId: identity.attemptId };
}

function retryDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function sendAttemptEventUntilAcknowledged(
  identity: AttemptIdentity,
  message: Record<string, unknown>,
): Promise<void> {
  if (identity.attemptId === undefined) {
    send(message);
    return;
  }
  let delayMs = 100;
  while (activeAttempts.owns(identity)) {
    try {
      const response = await chrome.runtime.sendMessage(
        messageForAttempt(identity, message),
      ) as { ok?: boolean; jobId?: string; attemptId?: string } | undefined;
      if (
        response?.ok === true &&
        response.jobId === identity.jobId &&
        response.attemptId === identity.attemptId
      ) {
        return;
      }
    } catch {
      // The service worker may be between lifetimes. The Blob and lane remain
      // owned here until a durable acknowledgement or an exact cancel/revoke.
    }
    await retryDelay(delayMs);
    delayMs = Math.min(delayMs * 2, 5_000);
  }
}

function kindOfStart(message: HeavyStartMessage): HeavyJobKind {
  if (message.type === "hls-download-start") return "hls";
  if (message.type === "dash-download-start") return "dash";
  return "webm";
}

function kindOfControl(message: HeavyControlMessage): HeavyJobKind {
  if (message.type.startsWith("hls-")) return "hls";
  if (message.type.startsWith("dash-")) return "dash";
  return "webm";
}

function authorizationExpired(message: HeavyStartMessage): boolean {
  return message.authorizationExpiresAt !== undefined &&
    Date.now() >= message.authorizationExpiresAt;
}

function releaseActiveAttempt(identity: AttemptIdentity) {
  const released = activeAttempts.release(identity);
  if (released?.resource.authorizationTimer !== undefined) {
    clearTimeout(released.resource.authorizationTimer);
  }
  return released;
}

function sendConcurrentError(message: HeavyStartMessage): void {
  const identity = identityOf(message);
  const kind = kindOfStart(message);
  sendForAttempt(identity, {
    type:
      kind === "hls"
        ? "hls-download-error"
        : kind === "dash"
          ? "dash-download-error"
          : "webm-transcode-error",
    jobId: message.jobId,
    code: "CONCURRENT_LIMIT",
    userMessage: "Another download is already running. Wait for it to finish.",
  });
}

async function runHlsJob(
  msg: HlsStartMessage,
  identity: AttemptIdentity,
  controller: AbortController,
  executionFetchImpl?: typeof fetch,
): Promise<void> {
  try {
    const blob = await downloadHls(msg.url, {
      sizeCapBytes: msg.sizeCapBytes,
      signal: controller.signal,
      variantUrl: msg.variantUrl,
      audioUrl: msg.audioUrl,
      exactVariantSelection: msg.exactVariantSelection,
      fetchImpl: executionFetchImpl,
      onProgress: (p: HlsProgress) => {
        if (!activeAttempts.owns(identity)) return;
        sendForAttempt(identity, {
          type: "hls-download-progress",
          jobId: msg.jobId,
          done: p.done,
          total: p.total,
          bytes: p.bytes,
        });
      },
    });

    const blobUrl = URL.createObjectURL(blob);
    if (!activeAttempts.attachBlob(identity, blobUrl)) {
      URL.revokeObjectURL(blobUrl);
      return;
    }

    await sendAttemptEventUntilAcknowledged(identity, {
      type: "hls-download-blob-ready",
      jobId: msg.jobId,
      blobUrl,
      sizeBytes: blob.size,
      containerExt: blob.type === "video/mp4" ? ".mp4" : ".ts",
    });
  } catch (err) {
    if (authorizationExpired(msg)) {
      await sendAttemptEventUntilAcknowledged(identity, {
        type: "hls-download-error",
        jobId: msg.jobId,
        code: "SOURCE_AUTH_EXPIRED",
        userMessage: "Source authorization expired. Reopen the source page and add this item again.",
      });
    } else if (err instanceof HlsDownloadError) {
      await sendAttemptEventUntilAcknowledged(identity, {
        type: "hls-download-error",
        jobId: msg.jobId,
        code: err.code,
        userMessage: err.userMessage,
      });
    } else {
      await sendAttemptEventUntilAcknowledged(identity, {
        type: "hls-download-error",
        jobId: msg.jobId,
        code: "UNKNOWN",
        userMessage: err instanceof Error ? err.message : "Unknown error",
      });
    }
    controller.abort();
    releaseActiveAttempt(identity);
  }
}

async function runDashJob(
  msg: DashStartMessage,
  identity: AttemptIdentity,
  controller: AbortController,
  executionFetchImpl?: typeof fetch,
): Promise<void> {
  try {
    const blob = await downloadDash(msg.url, {
      sizeCapBytes: msg.sizeCapBytes,
      signal: controller.signal,
      videoRepresentationId: msg.videoRepresentationId,
      fetchImpl: executionFetchImpl,
      onProgress: (p: DashProgress) => {
        if (!activeAttempts.owns(identity)) return;
        sendForAttempt(identity, {
          type: "dash-download-progress",
          jobId: msg.jobId,
          done: p.videoDone + p.audioDone,
          total: p.videoTotal + p.audioTotal,
          bytes: p.bytes,
        });
      },
    });

    const blobUrl = URL.createObjectURL(blob);
    if (!activeAttempts.attachBlob(identity, blobUrl)) {
      URL.revokeObjectURL(blobUrl);
      return;
    }

    await sendAttemptEventUntilAcknowledged(identity, {
      type: "dash-download-blob-ready",
      jobId: msg.jobId,
      blobUrl,
      sizeBytes: blob.size,
    });
  } catch (err) {
    if (authorizationExpired(msg)) {
      await sendAttemptEventUntilAcknowledged(identity, {
        type: "dash-download-error",
        jobId: msg.jobId,
        code: "SOURCE_AUTH_EXPIRED",
        userMessage: "Source authorization expired. Reopen the source page and add this item again.",
      });
    } else if (err instanceof HlsDownloadError) {
      await sendAttemptEventUntilAcknowledged(identity, {
        type: "dash-download-error",
        jobId: msg.jobId,
        code: err.code,
        userMessage: err.userMessage,
      });
    } else {
      await sendAttemptEventUntilAcknowledged(identity, {
        type: "dash-download-error",
        jobId: msg.jobId,
        code: "UNKNOWN",
        userMessage: err instanceof Error ? err.message : "Unknown error",
      });
    }
    controller.abort();
    releaseActiveAttempt(identity);
  }
}

async function runWebmTranscodeJob(
  msg: WebmStartMessage,
  identity: AttemptIdentity,
  controller: AbortController,
): Promise<void> {
  try {
    const blob = await transcodeWebmToMp4(msg.url, {
      sizeCapBytes: msg.sizeCapBytes,
      signal: controller.signal,
      onProgress: (ratio, message) => {
        if (!activeAttempts.owns(identity)) return;
        sendForAttempt(identity, {
          type: "webm-transcode-progress",
          jobId: msg.jobId,
          ratio,
          message,
        });
      },
    });

    const blobUrl = URL.createObjectURL(blob);
    if (!activeAttempts.attachBlob(identity, blobUrl)) {
      URL.revokeObjectURL(blobUrl);
      return;
    }

    await sendAttemptEventUntilAcknowledged(identity, {
      type: "webm-transcode-blob-ready",
      jobId: msg.jobId,
      blobUrl,
      sizeBytes: blob.size,
    });
  } catch (err) {
    if (authorizationExpired(msg)) {
      await sendAttemptEventUntilAcknowledged(identity, {
        type: "webm-transcode-error",
        jobId: msg.jobId,
        code: "SOURCE_AUTH_EXPIRED",
        userMessage: "Source authorization expired. Reopen the source page and add this item again.",
      });
    } else if (err instanceof HlsDownloadError) {
      await sendAttemptEventUntilAcknowledged(identity, {
        type: "webm-transcode-error",
        jobId: msg.jobId,
        code: err.code,
        userMessage: err.userMessage,
      });
    } else {
      await sendAttemptEventUntilAcknowledged(identity, {
        type: "webm-transcode-error",
        jobId: msg.jobId,
        code: "TRANSCODE_FAILED",
        userMessage: err instanceof Error ? err.message : "WebM transcode failed.",
      });
    }
    controller.abort();
    releaseActiveAttempt(identity);
  }
}

function revokeJobBlobs(job: { blobUrl?: string }): void {
  if (job.blobUrl) URL.revokeObjectURL(job.blobUrl);
}

async function listVariants(msg: ListVariantsMessage): Promise<ListVariantsResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, MANIFEST_PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await fetch(msg.url, { credentials: "include", signal: controller.signal });
    if (!res.ok) return { ok: false, error: `Manifest ${res.status}` };
    const text = await readResponseTextBounded(res, MAX_MANIFEST_PREFLIGHT_BYTES);

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
    if (timedOut) {
      return { ok: false, code: "TIMEOUT", error: "Manifest inspection timed out." };
    }
    if (err instanceof ResponseBodyTooLargeError) {
      return { ok: false, code: "MANIFEST_TOO_LARGE", error: "Manifest is larger than 2 MiB." };
    }
    return {
      ok: false,
      code: "FETCH_FAILED",
      error: err instanceof Error ? err.message : "Manifest fetch failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

function inspectCaptureVariants(
  message: CaptureVariantInspectMessageV1,
  sendResponse: (response?: unknown) => void,
): void {
  void streamVariantFetchRuntime.inspect(message).then(sendResponse);
}

function discardStartExecutionSnapshot(message: HeavyStartMessage): void {
  if (
    (message.type === "hls-download-start" || message.type === "dash-download-start") &&
    message.executionSnapshotId !== undefined
  ) {
    streamVariantFetchRuntime.discardExecutionSnapshot(message.executionSnapshotId);
  }
}

function handleHeavyStart(
  message: HeavyStartMessage,
  sendResponse: (response?: unknown) => void,
): void {
  const identity = identityOf(message);
  if (authorizationExpired(message)) {
    discardStartExecutionSnapshot(message);
    sendResponse({
      ok: false,
      code: "SOURCE_AUTH_EXPIRED",
      jobId: identity.jobId,
      ...(identity.attemptId === undefined ? {} : { attemptId: identity.attemptId }),
    });
    return;
  }
  const controller = new AbortController();
  const resource: AttemptResource = { kind: kindOfStart(message), controller };
  if (message.authorizationExpiresAt !== undefined) {
    resource.authorizationTimer = setTimeout(
      () => controller.abort(),
      Math.max(0, message.authorizationExpiresAt - Date.now()),
    );
  }
  const claim = activeAttempts.claim(identity, resource);
  if (!claim.ok) {
    // Includes a cancel/revoke tombstone that raced ahead of this start.
    discardStartExecutionSnapshot(message);
    if (resource.authorizationTimer !== undefined) clearTimeout(resource.authorizationTimer);
    if (claim.code === "CONCURRENT_LIMIT") sendConcurrentError(message);
    sendResponse({ ok: false, code: claim.code });
    return;
  }

  let executionFetchImpl: typeof fetch | undefined;
  if (
    (message.type === "hls-download-start" || message.type === "dash-download-start") &&
    message.executionSnapshotId !== undefined
  ) {
    const nativeFetch = fetch;
    const consumed = streamVariantFetchRuntime.consumeExecutionSnapshot(
      {
        executionSnapshotId: message.executionSnapshotId,
        kind: message.type === "hls-download-start" ? "hls" : "dash",
        url: message.url,
        ...(message.type === "dash-download-start" &&
            message.videoRepresentationId !== undefined
          ? { videoRepresentationId: message.videoRepresentationId }
          : {}),
      },
      nativeFetch,
    );
    if (!consumed.ok) {
      controller.abort();
      releaseActiveAttempt(identity);
      sendResponse({
        ok: false,
        code: "EXECUTION_SNAPSHOT_INVALID",
        jobId: identity.jobId,
        ...(identity.attemptId === undefined ? {} : { attemptId: identity.attemptId }),
      });
      return;
    }
    executionFetchImpl = consumed.fetchImpl;
  }

  sendResponse(
    identity.attemptId === undefined
      ? { ok: true, jobId: identity.jobId }
      : { ok: true, jobId: identity.jobId, attemptId: identity.attemptId },
  );

  if (message.type === "hls-download-start") {
    void runHlsJob(message, identity, controller, executionFetchImpl);
  } else if (message.type === "dash-download-start") {
    void runDashJob(message, identity, controller, executionFetchImpl);
  } else {
    void runWebmTranscodeJob(message, identity, controller);
  }
}

function handleHeavyControl(message: HeavyControlMessage): boolean {
  const identity = identityOf(message);
  const current = activeAttempts.get(identity);
  if (!current) {
    // Retire an exact cancel/revoke that raced ahead of its start so a delayed
    // delivery cannot begin work after the customer already cancelled it.
    releaseActiveAttempt(identity);
    return true;
  }
  if (current.resource.kind !== kindOfControl(message)) return false;
  const released = releaseActiveAttempt(identity);
  if (!released) return false;

  const mustStopWork = message.type.endsWith("-cancel") || released.blobUrl === undefined;
  if (mustStopWork) {
    released.resource.controller.abort();
    if (released.resource.kind === "webm") terminateWebmTranscoder();
  }
  revokeJobBlobs(released);
  return true;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Heavy execution is background-owned. Content scripts share the extension
  // ID but always carry a tab; accepting their messages here would let a page
  // consume the sole processor lane with arbitrary URLs.
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
  const manifestBlobMessage = parseCaptureManifestBlobMessage(message);
  if (manifestBlobMessage?.type === "capture-manifest-blob-create") {
    void captureManifestBlobs.create(manifestBlobMessage).then((response) => {
      scheduleCaptureManifestBlobExpiry();
      sendResponse(response);
    });
    return true;
  }
  if (manifestBlobMessage?.type === "capture-manifest-blob-revoke") {
    const response = captureManifestBlobs.revoke(manifestBlobMessage);
    scheduleCaptureManifestBlobExpiry();
    sendResponse(response);
    return false;
  }
  if (manifestBlobMessage?.type === "capture-manifest-blob-status") {
    const active = captureManifestBlobs.status();
    scheduleCaptureManifestBlobExpiry();
    sendResponse({ ok: true, active });
    return false;
  }

  const parsed = parseOffscreenIncomingMessage(message);
  if (!parsed) return false;

  if (parsed.type === "capture-execution-snapshot-discard") {
    sendResponse(
      streamVariantFetchRuntime.discardExecutionSnapshot(parsed.executionSnapshotId),
    );
    return false;
  }

  if (
    parsed.type === "hls-download-start" ||
    parsed.type === "dash-download-start" ||
    parsed.type === "webm-transcode-start"
  ) {
    handleHeavyStart(parsed, sendResponse);
    return false;
  }

  if (
    parsed.type === "hls-download-cancel" ||
    parsed.type === "hls-download-revoke" ||
    parsed.type === "dash-download-cancel" ||
    parsed.type === "dash-download-revoke" ||
    parsed.type === "webm-transcode-cancel" ||
    parsed.type === "webm-transcode-revoke"
  ) {
    const handled = handleHeavyControl(parsed);
    sendResponse({
      ok: handled,
      jobId: parsed.jobId,
      ...(parsed.attemptId === undefined ? {} : { attemptId: parsed.attemptId }),
    });
    return false;
  }

  if (parsed.type === "capture-executor-status") {
    sendResponse({ ok: true, active: activeAttempts.status() });
    return false;
  }

  if (parsed.type === "list-variants-start") {
    void listVariants(parsed).then(sendResponse);
    return true;
  }

  if (parsed.type === "capture-variant-inspect") {
    inspectCaptureVariants(parsed, sendResponse);
    return true;
  }

  return false;
});
