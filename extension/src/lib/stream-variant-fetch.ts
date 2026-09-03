import { Parser } from "m3u8-parser";
import { DashParseError, parseMpd, pickHighestBandwidth } from "./dash";
import { classifyHlsManifestForDrm } from "./drm";
import { isMasterPlaylist, parseMasterVariants, type HlsVariant } from "./hls-variants";
import {
  parseCaptureVariantInspectResponseV1,
  type CaptureExecutionSnapshotDiscardResponseV1,
  type CaptureVariantInspectErrorCodeV1,
  type CaptureVariantInspectMessageV1,
  type CaptureVariantInspectResponseV1,
} from "./offscreen-attempts";
import {
  dashRawVariantOptionV1,
  hlsRawVariantOptionV1,
  inspectHlsMediaPlaylistV1,
} from "./stream-variant-inspection";
import type { RawVariantOptionV1, VariantDisabledReasonV1 } from "./variant-options";
import { buildHlsCryptoPlan, type HlsKeyContext } from "../workers/hls-crypto-plan";

export const STREAM_VARIANT_HTTP_CONCURRENCY = 3;
export const STREAM_VARIANT_RESPONSE_BYTE_LIMIT = 2 * 1024 * 1024;
export const STREAM_VARIANT_REVIEW_BYTE_LIMIT = 16 * 1024 * 1024;
export const STREAM_VARIANT_OPTION_LIMIT = 100;
export const STREAM_VARIANT_REVIEW_LIMIT = 64;
export const STREAM_VARIANT_REQUESTS_PER_REVIEW_LIMIT = 256;
export const STREAM_VARIANT_MAX_DEADLINE_WINDOW_MS = 60_000;
export const STREAM_VARIANT_EXECUTION_SNAPSHOT_LIMIT = 8;
export const STREAM_VARIANT_EXECUTION_SNAPSHOT_BYTE_LIMIT = 32 * 1024 * 1024;

type Timer = ReturnType<typeof setTimeout>;

type RuntimeLimits = {
  responseBytes: number;
  reviewBytes: number;
  variants: number;
  reviews: number;
  requestsPerReview: number;
  deadlineWindowMs: number;
  executionSnapshots: number;
  executionSnapshotBytes: number;
};

export type StreamVariantFetchRuntimeOptionsV1 = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  /** Test seam for opaque snapshot IDs; production uses crypto.randomUUID(). */
  createExecutionSnapshotId?: () => string;
  /** Test-only tighter bounds; values cannot weaken production limits. */
  limits?: Partial<RuntimeLimits>;
};

type ReviewBudget = {
  reviewId: string;
  deadlineAt: number;
  consumedBytes: number;
  requestIds: Set<string>;
  expiryTimer?: Timer;
};

type InspectedManifestSet = {
  variants: RawVariantOptionV1[];
  manifestTexts: Map<string, string>;
};

type ExecutionManifestSnapshot = {
  executionSnapshotId: string;
  kind: "hls" | "dash";
  rootUrl: string;
  deadlineAt: number;
  byteLength: number;
  manifestTexts: ReadonlyMap<string, string>;
};

export type ConsumeExecutionSnapshotRequestV1 = {
  executionSnapshotId: string;
  kind: "hls" | "dash";
  url: string;
  videoRepresentationId?: string;
};

export type ConsumeExecutionSnapshotResultV1 =
  | { ok: true; fetchImpl: typeof fetch }
  | { ok: false };

const EXECUTION_SNAPSHOT_ID_PATTERN =
  /^execution-snapshot-v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SnapshotHlsSegment = {
  uri?: string;
  map?: { uri?: string };
};

type SnapshotHlsManifest = {
  segments?: SnapshotHlsSegment[];
};

class InspectionFailure extends Error {
  constructor(readonly code: CaptureVariantInspectErrorCodeV1) {
    super(code);
    this.name = "InspectionFailure";
  }
}

