export const DEFAULT_CAPTURE_NATIVE_PREFLIGHT_TIMEOUT_MS = 10_000;

export type CaptureNativePreflightSuccess = {
  ok: true;
  method: "HEAD" | "GET";
  status: number;
  contentType?: string;
  sizeBytes?: number;
};

export type CaptureNativePreflightFailure = {
  ok: false;
  code:
    | "NATIVE_SOURCE_INVALID"
    | "NATIVE_SOURCE_TIMEOUT"
    | "NATIVE_SOURCE_UNAVAILABLE"
    | "NATIVE_SOURCE_NOT_MEDIA";
  customerMessage: string;
  status?: number;
};

export type CaptureNativePreflightResult =
  | CaptureNativePreflightSuccess
  | CaptureNativePreflightFailure;

export type CaptureNativePreflightDependencies = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Optional batch deadline/cancellation owned by the caller. */
  signal?: AbortSignal;
};

export type CaptureNativePreflightBatchEntry = {
  itemId: string;
  url: string;
};

export type CaptureNativePreflightBatchDependencies = CaptureNativePreflightDependencies & {
  maxConcurrency?: number;
  batchTimeoutMs?: number;
};

const HTTP_FALLBACK_STATUSES = new Set([400, 403, 405, 501]);

function safeHttpUrl(value: string): string | undefined {
  try {
    if (value.length === 0 || value.length > 16_384) return undefined;
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function safeContentType(headers: Headers): string | undefined {
  const value = headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return value && value.length <= 256 ? value : undefined;
}

function safeSize(headers: Headers): number | undefined {
  const contentRange = headers.get("content-range");
  const rangeMatch = contentRange?.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
  const raw = rangeMatch?.[1] ?? headers.get("content-length") ?? "";
  if (!/^(0|[1-9]\d*)$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function responseFailure(response: Response): CaptureNativePreflightFailure {
  const status = response.status;
  const unavailable = status === 401 || status === 403
    ? "The source no longer grants access. Refresh the source page and review the pack again."
    : status === 404 || status === 410
      ? "The source is no longer available. Refresh the source page and review the pack again."
      : status === 429
        ? "The source is temporarily rate-limited. Wait a moment and refresh the review."
        : "ClipHutch could not verify this source. Keep the source page open and refresh the review.";
  return {
    ok: false,
    code: "NATIVE_SOURCE_UNAVAILABLE",
    customerMessage: unavailable,
    status,
  };
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function acceptedResponse(
  response: Response,
  method: "HEAD" | "GET",
): CaptureNativePreflightResult {
  if (!response.ok || response.status === 204 || response.status === 205) {
    return responseFailure(response);
  }
  const contentType = safeContentType(response.headers);
  const sizeBytes = safeSize(response.headers);
  if (sizeBytes === 0) {
    return {
      ok: false,
      code: "NATIVE_SOURCE_NOT_MEDIA",
      customerMessage: "This source is empty. Refresh the source page and review the pack again.",
      status: response.status,
    };
  }
  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    return {
      ok: false,
      code: "NATIVE_SOURCE_NOT_MEDIA",
      customerMessage: "This address now returns a web page instead of the reviewed media. Refresh the source page and try again.",
      status: response.status,
    };
  }
  return {
    ok: true,
    method,
    status: response.status,
    ...(contentType === undefined ? {} : { contentType }),
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  };
}

/**
 * Performs a bounded availability check without retaining media bytes.
 *
 * HEAD is preferred. A one-byte range GET is used only for common servers
 * that reject HEAD; its body is cancelled immediately even when the server
 * ignores Range. No page-captured Authorization or custom header is accepted
 * here—those sources are classified separately before this function runs.
 */
export async function preflightCaptureNativeSource(
  rawUrl: string,
  dependencies: CaptureNativePreflightDependencies = {},
): Promise<CaptureNativePreflightResult> {
  const url = safeHttpUrl(rawUrl);
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_CAPTURE_NATIVE_PREFLIGHT_TIMEOUT_MS;
  if (
    !url || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000
  ) {
    return {
      ok: false,
      code: "NATIVE_SOURCE_INVALID",
      customerMessage: "This source address cannot be verified safely.",
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  let externallyAborted = false;
  const abortFromCaller = () => {
    externallyAborted = true;
    controller.abort();
  };
  if (dependencies.signal?.aborted) abortFromCaller();
  else dependencies.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const base: RequestInit = {
    cache: "no-store",
    credentials: "include",
    redirect: "follow",
    referrerPolicy: "no-referrer",
    signal: controller.signal,
  };

  try {
    const head = await fetchImpl(url, { ...base, method: "HEAD" });
    if (head.ok && head.status !== 204 && head.status !== 205) {
      const result = acceptedResponse(head, "HEAD");
      await cancelBody(head);
      return result;
    }
    if (!HTTP_FALLBACK_STATUSES.has(head.status)) {
      const result = responseFailure(head);
      await cancelBody(head);
      return result;
    }
    await cancelBody(head);

    const range = await fetchImpl(url, {
      ...base,
      method: "GET",
      headers: { Range: "bytes=0-0" },
    });
    const result = acceptedResponse(range, "GET");
    await cancelBody(range);
    return result;
  } catch {
    return timedOut || externallyAborted
      ? {
          ok: false,
          code: "NATIVE_SOURCE_TIMEOUT",
          customerMessage: "The source did not respond in time. Keep the page open and refresh the review.",
        }
      : {
          ok: false,
          code: "NATIVE_SOURCE_UNAVAILABLE",
          customerMessage: "ClipHutch could not reach this source. Keep the page open and refresh the review.",
        };
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** Bounded, order-preserving preflight for one reviewed pack. */
export async function preflightCaptureNativeSources(
  entries: readonly CaptureNativePreflightBatchEntry[],
  dependencies: CaptureNativePreflightBatchDependencies = {},
): Promise<Array<{ itemId: string; result: CaptureNativePreflightResult }>> {
  if (!Array.isArray(entries) || entries.length > 200) {
    throw new TypeError("A native preflight batch may contain at most 200 entries.");
  }
  const maxConcurrency = dependencies.maxConcurrency ?? 6;
  const batchTimeoutMs = dependencies.batchTimeoutMs ?? 15_000;
  if (
    !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8 ||
    !Number.isSafeInteger(batchTimeoutMs) || batchTimeoutMs < 100 || batchTimeoutMs > 30_000
  ) {
    throw new TypeError("Native preflight batch bounds are invalid.");
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      !entry || typeof entry !== "object" ||
      typeof entry.itemId !== "string" || entry.itemId.length === 0 ||
      entry.itemId.length > 256 || !/^[a-z0-9._:-]+$/i.test(entry.itemId) ||
      seen.has(entry.itemId)
    ) {
      throw new TypeError("Native preflight item identifiers must be unique and bounded.");
    }
    seen.add(entry.itemId);
  }
  if (entries.length === 0) return [];

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (dependencies.signal?.aborted) abortFromCaller();
  else dependencies.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), batchTimeoutMs);
  const results = new Array<{ itemId: string; result: CaptureNativePreflightResult }>(entries.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      if (!entry) continue;
      const result = controller.signal.aborted
        ? {
            ok: false as const,
            code: "NATIVE_SOURCE_TIMEOUT" as const,
            customerMessage: "The source verification window expired. Refresh the review to try again.",
          }
        : await preflightCaptureNativeSource(entry.url, {
            fetchImpl: dependencies.fetchImpl,
            timeoutMs: dependencies.timeoutMs,
            signal: controller.signal,
          });
      results[index] = { itemId: entry.itemId, result };
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(maxConcurrency, entries.length) }, () => worker()),
    );
    return results;
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener("abort", abortFromCaller);
    controller.abort();
  }
}