type SemaphoreWaiter = {
  deadlineAt: number;
  resolve: (release: () => void) => void;
  reject: (error: InspectionFailure) => void;
  timer: Timer;
  settled: boolean;
};

class HttpSemaphore {
  private active = 0;
  private readonly queue: SemaphoreWaiter[] = [];

  constructor(
    private readonly now: () => number,
    private readonly setTimer: (callback: () => void, delayMs: number) => Timer,
    private readonly clearTimer: (timer: Timer) => void,
  ) {}

  acquire(deadlineAt: number): Promise<() => void> {
    if (this.now() >= deadlineAt) {
      return Promise.reject(new InspectionFailure("DEADLINE_EXCEEDED"));
    }
    if (this.active < STREAM_VARIANT_HTTP_CONCURRENCY) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter = {} as SemaphoreWaiter;
      waiter.deadlineAt = deadlineAt;
      waiter.resolve = resolve;
      waiter.reject = reject;
      waiter.settled = false;
      waiter.timer = this.setTimer(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new InspectionFailure("DEADLINE_EXCEEDED"));
      }, Math.max(0, deadlineAt - this.now()));
      this.queue.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    while (this.queue.length > 0) {
      const waiter = this.queue.shift();
      if (!waiter || waiter.settled) continue;
      this.clearTimer(waiter.timer);
      if (this.now() >= waiter.deadlineAt) {
        waiter.settled = true;
        waiter.reject(new InspectionFailure("DEADLINE_EXCEEDED"));
        continue;
      }
      waiter.settled = true;
      waiter.resolve(this.releaseOnce());
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

function boundedLimit(
  value: number | undefined,
  productionMaximum: number,
  label: string,
): number {
  const selected = value ?? productionMaximum;
  if (
    !Number.isSafeInteger(selected) ||
    selected <= 0 ||
    selected > productionMaximum
  ) {
    throw new TypeError(`${label} must be a positive safe integer within its production bound.`);
  }
  return selected;
}

function resolveHttpUrl(uri: string, baseUrl: string): string | undefined {
  try {
    const parsed = new URL(uri, baseUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function requestHttpUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === "string") return canonicalHttpUrl(input);
  if (input instanceof URL) return canonicalHttpUrl(input.href);
  return canonicalHttpUrl(input.url);
}

function hlsMasterProtectionReason(text: string): VariantDisabledReasonV1 | undefined {
  if (classifyHlsManifestForDrm(text).protected) return "drm";
  const encrypted = text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (!/^#EXT-X-(?:SESSION-)?KEY\s*:/i.test(trimmed)) return false;
    const method = /(?:^|,)\s*METHOD\s*=\s*([^,\s]+)/i.exec(
      trimmed.slice(trimmed.indexOf(":") + 1),
    )?.[1]?.trim().toUpperCase();
    return method !== undefined &&
      method !== "" &&
      method !== "NONE" &&
      method !== "AES-128";
  });
  return encrypted ? "unsupported_manifest_shape" : undefined;
}

/**
 * Owns the offscreen-global HTTP lane and review byte budgets. Instantiate
 * exactly once in the offscreen document and inject fetch only in tests.
 */
export class StreamVariantFetchRuntimeV1 {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly createExecutionSnapshotId: () => string;
  private readonly limits: RuntimeLimits;
  private readonly semaphore: HttpSemaphore;
  private readonly reviews = new Map<string, ReviewBudget>();
  private readonly executionSnapshots = new Map<string, ExecutionManifestSnapshot>();
  private executionSnapshotBytes = 0;

  constructor(options: StreamVariantFetchRuntimeOptionsV1 = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.createExecutionSnapshotId = options.createExecutionSnapshotId ?? (() => {
      const uuid = globalThis.crypto?.randomUUID?.();
      if (uuid === undefined) throw new InspectionFailure("EXECUTION_SNAPSHOT_UNAVAILABLE");
      return `execution-snapshot-v1:${uuid}`;
    });
    const limits = options.limits ?? {};
    this.limits = {
      responseBytes: boundedLimit(
        limits.responseBytes,
        STREAM_VARIANT_RESPONSE_BYTE_LIMIT,
        "responseBytes",
      ),
      reviewBytes: boundedLimit(
        limits.reviewBytes,
        STREAM_VARIANT_REVIEW_BYTE_LIMIT,
        "reviewBytes",
      ),
      variants: boundedLimit(limits.variants, STREAM_VARIANT_OPTION_LIMIT, "variants"),
      reviews: boundedLimit(limits.reviews, STREAM_VARIANT_REVIEW_LIMIT, "reviews"),
      requestsPerReview: boundedLimit(
        limits.requestsPerReview,
        STREAM_VARIANT_REQUESTS_PER_REVIEW_LIMIT,
        "requestsPerReview",
      ),
      deadlineWindowMs: boundedLimit(
        limits.deadlineWindowMs,
        STREAM_VARIANT_MAX_DEADLINE_WINDOW_MS,
        "deadlineWindowMs",
      ),
      executionSnapshots: boundedLimit(
        limits.executionSnapshots,
        STREAM_VARIANT_EXECUTION_SNAPSHOT_LIMIT,
        "executionSnapshots",
      ),
      executionSnapshotBytes: boundedLimit(
        limits.executionSnapshotBytes,
        STREAM_VARIANT_EXECUTION_SNAPSHOT_BYTE_LIMIT,
        "executionSnapshotBytes",
      ),
    };
    if (this.limits.reviewBytes < this.limits.responseBytes) {
      throw new TypeError("reviewBytes cannot be smaller than responseBytes.");
    }
    this.semaphore = new HttpSemaphore(this.now, this.setTimer, this.clearTimer);
  }

  inspect(
    request: CaptureVariantInspectMessageV1,
  ): Promise<CaptureVariantInspectResponseV1> {
    return this.inspectInternal(request).catch((error: unknown) => ({
      ok: false,
      code: error instanceof InspectionFailure ? error.code : "FETCH_FAILED",
    }));
  }

  /** Public for deterministic lifecycle tests; normal requests also sweep. */
  sweepExpired(): void {
    const now = this.now();
    for (const [reviewId, review] of this.reviews) {
      if (review.deadlineAt > now) continue;
      if (review.expiryTimer !== undefined) this.clearTimer(review.expiryTimer);
      this.reviews.delete(reviewId);
    }
    for (const [executionSnapshotId, snapshot] of this.executionSnapshots) {
      if (snapshot.deadlineAt > now) continue;
      this.deleteExecutionSnapshot(executionSnapshotId);
    }
  }

  /**
   * Atomically consumes a retained manifest set. A known handle is retired on
   * every attempt, including kind/URL mismatches, so it cannot be replayed.
   */
  consumeExecutionSnapshot(
    request: ConsumeExecutionSnapshotRequestV1,
    delegateFetch: typeof fetch = this.fetchImpl,
  ): ConsumeExecutionSnapshotResultV1 {
    this.sweepExpired();
    if (!EXECUTION_SNAPSHOT_ID_PATTERN.test(request.executionSnapshotId)) {
      return { ok: false };
    }
    const snapshot = this.executionSnapshots.get(request.executionSnapshotId);
    if (!snapshot) return { ok: false };
    this.deleteExecutionSnapshot(request.executionSnapshotId);

    const rootUrl = canonicalHttpUrl(request.url);
    if (
      this.now() >= snapshot.deadlineAt ||
      request.kind !== snapshot.kind ||
      rootUrl === undefined ||
      rootUrl !== snapshot.rootUrl ||
      !snapshot.manifestTexts.has(snapshot.rootUrl)
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      fetchImpl: this.createSnapshotFetch(
        snapshot,
        delegateFetch,
        request.videoRepresentationId,
      ),
    };
  }

  /**
   * Idempotently retires an opaque retained handle without requiring or
   * accepting its kind or source URL. The uniform response does not reveal
   * whether the handle was live, expired, consumed, mismatched, or unknown.
   */
  discardExecutionSnapshot(
    executionSnapshotId: string,
  ): CaptureExecutionSnapshotDiscardResponseV1 {
    this.sweepExpired();
    if (EXECUTION_SNAPSHOT_ID_PATTERN.test(executionSnapshotId)) {
      this.deleteExecutionSnapshot(executionSnapshotId);
    }
    return { ok: true };
  }

  private deleteExecutionSnapshot(executionSnapshotId: string): void {
    const snapshot = this.executionSnapshots.get(executionSnapshotId);
    if (!snapshot) return;
    this.executionSnapshots.delete(executionSnapshotId);
    this.executionSnapshotBytes = Math.max(
      0,
      this.executionSnapshotBytes - snapshot.byteLength,
    );
  }

  private createSnapshotFetch(
    snapshot: ExecutionManifestSnapshot,
    delegateFetch: typeof fetch,
    videoRepresentationId?: string,
  ): typeof fetch {
    const manifestTexts = snapshot.manifestTexts;
    const authorizedSegmentUrls = new Set<string>();
    const activatedManifestUrls = new Set<string>();
    const contentType = snapshot.kind === "hls"
      ? "application/vnd.apple.mpegurl"
      : "application/dash+xml";
    const fetchFromSnapshot = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = requestHttpUrl(input);
      if (url === undefined) throw new TypeError("Execution request must use HTTP(S).");
      const manifestText = manifestTexts.get(url);
      if (manifestText === undefined) {
        if (!authorizedSegmentUrls.has(url)) {
          throw new TypeError("Execution URL is not authorized by the snapshot.");
        }
        // Only media/init URLs derived from a manifest already served out of
        // this snapshot can reach the network. Keep native fetch detached.
        const fetchImpl = delegateFetch;
        return await fetchImpl(input, init);
      }
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method.toUpperCase() !== "GET") {
        throw new TypeError("Execution manifests are read-only.");
      }
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      if (this.now() >= snapshot.deadlineAt) {
        throw new TypeError("Execution snapshot expired.");
      }
      if (!activatedManifestUrls.has(url)) {
        activatedManifestUrls.add(url);
        if (snapshot.kind === "hls") {
          this.authorizeHlsSegments(manifestText, url, authorizedSegmentUrls);
        } else {
          this.authorizeDashSegments(
            manifestText,
            snapshot.rootUrl,
            videoRepresentationId,
            authorizedSegmentUrls,
          );
        }
      }
      return new Response(manifestText, {
        status: 200,
        headers: { "content-type": contentType },
      });
    };
    return fetchFromSnapshot as typeof fetch;
  }

  private authorizeHlsSegments(
    manifestText: string,
    manifestUrl: string,
    authorizedSegmentUrls: Set<string>,
  ): void {
    const parser = new Parser();
    let manifest: SnapshotHlsManifest;
    try {
      parser.push(manifestText);
      parser.end();
      manifest = parser.manifest as SnapshotHlsManifest;
    } catch {
      return;
    }
    for (const segment of manifest.segments ?? []) {
      if (segment.uri !== undefined) {
        const segmentUrl = resolveHttpUrl(segment.uri, manifestUrl);
        if (segmentUrl !== undefined) authorizedSegmentUrls.add(segmentUrl);
      }
      if (segment.map?.uri !== undefined) {
        const initUrl = resolveHttpUrl(segment.map.uri, manifestUrl);
        if (initUrl !== undefined) authorizedSegmentUrls.add(initUrl);
      }
    }
    if ((manifest.segments?.length ?? 0) === 0) return;
    const cryptoPlan = buildHlsCryptoPlan(manifestText, manifestUrl);
    const authorizeKey = (key: HlsKeyContext | undefined) => {
      if (key?.method !== "AES-128") return;
      const keyUrl = resolveHttpUrl(key.keyUri, manifestUrl);
      if (keyUrl !== undefined) authorizedSegmentUrls.add(keyUrl);
    };
    for (const segment of cryptoPlan.segments) {
      authorizeKey(segment.key);
      authorizeKey(segment.mapKey);
    }
  }

  private authorizeDashSegments(
    manifestText: string,
    manifestUrl: string,
    videoRepresentationId: string | undefined,
    authorizedSegmentUrls: Set<string>,
  ): void {
    let manifest: ReturnType<typeof parseMpd>;
    try {
      manifest = parseMpd(manifestText, manifestUrl);
    } catch {
      return;
    }
    const video = videoRepresentationId === undefined
      ? pickHighestBandwidth(
        manifest.video.filter((rep) => !rep.unsupportedShape && !rep.drm.protected),
      )
      : manifest.video.find((rep) => rep.id === videoRepresentationId);
    if (video === undefined) return;
    const audio = manifest.audio.find(
      (rep) => !rep.unsupportedShape && !rep.drm.protected,
    );
    for (const representation of audio === undefined ? [video] : [video, audio]) {
      if (representation.initSegmentUrl !== undefined) {
        authorizedSegmentUrls.add(representation.initSegmentUrl);
      }
      for (const url of representation.mediaSegmentUrls) {
        authorizedSegmentUrls.add(url);
      }
    }
  }

  private scheduleExpiry(review: ReviewBudget): void {
    review.expiryTimer = this.setTimer(() => {
      review.expiryTimer = undefined;
      this.sweepExpired();
      if (this.reviews.get(review.reviewId) === review) this.scheduleExpiry(review);
    }, Math.max(0, review.deadlineAt - this.now()));
  }

  private claimReview(request: CaptureVariantInspectMessageV1): ReviewBudget {
    this.sweepExpired();
    const now = this.now();
    if (request.deadlineAt <= now) {
      throw new InspectionFailure("DEADLINE_EXCEEDED");
    }
    if (request.deadlineAt - now > this.limits.deadlineWindowMs) {
      throw new InspectionFailure("INVALID_DEADLINE");
    }
    let review = this.reviews.get(request.reviewId);
    if (!review) {
      if (this.reviews.size >= this.limits.reviews) {
        throw new InspectionFailure("REVIEW_LIMIT");
      }
      review = {
        reviewId: request.reviewId,
        deadlineAt: request.deadlineAt,
        consumedBytes: 0,
        requestIds: new Set(),
      };
      this.reviews.set(request.reviewId, review);
      this.scheduleExpiry(review);
    } else if (review.deadlineAt !== request.deadlineAt) {
      throw new InspectionFailure("DEADLINE_MISMATCH");
    }
    if (review.requestIds.has(request.requestId)) {
      throw new InspectionFailure("DUPLICATE_REQUEST");
    }
    if (review.requestIds.size >= this.limits.requestsPerReview) {
      throw new InspectionFailure("REVIEW_REQUEST_LIMIT");
    }
    review.requestIds.add(request.requestId);
    return review;
  }

  private retainExecutionSnapshot(
    request: CaptureVariantInspectMessageV1,
    manifestTexts: ReadonlyMap<string, string>,
  ): string {
    this.sweepExpired();
    this.assertDeadline(request.deadlineAt);
    if (this.executionSnapshots.size >= this.limits.executionSnapshots) {
      throw new InspectionFailure("EXECUTION_SNAPSHOT_LIMIT");
    }
    const rootUrl = canonicalHttpUrl(request.url);
    if (rootUrl === undefined || !manifestTexts.has(rootUrl)) {
      throw new InspectionFailure("EXECUTION_SNAPSHOT_UNAVAILABLE");
    }

    const retainedTexts = new Map<string, string>();
    let byteLength = 0;
    const encoder = new TextEncoder();
    for (const [url, text] of manifestTexts) {
      const canonicalUrl = canonicalHttpUrl(url);
      if (canonicalUrl === undefined || canonicalUrl !== url) {
        throw new InspectionFailure("EXECUTION_SNAPSHOT_UNAVAILABLE");
      }
      const textBytes = encoder.encode(text).byteLength;
      if (
        textBytes > this.limits.executionSnapshotBytes - byteLength ||
        textBytes > this.limits.executionSnapshotBytes - this.executionSnapshotBytes - byteLength
      ) {
        throw new InspectionFailure("EXECUTION_SNAPSHOT_LIMIT");
      }
      byteLength += textBytes;
      retainedTexts.set(url, text);
    }

    let executionSnapshotId: string | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let candidate: string;
      try {
        candidate = this.createExecutionSnapshotId();
      } catch (error) {
        if (error instanceof InspectionFailure) throw error;
        throw new InspectionFailure("EXECUTION_SNAPSHOT_UNAVAILABLE");
      }
      if (
        EXECUTION_SNAPSHOT_ID_PATTERN.test(candidate) &&
        !this.executionSnapshots.has(candidate)
      ) {
        executionSnapshotId = candidate;
        break;
      }
    }
    if (executionSnapshotId === undefined) {
      throw new InspectionFailure("EXECUTION_SNAPSHOT_UNAVAILABLE");
    }
    this.assertDeadline(request.deadlineAt);

    const snapshot: ExecutionManifestSnapshot = {
      executionSnapshotId,
      kind: request.kind,
      rootUrl,
      deadlineAt: request.deadlineAt,
      byteLength,
      manifestTexts: retainedTexts,
    };
    this.executionSnapshots.set(executionSnapshotId, snapshot);
    this.executionSnapshotBytes += byteLength;
    return executionSnapshotId;
  }

  private async inspectInternal(
    request: CaptureVariantInspectMessageV1,
  ): Promise<CaptureVariantInspectResponseV1> {
    const review = this.claimReview(request);
    const requestController = new AbortController();
    try {
      const rootText = await this.fetchText(
        request.url,
        review,
        requestController.signal,
      );
      this.assertDeadline(review.deadlineAt);
      const inspected = request.kind === "hls"
        ? await this.inspectHls(request, review, rootText, requestController)
        : this.inspectDash(request, rootText);
      this.assertDeadline(review.deadlineAt);
      const base = parseCaptureVariantInspectResponseV1({
        ok: true,
        variants: inspected.variants,
      });
      if (!base?.ok) throw new InspectionFailure("INVALID_MANIFEST");
      if (request.retainForExecution !== true) return base;

      const executionSnapshotId = this.retainExecutionSnapshot(
        request,
        inspected.manifestTexts,
      );
      const retained = parseCaptureVariantInspectResponseV1({
        ok: true,
        variants: base.variants,
        executionSnapshotId,
      });
      if (!retained?.ok || retained.executionSnapshotId === undefined) {
        this.deleteExecutionSnapshot(executionSnapshotId);
        throw new InspectionFailure("EXECUTION_SNAPSHOT_UNAVAILABLE");
      }
      return retained;
    } catch (error) {
      requestController.abort();
      throw error;
    }
  }

  private assertDeadline(deadlineAt: number): void {
    if (this.now() >= deadlineAt) {
      throw new InspectionFailure("DEADLINE_EXCEEDED");
    }
  }

  private async withinDeadline<T>(
    promise: Promise<T>,
    deadlineAt: number,
    signal: AbortSignal,
    onStop: () => void,
  ): Promise<T> {
    if (this.now() >= deadlineAt) {
      onStop();
      throw new InspectionFailure("DEADLINE_EXCEEDED");
    }
    if (signal.aborted) {
      onStop();
      throw new InspectionFailure("FETCH_FAILED");
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => finish(() => {
        onStop();
        reject(new InspectionFailure("FETCH_FAILED"));
      });
      const timer = this.setTimer(() => finish(() => {
        onStop();
        reject(new InspectionFailure("DEADLINE_EXCEEDED"));
      }), Math.max(0, deadlineAt - this.now()));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        () => finish(() => reject(new InspectionFailure("FETCH_FAILED"))),
      );
    });
  }

  private chargeReview(review: ReviewBudget, bytes: number): void {
    if (bytes < 0 || review.consumedBytes > this.limits.reviewBytes - bytes) {
      // Saturate on overflow so a caller cannot spend the same uncharged tail
      // repeatedly with fresh request IDs after each typed failure.
      review.consumedBytes = this.limits.reviewBytes;
      throw new InspectionFailure("REVIEW_BUDGET_EXCEEDED");
    }
    review.consumedBytes += bytes;
  }

  private async readText(
    response: Response,
    review: ReviewBudget,
    signal: AbortSignal,
    stop: () => void,
  ): Promise<string> {
    const declaredText = response.headers.get("content-length");
    if (declaredText !== null) {
      const declared = Number(declaredText);
      if (Number.isFinite(declared) && declared > this.limits.responseBytes) {
        throw new InspectionFailure("RESPONSE_TOO_LARGE");
      }
    }
    if (!response.body) throw new InspectionFailure("FETCH_FAILED");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let responseBytes = 0;
    let text = "";
    try {
      while (true) {
        const chunk = await this.withinDeadline(
          reader.read(),
          review.deadlineAt,
          signal,
          stop,
        );
        if (chunk.done) break;
        responseBytes += chunk.value.byteLength;
        this.chargeReview(review, chunk.value.byteLength);
        if (responseBytes > this.limits.responseBytes) {
          throw new InspectionFailure("RESPONSE_TOO_LARGE");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }

  private async fetchText(
    url: string,
    review: ReviewBudget,
    signal: AbortSignal,
  ): Promise<string> {
    const release = await this.semaphore.acquire(review.deadlineAt);
    const controller = new AbortController();
    const stop = () => controller.abort();
    const relayAbort = () => controller.abort();
    signal.addEventListener("abort", relayAbort, { once: true });
    try {
      if (signal.aborted) throw new InspectionFailure("FETCH_FAILED");
      // Chromium's Window.fetch brand-checks its receiver. Calling a captured
      // native fetch through `this.fetchImpl(...)` supplies this runtime as the
      // receiver and throws `Illegal invocation` before any request is sent.
      // Detach it first so both the native function and injected test doubles
      // are invoked as ordinary functions.
      const fetchImpl = this.fetchImpl;
      const response = await this.withinDeadline(
        Promise.resolve().then(() =>
          fetchImpl(url, { credentials: "include", signal: controller.signal })
        ),
        review.deadlineAt,
        signal,
        stop,
      );
      if (!response.ok) throw new InspectionFailure("FETCH_FAILED");
      return await this.readText(response, review, signal, stop);
    } finally {
      signal.removeEventListener("abort", relayAbort);
      controller.abort();
      release();
    }
  }

  private async inspectHls(
    request: CaptureVariantInspectMessageV1,
    review: ReviewBudget,
    rootText: string,
    controller: AbortController,
  ): Promise<InspectedManifestSet> {
    const rootUrl = canonicalHttpUrl(request.url);
    if (rootUrl === undefined) throw new InspectionFailure("INVALID_MANIFEST");
    const manifestTexts = new Map<string, string>([[rootUrl, rootText]]);
    if (!isMasterPlaylist(rootText)) {
      const inspection = inspectHlsMediaPlaylistV1(rootText);
      const variant: HlsVariant = { uri: request.url, bandwidth: 0 };
      const raw = hlsRawVariantOptionV1(variant, request.url, inspection);
      if (!raw) throw new InspectionFailure("INVALID_MANIFEST");
      return { variants: [raw], manifestTexts };
    }

    const parsed = parseMasterVariants(rootText, request.url);
    this.assertDeadline(review.deadlineAt);
    if (parsed.length === 0) throw new InspectionFailure("INVALID_MANIFEST");
    if (parsed.length > this.limits.variants) {
      throw new InspectionFailure("TOO_MANY_VARIANTS");
    }
    const masterProtectionReason = hlsMasterProtectionReason(rootText);
    const textByUrl = new Map<string, Promise<string>>();
    textByUrl.set(rootUrl, Promise.resolve(rootText));
    const getText = (url: string): Promise<string> => {
      const existing = textByUrl.get(url);
      if (existing) return existing;
      const created = this.fetchText(url, review, controller.signal).then((text) => {
        manifestTexts.set(url, text);
        return text;
      });
      textByUrl.set(url, created);
      return created;
    };

    const plans = parsed.map((variant) => {
      const videoUrl = resolveHttpUrl(variant.uri, request.url);
      const audioUrl = variant.audioRenditionUri === undefined
        ? undefined
        : resolveHttpUrl(variant.audioRenditionUri, request.url);
      if (!videoUrl || (variant.audioRenditionUri !== undefined && !audioUrl)) {
        throw new InspectionFailure("INVALID_MANIFEST");
      }
      return { variant, videoUrl, audioUrl };
    });

    let primaryError: unknown;
    const tasks = plans.map(({ variant, videoUrl, audioUrl }) =>
      Promise.all([
        getText(videoUrl),
        audioUrl === undefined ? Promise.resolve(undefined) : getText(audioUrl),
      ]).then(([videoText, audioText]) => {
        const video = inspectHlsMediaPlaylistV1(videoText, {
          requireFmp4VideoForSeparateAudio: audioUrl !== undefined,
        });
        const audio = audioText === undefined
          ? undefined
          : inspectHlsMediaPlaylistV1(audioText);
        const raw = hlsRawVariantOptionV1(variant, request.url, video, audio);
        if (!raw) throw new InspectionFailure("INVALID_MANIFEST");
        return masterProtectionReason === undefined
          ? raw
          : { ...raw, disabledReason: masterProtectionReason };
      }).catch((error: unknown) => {
        if (primaryError === undefined) {
          primaryError = error;
          controller.abort();
        }
        throw error;
      }),
    );
    const settled = await Promise.allSettled(tasks);
    if (primaryError !== undefined) throw primaryError;
    const variants = settled.map((result) => {
      if (result.status !== "fulfilled") {
        throw new InspectionFailure("FETCH_FAILED");
      }
      return result.value;
    });
    return { variants, manifestTexts };
  }

  private inspectDash(
    request: CaptureVariantInspectMessageV1,
    rootText: string,
  ): InspectedManifestSet {
    let manifest;
    try {
      manifest = parseMpd(rootText, request.url);
    } catch (error) {
      if (error instanceof DashParseError) {
        throw new InspectionFailure("INVALID_MANIFEST");
      }
      throw error;
    }
    if (manifest.unsupportedShape === "representation-limit") {
      throw new InspectionFailure("TOO_MANY_VARIANTS");
    }
    if (manifest.unsupportedShape === "multiple-periods") {
      throw new InspectionFailure("UNSUPPORTED_MANIFEST");
    }
    if (manifest.video.length === 0) {
      throw new InspectionFailure("INVALID_MANIFEST");
    }
    if (manifest.video.length > this.limits.variants) {
      throw new InspectionFailure("TOO_MANY_VARIANTS");
    }
    const rootUrl = canonicalHttpUrl(request.url);
    if (rootUrl === undefined) throw new InspectionFailure("INVALID_MANIFEST");
    return {
      variants: manifest.video.map((video) => dashRawVariantOptionV1(manifest, video)),
      manifestTexts: new Map([[rootUrl, rootText]]),
    };
  }
}
