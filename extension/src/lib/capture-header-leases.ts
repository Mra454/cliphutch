/**
 * Background-only, session-scoped replay-header leases for Capture Packs.
 *
 * A lease is created only after the background has resolved an explicitly
 * selected draft item and its authoritative captured-header record. The
 * registry deliberately accepts a very small header allowlist, clones every
 * persisted value, and binds access to the exact draft/item/media/page tuple.
 * It must never be exposed directly to UI or content-script messages.
 */
import type { CapturedHeaders } from "./header-capture";
import { withKeyLock } from "./session-jobs";

export const CAPTURE_HEADER_LEASES_STORAGE_KEY = "capture-header-leases-v1";
export const CAPTURE_HEADER_LEASE_TTL_MS = 60 * 60 * 1_000;
export const MAX_CAPTURE_HEADER_LEASE_RECORDS = 200;
export const MAX_CAPTURE_HEADER_LEASE_BATCH_ITEMS = MAX_CAPTURE_HEADER_LEASE_RECORDS;
export const MAX_CAPTURE_HEADER_LEASE_REGISTRY_BYTES = 4 * 1024 * 1024;
export const MAX_CAPTURE_HEADER_LEASE_HEADER_COUNT = 32;
export const MAX_CAPTURE_HEADER_LEASE_HEADER_NAME_BYTES = 128;
export const MAX_CAPTURE_HEADER_LEASE_HEADER_VALUE_BYTES = 8 * 1024;
export const MAX_CAPTURE_HEADER_LEASE_HEADER_BYTES = 32 * 1024;

const MAX_ID_LENGTH = 256;
const MAX_PAGE_URL_LENGTH = 16_384;
const SAFE_ID_PATTERN = /^[a-z0-9._:-]+$/i;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
const UNSAFE_HEADER_VALUE_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const APPROVED_HEADER_FIELDS = [
  "referer",
  "origin",
  "userAgent",
  "authorization",
  "custom",
] as const;

type UnknownRecord = Record<string, unknown>;

export type CaptureHeaderLeaseBindingV1 = {
  leaseId: string;
  draftId: string;
  itemId: string;
  mediaId: string;
  sourceTabId: number;
  pageUrl: string;
  sourceUrl: string;
  replayKind: "hls" | "dash" | "direct";
};

export type CaptureHeaderLeaseAcceptedAttemptOwnerV1 = {
  runId: string;
  jobId: string;
  attemptId: string;
};

export type CaptureHeaderLeaseReplayScopeV1 = {
  mode: "exact_url" | "directory_prefix";
  /** Exact scheme + host + optional port; subdomains are never implicit. */
  origin: string;
  /** Suitable for a DNR requestDomains guard in addition to urlFilter. */
  requestDomain: string;
  /** Exact URL for direct media, exact origin/directory prefix for streams. */
  scopeUrl: string;
  /** Beginning-anchored for streams and anchored at both ends for direct media. */
  urlFilter: string;
  /** DNR defaults to false, which is unsafe for signed queries and CDN paths. */
  isUrlFilterCaseSensitive: true;
};

export type CaptureHeaderLeaseV1 = CaptureHeaderLeaseBindingV1 & {
  schemaVersion: 1;
  createdAt: number;
  expiresAt: number;
  /** Derived from sourceUrl/replayKind; callers never provide an arbitrary scope. */
  replayScope: CaptureHeaderLeaseReplayScopeV1;
  headers: CapturedHeaders;
  draftItemOwnerActive: boolean;
  acceptedAttemptOwner: CaptureHeaderLeaseAcceptedAttemptOwnerV1 | null;
};

export type CaptureHeaderLeaseSummaryV1 = CaptureHeaderLeaseBindingV1 & {
  schemaVersion: 1;
  createdAt: number;
  expiresAt: number;
  replayScope: CaptureHeaderLeaseReplayScopeV1;
  draftItemOwnerActive: boolean;
  acceptedAttemptOwner: CaptureHeaderLeaseAcceptedAttemptOwnerV1 | null;
};

type CaptureHeaderLeaseRegistryV1 = {
  schemaVersion: 1;
  orderedLeaseIds: string[];
  records: Record<string, CaptureHeaderLeaseV1>;
};

export type CreateCaptureHeaderLeaseInput = CaptureHeaderLeaseBindingV1 & {
  /** Must come from the background-owned captured-header registry. */
  authoritativeHeaders: CapturedHeaders;
  now: number;
};

export type GetCaptureHeaderLeaseInput = CaptureHeaderLeaseBindingV1 & {
  now: number;
};

export type GetClaimedCaptureHeaderLeaseInput =
  CaptureHeaderLeaseAcceptedAttemptOwnerV1 & {
    leaseId: string;
    now: number;
  };

export type ReleaseClaimedCaptureHeaderLeaseInput = GetClaimedCaptureHeaderLeaseInput;

export type ClaimCaptureHeaderLeaseInput = CaptureHeaderLeaseBindingV1 &
  CaptureHeaderLeaseAcceptedAttemptOwnerV1 & {
    now: number;
  };

export type CaptureHeaderLeaseAttemptBindingV1 = CaptureHeaderLeaseBindingV1 &
  CaptureHeaderLeaseAcceptedAttemptOwnerV1;

export type ClaimCaptureHeaderLeaseBatchInput = {
  claims: CaptureHeaderLeaseAttemptBindingV1[];
  now: number;
};

export type ReleaseCaptureHeaderLeaseBatchInput = {
  releases: CaptureHeaderLeaseAttemptBindingV1[];
  now: number;
};

export type CaptureHeaderLeaseReleaseOwner =
  | { kind: "draft_item" }
  | ({ kind: "accepted_attempt" } & CaptureHeaderLeaseAcceptedAttemptOwnerV1);

export type ReleaseCaptureHeaderLeaseInput = CaptureHeaderLeaseBindingV1 & {
  owner: CaptureHeaderLeaseReleaseOwner;
  now: number;
};

export type CaptureHeaderLeaseFailure =
  | { ok: false; reason: "invalid_input"; message: string }
  | { ok: false; reason: "storage_corrupt"; key: string }
  | {
      ok: false;
      reason: "storage_unavailable";
      operation: "get" | "set";
      commitState: "absent" | "unknown";
      message: string;
    }
  | { ok: false; reason: "record_capacity"; limit: number }
  | { ok: false; reason: "serialized_byte_limit"; limit: number }
  | { ok: false; reason: "lease_not_found"; leaseId: string }
  | { ok: false; reason: "lease_expired"; leaseId: string }
  | { ok: false; reason: "lease_conflict"; leaseId: string }
  | { ok: false; reason: "binding_conflict"; leaseId: string }
  | { ok: false; reason: "owner_conflict"; leaseId: string };

export type CreateCaptureHeaderLeaseResult =
  | {
      ok: true;
      changed: boolean;
      replayed: boolean;
      commitState: "committed";
      lease: CaptureHeaderLeaseV1;
      sweptExpiredLeaseIds: string[];
    }
  | CaptureHeaderLeaseFailure;

export type GetCaptureHeaderLeaseResult =
  | { ok: true; lease: CaptureHeaderLeaseV1 | null }
  | CaptureHeaderLeaseFailure;

export type GetClaimedCaptureHeaderLeaseResult = GetCaptureHeaderLeaseResult;

export type ClaimCaptureHeaderLeaseResult =
  | {
      ok: true;
      changed: boolean;
      replayed: boolean;
      commitState: "committed";
      lease: CaptureHeaderLeaseV1;
    }
  | CaptureHeaderLeaseFailure;

export type CaptureHeaderLeaseBatchItemResultV1 = {
  leaseId: string;
  /** Metadata only: batch APIs never return replay-header names or values. */
  lease: CaptureHeaderLeaseSummaryV1 | null;
};

export type ClaimCaptureHeaderLeaseBatchResult =
  | {
      ok: true;
      changed: boolean;
      replayed: boolean;
      commitState: "committed";
      items: CaptureHeaderLeaseBatchItemResultV1[];
    }
  | CaptureHeaderLeaseFailure;

export type ReleaseCaptureHeaderLeaseBatchResult =
  | {
      ok: true;
      changed: boolean;
      replayed: boolean;
      commitState: "committed";
      items: CaptureHeaderLeaseBatchItemResultV1[];
    }
  | CaptureHeaderLeaseFailure;

export type ReleaseCaptureHeaderLeaseResult =
  | {
      ok: true;
      changed: boolean;
      replayed: boolean;
      commitState: "committed";
      lease: CaptureHeaderLeaseV1 | null;
      expired: boolean;
    }
  | CaptureHeaderLeaseFailure;

export type SweepCaptureHeaderLeasesResult =
  | {
      ok: true;
      changed: boolean;
      commitState: "committed";
      removedLeaseIds: string[];
    }
  | CaptureHeaderLeaseFailure;

export type ListCaptureHeaderLeasesResult =
  | {
      ok: true;
      leases: CaptureHeaderLeaseSummaryV1[];
      expiredLeaseIds: string[];
    }
  | CaptureHeaderLeaseFailure;

function invalidInput(): CaptureHeaderLeaseFailure {
  return {
    ok: false,
    reason: "invalid_input",
    message: "Capture header lease input is invalid.",
  };
}

function unavailable(
  operation: "get" | "set",
  commitState: "absent" | "unknown",
): CaptureHeaderLeaseFailure {
  return {
    ok: false,
    reason: "storage_unavailable",
    operation,
    commitState,
    message: "Chrome session storage is unavailable.",
  };
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value)
  );
}

function exactDataRecord(value: unknown, allowedKeys: readonly string[]): UnknownRecord | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== allowedKeys.length ||
      ownKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    ) {
      return undefined;
    }
    const record = Object.create(null) as UnknownRecord;
    for (const key of allowedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return undefined;
  }
}

function subsetDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
): UnknownRecord | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) {
      return undefined;
    }
    const record = Object.create(null) as UnknownRecord;
    for (const rawKey of ownKeys) {
      const key = rawKey as string;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return undefined;
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalPageUrl(value: unknown): string | undefined {
  try {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_PAGE_URL_LENGTH ||
      value !== value.trim() ||
      UNSAFE_HEADER_VALUE_PATTERN.test(value)
    ) {
      return undefined;
    }
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return undefined;
    }
    const canonical = parsed.href;
    return utf8Bytes(canonical) <= MAX_PAGE_URL_LENGTH ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function canonicalSourceUrl(value: unknown): string | undefined {
  const canonical = canonicalPageUrl(value);
  if (!canonical) return undefined;
  try {
    const parsed = new URL(canonical);
    // URL fragments never reach an HTTP request and therefore cannot be part
    // of the DNR replay scope. Query order and values remain untouched.
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
}

function replayKind(value: unknown): value is "hls" | "dash" | "direct" {
  return value === "hls" || value === "dash" || value === "direct";
}

function derivedReplayScope(
  sourceUrl: string,
  kind: "hls" | "dash" | "direct",
): CaptureHeaderLeaseReplayScopeV1 | undefined {
  try {
    const parsed = new URL(sourceUrl);
    const origin = parsed.origin;
    const requestDomain = parsed.hostname;
    if (kind === "direct") {
      // DNR's plain urlFilter is a substring match. Anchor both ends so a
      // credential lease for file.mp4 cannot also match file.mp4.evil. DNR
      // metacharacters cannot be escaped reliably in urlFilter; callers must
      // supply their percent-encoded URL spelling instead of broadening scope.
      if (/[*|^]/.test(sourceUrl)) return undefined;
      return {
        mode: "exact_url",
        origin,
        requestDomain,
        scopeUrl: sourceUrl,
        urlFilter: `|${sourceUrl}|`,
        isUrlFilterCaseSensitive: true,
      };
    }
    const slashIndex = parsed.pathname.lastIndexOf("/");
    const directoryPath = parsed.pathname.slice(0, slashIndex + 1) || "/";
    const scopeUrl = `${origin}${directoryPath}`;
    if (/[*|^]/.test(scopeUrl)) return undefined;
    return {
      mode: "directory_prefix",
      origin,
      requestDomain,
      scopeUrl,
      urlFilter: `|${scopeUrl}`,
      isUrlFilterCaseSensitive: true,
    };
  } catch {
    return undefined;
  }
}

function replayScopesEqual(
  left: CaptureHeaderLeaseReplayScopeV1,
  right: CaptureHeaderLeaseReplayScopeV1,
): boolean {
  return (
    left.mode === right.mode &&
    left.origin === right.origin &&
    left.requestDomain === right.requestDomain &&
    left.scopeUrl === right.scopeUrl &&
    left.urlFilter === right.urlFilter &&
    left.isUrlFilterCaseSensitive === right.isUrlFilterCaseSensitive
  );
}

function parseReplayScope(value: unknown): CaptureHeaderLeaseReplayScopeV1 | undefined {
  const record = exactDataRecord(value, [
    "mode",
    "origin",
    "requestDomain",
    "scopeUrl",
    "urlFilter",
    "isUrlFilterCaseSensitive",
  ]);
  if (
    !record ||
    (record.mode !== "exact_url" && record.mode !== "directory_prefix") ||
    typeof record.origin !== "string" ||
    typeof record.requestDomain !== "string" ||
    typeof record.scopeUrl !== "string" ||
    typeof record.urlFilter !== "string" ||
    record.isUrlFilterCaseSensitive !== true
  ) {
    return undefined;
  }
  try {
    const parsedScope = new URL(record.scopeUrl);
    if (
      parsedScope.origin !== record.origin ||
      parsedScope.hostname !== record.requestDomain ||
      parsedScope.username.length > 0 ||
      parsedScope.password.length > 0 ||
      parsedScope.hash.length > 0 ||
      parsedScope.href !== record.scopeUrl ||
      /[*|^]/.test(record.scopeUrl)
    ) {
      return undefined;
    }
    if (record.mode === "exact_url") {
      if (record.urlFilter !== `|${record.scopeUrl}|`) return undefined;
    } else if (
      parsedScope.search.length > 0 ||
      !parsedScope.pathname.endsWith("/") ||
      record.urlFilter !== `|${record.scopeUrl}`
    ) {
      return undefined;
    }
    return {
      mode: record.mode,
      origin: record.origin,
      requestDomain: record.requestDomain,
      scopeUrl: record.scopeUrl,
      urlFilter: record.urlFilter,
      isUrlFilterCaseSensitive: true,
    };
  } catch {
    return undefined;
  }
}

function cloneReplayScope(scope: CaptureHeaderLeaseReplayScopeV1): CaptureHeaderLeaseReplayScopeV1 {
  return {
    mode: scope.mode,
    origin: scope.origin,
    requestDomain: scope.requestDomain,
    scopeUrl: scope.scopeUrl,
    urlFilter: scope.urlFilter,
    isUrlFilterCaseSensitive: true,
  };
}

/**
 * Pure invariant matcher for DNR integration and tests. It applies exact
 * scheme/origin semantics and never treats a parent domain as a subdomain
 * wildcard. Query strings are exact for direct media and irrelevant only for
 * requests already inside a stream's exact directory prefix.
 */
export function captureHeaderReplayScopeMatchesRequest(
  rawScope: CaptureHeaderLeaseReplayScopeV1,
  requestUrl: string,
): boolean {
  try {
    const scope = parseReplayScope(rawScope);
    const canonicalRequestUrl = canonicalSourceUrl(requestUrl);
    if (!scope || !canonicalRequestUrl) return false;
    if (scope.mode === "exact_url") return canonicalRequestUrl === scope.scopeUrl;
    const parsed = new URL(canonicalRequestUrl);
    if (parsed.origin !== scope.origin || parsed.hostname !== scope.requestDomain) return false;
    return `${parsed.origin}${parsed.pathname}`.startsWith(scope.scopeUrl);
  } catch {
    return false;
  }
}

function safeHeaderValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !UNSAFE_HEADER_VALUE_PATTERN.test(value) &&
    utf8Bytes(value) <= MAX_CAPTURE_HEADER_LEASE_HEADER_VALUE_BYTES
  );
}

function canonicalHeaders(value: unknown): CapturedHeaders | undefined {
  const record = subsetDataRecord(value, APPROVED_HEADER_FIELDS);
  if (!record) return undefined;
  const headers: CapturedHeaders = {};
  let headerCount = 0;
  let headerBytes = 0;

  const namedFields = ["referer", "origin", "userAgent", "authorization"] as const;
  for (const field of namedFields) {
    const rawValue = record[field];
    if (rawValue === undefined) continue;
    if (!safeHeaderValue(rawValue)) return undefined;
    headers[field] = rawValue;
    headerCount += 1;
    const wireName = field === "userAgent" ? "user-agent" : field;
    headerBytes += utf8Bytes(wireName) + utf8Bytes(rawValue);
  }

  if (record.custom !== undefined) {
    let customRecord: UnknownRecord | undefined;
    try {
      if (
        record.custom === null ||
        typeof record.custom !== "object" ||
        Array.isArray(record.custom)
      ) {
        return undefined;
      }
      const prototype = Object.getPrototypeOf(record.custom);
      if (prototype !== Object.prototype && prototype !== null) return undefined;
      const ownKeys = Reflect.ownKeys(record.custom);
      if (
        ownKeys.length > MAX_CAPTURE_HEADER_LEASE_HEADER_COUNT ||
        ownKeys.some((key) => typeof key !== "string")
      ) {
        return undefined;
      }
      customRecord = Object.create(null) as UnknownRecord;
      for (const rawKey of ownKeys) {
        const key = rawKey as string;
        const descriptor = Object.getOwnPropertyDescriptor(record.custom, key);
        if (!descriptor || !("value" in descriptor)) return undefined;
        customRecord[key] = descriptor.value;
      }
    } catch {
      return undefined;
    }

    const customPairs: Array<[string, string]> = [];
    const canonicalNames = new Set<string>();
    for (const [rawName, rawValue] of Object.entries(customRecord)) {
      const name = rawName.toLowerCase();
      if (
        !name.startsWith("x-") ||
        name.length <= 2 ||
        !HEADER_NAME_PATTERN.test(name) ||
        utf8Bytes(name) > MAX_CAPTURE_HEADER_LEASE_HEADER_NAME_BYTES ||
        canonicalNames.has(name) ||
        !safeHeaderValue(rawValue)
      ) {
        return undefined;
      }
      canonicalNames.add(name);
      customPairs.push([name, rawValue]);
      headerCount += 1;
      headerBytes += utf8Bytes(name) + utf8Bytes(rawValue);
    }
    customPairs.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (customPairs.length > 0) headers.custom = Object.fromEntries(customPairs);
  }

  if (
    headerCount === 0 ||
    headerCount > MAX_CAPTURE_HEADER_LEASE_HEADER_COUNT ||
    headerBytes > MAX_CAPTURE_HEADER_LEASE_HEADER_BYTES
  ) {
    return undefined;
  }
  return headers;
}

function headersEqual(left: CapturedHeaders, right: CapturedHeaders): boolean {
  if (
    left.referer !== right.referer ||
    left.origin !== right.origin ||
    left.userAgent !== right.userAgent ||
    left.authorization !== right.authorization
  ) {
    return false;
  }
  const leftCustom = Object.entries(left.custom ?? {});
  const rightCustom = Object.entries(right.custom ?? {});
  return (
    leftCustom.length === rightCustom.length &&
    leftCustom.every(([name, value], index) => {
      const rightEntry = rightCustom[index];
      return rightEntry?.[0] === name && rightEntry[1] === value;
    })
  );
}

function cloneHeaders(headers: CapturedHeaders): CapturedHeaders {
  return {
    ...(headers.referer === undefined ? {} : { referer: headers.referer }),
    ...(headers.origin === undefined ? {} : { origin: headers.origin }),
    ...(headers.userAgent === undefined ? {} : { userAgent: headers.userAgent }),
    ...(headers.authorization === undefined
      ? {}
      : { authorization: headers.authorization }),
    ...(headers.custom === undefined ? {} : { custom: { ...headers.custom } }),
  };
}

function parseBinding(value: unknown): CaptureHeaderLeaseBindingV1 | undefined {
  const record = exactDataRecord(value, [
    "leaseId",
    "draftId",
    "itemId",
    "mediaId",
    "sourceTabId",
    "pageUrl",
    "sourceUrl",
    "replayKind",
  ]);
  if (
    !record ||
    !safeId(record.leaseId) ||
    !safeId(record.draftId) ||
    !safeId(record.itemId) ||
    !safeId(record.mediaId) ||
    !safeInteger(record.sourceTabId)
  ) {
    return undefined;
  }
  const pageUrl = canonicalPageUrl(record.pageUrl);
  const sourceUrl = canonicalSourceUrl(record.sourceUrl);
  if (
    !pageUrl ||
    !sourceUrl ||
    !replayKind(record.replayKind) ||
    !derivedReplayScope(sourceUrl, record.replayKind)
  ) {
    return undefined;
  }
  return {
    leaseId: record.leaseId,
    draftId: record.draftId,
    itemId: record.itemId,
    mediaId: record.mediaId,
    sourceTabId: record.sourceTabId,
    pageUrl,
    sourceUrl,
    replayKind: record.replayKind,
  };
}

function parseAttemptOwner(value: unknown): CaptureHeaderLeaseAcceptedAttemptOwnerV1 | undefined {
  const record = exactDataRecord(value, ["runId", "jobId", "attemptId"]);
  if (!record || !safeId(record.runId) || !safeId(record.jobId) || !safeId(record.attemptId)) {
    return undefined;
  }
  return {
    runId: record.runId,
    jobId: record.jobId,
    attemptId: record.attemptId,
  };
}

function attemptOwnersEqual(
  left: CaptureHeaderLeaseAcceptedAttemptOwnerV1,
  right: CaptureHeaderLeaseAcceptedAttemptOwnerV1,
): boolean {
  return (
    left.runId === right.runId &&
    left.jobId === right.jobId &&
    left.attemptId === right.attemptId
  );
}

function bindingsEqual(
  left: CaptureHeaderLeaseBindingV1,
  right: CaptureHeaderLeaseBindingV1,
): boolean {
  return (
    left.leaseId === right.leaseId &&
    left.draftId === right.draftId &&
    left.itemId === right.itemId &&
    left.mediaId === right.mediaId &&
    left.sourceTabId === right.sourceTabId &&
    left.pageUrl === right.pageUrl &&
    left.sourceUrl === right.sourceUrl &&
    left.replayKind === right.replayKind
  );
}

function cloneAttemptOwner(
  owner: CaptureHeaderLeaseAcceptedAttemptOwnerV1 | null,
): CaptureHeaderLeaseAcceptedAttemptOwnerV1 | null {
  return owner === null
    ? null
    : { runId: owner.runId, jobId: owner.jobId, attemptId: owner.attemptId };
}

function cloneLease(lease: CaptureHeaderLeaseV1): CaptureHeaderLeaseV1 {
  return {
    schemaVersion: 1,
    leaseId: lease.leaseId,
    draftId: lease.draftId,
    itemId: lease.itemId,
    mediaId: lease.mediaId,
    sourceTabId: lease.sourceTabId,
    pageUrl: lease.pageUrl,
    sourceUrl: lease.sourceUrl,
    replayKind: lease.replayKind,
    createdAt: lease.createdAt,
    expiresAt: lease.expiresAt,
    replayScope: cloneReplayScope(lease.replayScope),
    headers: cloneHeaders(lease.headers),
    draftItemOwnerActive: lease.draftItemOwnerActive,
    acceptedAttemptOwner: cloneAttemptOwner(lease.acceptedAttemptOwner),
  };
}

function summarizeLease(lease: CaptureHeaderLeaseV1): CaptureHeaderLeaseSummaryV1 {
  return {
    schemaVersion: 1,
    leaseId: lease.leaseId,
    draftId: lease.draftId,
    itemId: lease.itemId,
    mediaId: lease.mediaId,
    sourceTabId: lease.sourceTabId,
    pageUrl: lease.pageUrl,
    sourceUrl: lease.sourceUrl,
    replayKind: lease.replayKind,
    createdAt: lease.createdAt,
    expiresAt: lease.expiresAt,
    replayScope: cloneReplayScope(lease.replayScope),
    draftItemOwnerActive: lease.draftItemOwnerActive,
    acceptedAttemptOwner: cloneAttemptOwner(lease.acceptedAttemptOwner),
  };
}

function parseLease(value: unknown): CaptureHeaderLeaseV1 | undefined {
  const record = exactDataRecord(value, [
    "schemaVersion",
    "leaseId",
    "draftId",
    "itemId",
    "mediaId",
    "sourceTabId",
    "pageUrl",
    "sourceUrl",
    "replayKind",
    "createdAt",
    "expiresAt",
    "replayScope",
    "headers",
    "draftItemOwnerActive",
    "acceptedAttemptOwner",
  ]);
  if (!record || record.schemaVersion !== 1) return undefined;
  const binding = parseBinding({
    leaseId: record.leaseId,
    draftId: record.draftId,
    itemId: record.itemId,
    mediaId: record.mediaId,
    sourceTabId: record.sourceTabId,
    pageUrl: record.pageUrl,
    sourceUrl: record.sourceUrl,
    replayKind: record.replayKind,
  });
  const headers = canonicalHeaders(record.headers);
  const expectedReplayScope = binding
    ? derivedReplayScope(binding.sourceUrl, binding.replayKind)
    : undefined;
  const replayScope = parseReplayScope(record.replayScope);
  const acceptedAttemptOwner = record.acceptedAttemptOwner === null
    ? null
    : parseAttemptOwner(record.acceptedAttemptOwner);
  if (
    !binding ||
    !headers ||
    !expectedReplayScope ||
    !replayScope ||
    !replayScopesEqual(replayScope, expectedReplayScope) ||
    !safeInteger(record.createdAt) ||
    record.createdAt > Number.MAX_SAFE_INTEGER - CAPTURE_HEADER_LEASE_TTL_MS ||
    !safeInteger(record.expiresAt) ||
    record.expiresAt !== record.createdAt + CAPTURE_HEADER_LEASE_TTL_MS ||
    typeof record.draftItemOwnerActive !== "boolean" ||
    acceptedAttemptOwner === undefined ||
    (!record.draftItemOwnerActive && acceptedAttemptOwner === null)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    ...binding,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    replayScope: expectedReplayScope,
    headers,
    draftItemOwnerActive: record.draftItemOwnerActive,
    acceptedAttemptOwner,
  };
}

function parseCreateInput(value: unknown): {
  binding: CaptureHeaderLeaseBindingV1;
  headers: CapturedHeaders;
  now: number;
} | undefined {
  const record = exactDataRecord(value, [
    "leaseId",
    "draftId",
    "itemId",
    "mediaId",
    "sourceTabId",
    "pageUrl",
    "sourceUrl",
    "replayKind",
    "authoritativeHeaders",
    "now",
  ]);
  if (!record || !safeInteger(record.now)) return undefined;
  const binding = parseBinding({
    leaseId: record.leaseId,
    draftId: record.draftId,
    itemId: record.itemId,
    mediaId: record.mediaId,
    sourceTabId: record.sourceTabId,
    pageUrl: record.pageUrl,
    sourceUrl: record.sourceUrl,
    replayKind: record.replayKind,
  });
  const headers = canonicalHeaders(record.authoritativeHeaders);
  if (
    !binding ||
    !headers ||
    record.now > Number.MAX_SAFE_INTEGER - CAPTURE_HEADER_LEASE_TTL_MS
  ) {
    return undefined;
  }
  return { binding, headers, now: record.now };
}

function parseGetInput(value: unknown): {
  binding: CaptureHeaderLeaseBindingV1;
  now: number;
} | undefined {
  const record = exactDataRecord(value, [
    "leaseId",
    "draftId",
    "itemId",
    "mediaId",
    "sourceTabId",
    "pageUrl",
    "sourceUrl",
    "replayKind",
    "now",
  ]);
  if (!record || !safeInteger(record.now)) return undefined;
  const binding = parseBinding({
    leaseId: record.leaseId,
    draftId: record.draftId,
    itemId: record.itemId,
    mediaId: record.mediaId,
    sourceTabId: record.sourceTabId,
    pageUrl: record.pageUrl,
    sourceUrl: record.sourceUrl,
    replayKind: record.replayKind,
  });
  return binding ? { binding, now: record.now } : undefined;
}

function parseClaimedGetInput(value: unknown): {
  leaseId: string;
  owner: CaptureHeaderLeaseAcceptedAttemptOwnerV1;
  now: number;
} | undefined {
  const record = exactDataRecord(value, ["leaseId", "runId", "jobId", "attemptId", "now"]);
  if (!record || !safeId(record.leaseId) || !safeInteger(record.now)) return undefined;
  const owner = parseAttemptOwner({
    runId: record.runId,
    jobId: record.jobId,
    attemptId: record.attemptId,
  });
  return owner ? { leaseId: record.leaseId, owner, now: record.now } : undefined;
}

function parseClaimInput(value: unknown): {
  binding: CaptureHeaderLeaseBindingV1;
  owner: CaptureHeaderLeaseAcceptedAttemptOwnerV1;
  now: number;
} | undefined {
  const record = exactDataRecord(value, [
    "leaseId",
    "draftId",
    "itemId",
    "mediaId",
    "sourceTabId",
    "pageUrl",
    "sourceUrl",
    "replayKind",
    "runId",
    "jobId",
    "attemptId",
    "now",
  ]);
  if (!record || !safeInteger(record.now)) return undefined;
  const binding = parseBinding({
    leaseId: record.leaseId,
    draftId: record.draftId,
    itemId: record.itemId,
    mediaId: record.mediaId,
    sourceTabId: record.sourceTabId,
    pageUrl: record.pageUrl,
    sourceUrl: record.sourceUrl,
    replayKind: record.replayKind,
  });
  const owner = parseAttemptOwner({
    runId: record.runId,
    jobId: record.jobId,
    attemptId: record.attemptId,
  });
  return binding && owner ? { binding, owner, now: record.now } : undefined;
}

function parseAttemptBinding(value: unknown): CaptureHeaderLeaseAttemptBindingV1 | undefined {
  const record = exactDataRecord(value, [
    "leaseId",
    "draftId",
    "itemId",
    "mediaId",
    "sourceTabId",
    "pageUrl",
    "sourceUrl",
    "replayKind",
    "runId",
    "jobId",
    "attemptId",
  ]);
  if (!record) return undefined;
  const binding = parseBinding({
    leaseId: record.leaseId,
    draftId: record.draftId,
    itemId: record.itemId,
    mediaId: record.mediaId,
    sourceTabId: record.sourceTabId,
    pageUrl: record.pageUrl,
    sourceUrl: record.sourceUrl,
    replayKind: record.replayKind,
  });
  const owner = parseAttemptOwner({
    runId: record.runId,
    jobId: record.jobId,
    attemptId: record.attemptId,
  });
  return binding && owner ? { ...binding, ...owner } : undefined;
}

function parseAttemptBindingArray(value: unknown): CaptureHeaderLeaseAttemptBindingV1[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > MAX_CAPTURE_HEADER_LEASE_BATCH_ITEMS
    ) {
      return undefined;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== length + 1 ||
      ownKeys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= length;
      })
    ) {
      return undefined;
    }
    const entries: CaptureHeaderLeaseAttemptBindingV1[] = [];
    const leaseIds = new Set<string>();
    const attemptOwners = new Set<string>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      const entry = parseAttemptBinding(descriptor.value);
      if (!entry || leaseIds.has(entry.leaseId)) return undefined;
      const attemptOwnerKey = JSON.stringify([entry.runId, entry.jobId, entry.attemptId]);
      if (attemptOwners.has(attemptOwnerKey)) return undefined;
      leaseIds.add(entry.leaseId);
      attemptOwners.add(attemptOwnerKey);
      entries.push(entry);
    }
    return entries;
  } catch {
    return undefined;
  }
}

function parseBatchInput(
  value: unknown,
  field: "claims" | "releases",
): { entries: CaptureHeaderLeaseAttemptBindingV1[]; now: number } | undefined {
  const record = exactDataRecord(value, [field, "now"]);
  if (!record || !safeInteger(record.now)) return undefined;
  const entries = parseAttemptBindingArray(record[field]);
  return entries ? { entries, now: record.now } : undefined;
}

function parseReleaseOwner(value: unknown): CaptureHeaderLeaseReleaseOwner | undefined {
  const draftOwner = exactDataRecord(value, ["kind"]);
  if (draftOwner?.kind === "draft_item") return { kind: "draft_item" };
  const attemptRecord = exactDataRecord(value, ["kind", "runId", "jobId", "attemptId"]);
  if (!attemptRecord || attemptRecord.kind !== "accepted_attempt") return undefined;
  const owner = parseAttemptOwner({
    runId: attemptRecord.runId,
    jobId: attemptRecord.jobId,
    attemptId: attemptRecord.attemptId,
  });
  return owner ? { kind: "accepted_attempt", ...owner } : undefined;
}

function parseReleaseInput(value: unknown): {
  binding: CaptureHeaderLeaseBindingV1;
  owner: CaptureHeaderLeaseReleaseOwner;
  now: number;
} | undefined {
  const record = exactDataRecord(value, [
    "leaseId",
    "draftId",
    "itemId",
    "mediaId",
    "sourceTabId",
    "pageUrl",
    "sourceUrl",
    "replayKind",
    "owner",
    "now",
  ]);
  if (!record || !safeInteger(record.now)) return undefined;
  const binding = parseBinding({
    leaseId: record.leaseId,
    draftId: record.draftId,
    itemId: record.itemId,
    mediaId: record.mediaId,
    sourceTabId: record.sourceTabId,
    pageUrl: record.pageUrl,
    sourceUrl: record.sourceUrl,
    replayKind: record.replayKind,
  });
  const owner = parseReleaseOwner(record.owner);
  return binding && owner ? { binding, owner, now: record.now } : undefined;
}

function canonicalOrder(records: Record<string, CaptureHeaderLeaseV1>): string[] {
  return Object.keys(records).sort((leftId, rightId) => {
    const createdDifference = records[rightId].createdAt - records[leftId].createdAt;
    if (createdDifference !== 0) return createdDifference;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : utf8Bytes(serialized);
  } catch {
    return undefined;
  }
}

function parseOrder(value: unknown): string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CAPTURE_HEADER_LEASE_RECORDS) {
      return undefined;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== length + 1 ||
      ownKeys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= length;
      })
    ) {
      return undefined;
    }
    const ids: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !safeId(descriptor.value)) return undefined;
      ids.push(descriptor.value);
    }
    return new Set(ids).size === ids.length ? ids : undefined;
  } catch {
    return undefined;
  }
}

function parseRecordMap(value: unknown): Record<string, CaptureHeaderLeaseV1> | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length > MAX_CAPTURE_HEADER_LEASE_RECORDS ||
      ownKeys.some((key) => typeof key !== "string")
    ) {
      return undefined;
    }
    const records = Object.create(null) as Record<string, CaptureHeaderLeaseV1>;
    for (const rawKey of ownKeys) {
      const leaseId = rawKey as string;
      const descriptor = Object.getOwnPropertyDescriptor(value, leaseId);
      if (!safeId(leaseId) || !descriptor || !("value" in descriptor)) return undefined;
      const lease = parseLease(descriptor.value);
      if (!lease || lease.leaseId !== leaseId) return undefined;
      records[leaseId] = lease;
    }
    return records;
  } catch {
    return undefined;
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function leaseEquals(left: CaptureHeaderLeaseV1, right: CaptureHeaderLeaseV1): boolean {
  return (
    bindingsEqual(left, right) &&
    left.schemaVersion === right.schemaVersion &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt &&
    replayScopesEqual(left.replayScope, right.replayScope) &&
    headersEqual(left.headers, right.headers) &&
    left.draftItemOwnerActive === right.draftItemOwnerActive &&
    (left.acceptedAttemptOwner === null
      ? right.acceptedAttemptOwner === null
      : right.acceptedAttemptOwner !== null &&
        attemptOwnersEqual(left.acceptedAttemptOwner, right.acceptedAttemptOwner))
  );
}

function registryEquals(
  left: CaptureHeaderLeaseRegistryV1,
  right: CaptureHeaderLeaseRegistryV1,
): boolean {
  return (
    arraysEqual(left.orderedLeaseIds, right.orderedLeaseIds) &&
    left.orderedLeaseIds.every((leaseId) => {
      const rightLease = right.records[leaseId];
      return rightLease !== undefined && leaseEquals(left.records[leaseId], rightLease);
    })
  );
}

function buildRegistry(
  source: Record<string, CaptureHeaderLeaseV1>,
):
  | { ok: true; registry: CaptureHeaderLeaseRegistryV1 }
  | Extract<
      CaptureHeaderLeaseFailure,
      { reason: "record_capacity" | "serialized_byte_limit" }
    > {
  const leaseIds = Object.keys(source);
  if (leaseIds.length > MAX_CAPTURE_HEADER_LEASE_RECORDS) {
    return { ok: false, reason: "record_capacity", limit: MAX_CAPTURE_HEADER_LEASE_RECORDS };
  }
  const records = Object.create(null) as Record<string, CaptureHeaderLeaseV1>;
  for (const leaseId of leaseIds) records[leaseId] = cloneLease(source[leaseId]);
  const registry: CaptureHeaderLeaseRegistryV1 = {
    schemaVersion: 1,
    orderedLeaseIds: canonicalOrder(records),
    records,
  };
  const bytes = serializedBytes(registry);
  return bytes !== undefined && bytes <= MAX_CAPTURE_HEADER_LEASE_REGISTRY_BYTES
    ? { ok: true, registry }
    : {
        ok: false,
        reason: "serialized_byte_limit",
        limit: MAX_CAPTURE_HEADER_LEASE_REGISTRY_BYTES,
      };
}

function emptyRegistry(): CaptureHeaderLeaseRegistryV1 {
  return { schemaVersion: 1, orderedLeaseIds: [], records: Object.create(null) };
}

function parseRegistry(value: unknown): CaptureHeaderLeaseRegistryV1 | undefined {
  if (value === undefined) return emptyRegistry();
  const record = exactDataRecord(value, ["schemaVersion", "orderedLeaseIds", "records"]);
  if (!record || record.schemaVersion !== 1) return undefined;
  const orderedLeaseIds = parseOrder(record.orderedLeaseIds);
  const records = parseRecordMap(record.records);
  if (!orderedLeaseIds || !records) return undefined;
  const recordIds = Object.keys(records);
  if (
    orderedLeaseIds.length !== recordIds.length ||
    orderedLeaseIds.some((leaseId) => records[leaseId] === undefined) ||
    !arraysEqual(orderedLeaseIds, canonicalOrder(records))
  ) {
    return undefined;
  }
  const registry: CaptureHeaderLeaseRegistryV1 = {
    schemaVersion: 1,
    orderedLeaseIds,
    records,
  };
  const bytes = serializedBytes(registry);
  return bytes !== undefined && bytes <= MAX_CAPTURE_HEADER_LEASE_REGISTRY_BYTES
    ? registry
    : undefined;
}

async function readStoredRegistry(): Promise<
  { ok: true; registry: CaptureHeaderLeaseRegistryV1 } | CaptureHeaderLeaseFailure
> {
  try {
    const values: unknown = await chrome.storage.session.get(CAPTURE_HEADER_LEASES_STORAGE_KEY);
    if (values === null || typeof values !== "object" || Array.isArray(values)) {
      return { ok: false, reason: "storage_corrupt", key: CAPTURE_HEADER_LEASES_STORAGE_KEY };
    }
    const prototype = Object.getPrototypeOf(values);
    if (prototype !== Object.prototype && prototype !== null) {
      return { ok: false, reason: "storage_corrupt", key: CAPTURE_HEADER_LEASES_STORAGE_KEY };
    }
    const descriptor = Object.getOwnPropertyDescriptor(values, CAPTURE_HEADER_LEASES_STORAGE_KEY);
    if (descriptor && !("value" in descriptor)) {
      return { ok: false, reason: "storage_corrupt", key: CAPTURE_HEADER_LEASES_STORAGE_KEY };
    }
    const registry = parseRegistry(descriptor && "value" in descriptor
      ? descriptor.value
      : undefined);
    return registry
      ? { ok: true, registry }
      : { ok: false, reason: "storage_corrupt", key: CAPTURE_HEADER_LEASES_STORAGE_KEY };
  } catch {
    return unavailable("get", "unknown");
  }
}

async function writeRegistry(
  previous: CaptureHeaderLeaseRegistryV1,
  expected: CaptureHeaderLeaseRegistryV1,
): Promise<"committed" | CaptureHeaderLeaseFailure> {
  try {
    await chrome.storage.session.set({ [CAPTURE_HEADER_LEASES_STORAGE_KEY]: expected });
    return "committed";
  } catch {
    const readBack = await readStoredRegistry();
    if (!readBack.ok) return unavailable("set", "unknown");
    if (registryEquals(readBack.registry, expected)) return "committed";
    return unavailable(
      "set",
      registryEquals(readBack.registry, previous) ? "absent" : "unknown",
    );
  }
}

function sourceWithoutExpired(
  registry: CaptureHeaderLeaseRegistryV1,
  now: number,
): { records: Record<string, CaptureHeaderLeaseV1>; expiredLeaseIds: string[] } {
  const records = Object.create(null) as Record<string, CaptureHeaderLeaseV1>;
  const expiredLeaseIds: string[] = [];
  for (const leaseId of registry.orderedLeaseIds) {
    const lease = registry.records[leaseId];
    if (lease.expiresAt <= now) expiredLeaseIds.push(leaseId);
    else records[leaseId] = lease;
  }
  return { records, expiredLeaseIds };
}

function bindingFailure(
  lease: CaptureHeaderLeaseV1,
  binding: CaptureHeaderLeaseBindingV1,
): Extract<CaptureHeaderLeaseFailure, { reason: "binding_conflict" }> | undefined {
  return bindingsEqual(lease, binding)
    ? undefined
    : { ok: false, reason: "binding_conflict", leaseId: binding.leaseId };
}

/**
 * Creates one immutable 60-minute header snapshot. A same-ID/same-payload
 * retry returns the exact original lease and never extends its TTL.
 */
export async function createCaptureHeaderLease(
  rawInput: CreateCaptureHeaderLeaseInput,
): Promise<CreateCaptureHeaderLeaseResult> {
  const input = parseCreateInput(rawInput);
  if (!input) return invalidInput();
  return withKeyLock(CAPTURE_HEADER_LEASES_STORAGE_KEY, async () => {
    const read = await readStoredRegistry();
    if (!read.ok) return read;
    const existing = read.registry.records[input.binding.leaseId];
    if (existing) {
      if (existing.expiresAt <= input.now) {
        return { ok: false, reason: "lease_expired", leaseId: input.binding.leaseId };
      }
      if (!bindingsEqual(existing, input.binding) || !headersEqual(existing.headers, input.headers)) {
        return { ok: false, reason: "lease_conflict", leaseId: input.binding.leaseId };
      }
      return {
        ok: true,
        changed: false,
        replayed: true,
        commitState: "committed",
        lease: cloneLease(existing),
        sweptExpiredLeaseIds: [],
      };
    }

    const swept = sourceWithoutExpired(read.registry, input.now);
    const lease: CaptureHeaderLeaseV1 = {
      schemaVersion: 1,
      ...input.binding,
      createdAt: input.now,
      expiresAt: input.now + CAPTURE_HEADER_LEASE_TTL_MS,
      replayScope: derivedReplayScope(
        input.binding.sourceUrl,
        input.binding.replayKind,
      )!,
      headers: cloneHeaders(input.headers),
      draftItemOwnerActive: true,
      acceptedAttemptOwner: null,
    };
    swept.records[lease.leaseId] = lease;
    const built = buildRegistry(swept.records);
    if (!built.ok) return built;
    const written = await writeRegistry(read.registry, built.registry);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      lease: cloneLease(lease),
      sweptExpiredLeaseIds: swept.expiredLeaseIds,
    };
  });
}

/** Reads one unexpired lease only when every binding component matches. */
export async function getCaptureHeaderLease(
  rawInput: GetCaptureHeaderLeaseInput,
): Promise<GetCaptureHeaderLeaseResult> {
  const input = parseGetInput(rawInput);
  if (!input) return invalidInput();
  const read = await readStoredRegistry();
  if (!read.ok) return read;
  const lease = read.registry.records[input.binding.leaseId];
  if (!lease) return { ok: true, lease: null };
  const mismatch = bindingFailure(lease, input.binding);
  if (mismatch) return mismatch;
  if (lease.expiresAt <= input.now) {
    return { ok: false, reason: "lease_expired", leaseId: input.binding.leaseId };
  }
  return { ok: true, lease: cloneLease(lease) };
}

/**
 * Reads replay material only for the exact accepted attempt that owns it. This
 * is the execution-time counterpart to the full draft binding check: a worker
 * cannot substitute a lease ID from another run or retry generation.
 */
export async function getClaimedCaptureHeaderLease(
  rawInput: GetClaimedCaptureHeaderLeaseInput,
): Promise<GetClaimedCaptureHeaderLeaseResult> {
  const input = parseClaimedGetInput(rawInput);
  if (!input) return invalidInput();
  const read = await readStoredRegistry();
  if (!read.ok) return read;
  const lease = read.registry.records[input.leaseId];
  if (!lease) return { ok: true, lease: null };
  if (lease.expiresAt <= input.now) {
    return { ok: false, reason: "lease_expired", leaseId: input.leaseId };
  }
  if (
    lease.acceptedAttemptOwner === null ||
    !attemptOwnersEqual(lease.acceptedAttemptOwner, input.owner)
  ) {
    return { ok: false, reason: "owner_conflict", leaseId: input.leaseId };
  }
  return { ok: true, lease: cloneLease(lease) };
}

/** Releases the exact accepted-attempt owner without trusting caller-authored binding fields. */
export async function releaseClaimedCaptureHeaderLease(
  rawInput: ReleaseClaimedCaptureHeaderLeaseInput,
): Promise<ReleaseCaptureHeaderLeaseResult> {
  const input = parseClaimedGetInput(rawInput);
  if (!input) return invalidInput();
  return withKeyLock(CAPTURE_HEADER_LEASES_STORAGE_KEY, async () => {
    const read = await readStoredRegistry();
    if (!read.ok) return read;
    const existing = read.registry.records[input.leaseId];
    if (!existing) {
      return {
        ok: true,
        changed: false,
        replayed: true,
        commitState: "committed",
        lease: null,
        expired: false,
      };
    }
    if (
      existing.acceptedAttemptOwner !== null &&
      !attemptOwnersEqual(existing.acceptedAttemptOwner, input.owner)
    ) {
      return { ok: false, reason: "owner_conflict", leaseId: input.leaseId };
    }
    if (existing.acceptedAttemptOwner === null && existing.expiresAt > input.now) {
      return {
        ok: true,
        changed: false,
        replayed: true,
        commitState: "committed",
        lease: cloneLease(existing),
        expired: false,
      };
    }

    const source = { ...read.registry.records };
    const expired = existing.expiresAt <= input.now;
    if (expired || !existing.draftItemOwnerActive) {
      delete source[existing.leaseId];
    } else {
      source[existing.leaseId] = {
        ...cloneLease(existing),
        acceptedAttemptOwner: null,
      };
    }
    const built = buildRegistry(source);
    if (!built.ok) return built;
    const written = await writeRegistry(read.registry, built.registry);
    if (written !== "committed") return written;
    const retained = source[existing.leaseId];
    return {
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      lease: retained ? cloneLease(retained) : null,
      expired,
    };
  });
}

/**
 * Permanently removes replay material after the exact accepted attempt no
 * longer needs network access. Unlike releaseClaimedCaptureHeaderLease, this
 * also retires the draft-item reference so terminal jobs cannot leave secret
 * headers behind merely because their Hutch row is still visible.
 */
export async function retireClaimedCaptureHeaderLease(
  rawInput: ReleaseClaimedCaptureHeaderLeaseInput,
): Promise<ReleaseCaptureHeaderLeaseResult> {
  const input = parseClaimedGetInput(rawInput);
  if (!input) return invalidInput();
  return withKeyLock(CAPTURE_HEADER_LEASES_STORAGE_KEY, async () => {
    const read = await readStoredRegistry();
    if (!read.ok) return read;
    const existing = read.registry.records[input.leaseId];
    if (!existing) {
      return {
        ok: true,
        changed: false,
        replayed: true,
        commitState: "committed",
        lease: null,
        expired: false,
      };
    }
    if (
      existing.acceptedAttemptOwner === null ||
      !attemptOwnersEqual(existing.acceptedAttemptOwner, input.owner)
    ) {
      return { ok: false, reason: "owner_conflict", leaseId: input.leaseId };
    }
    const source = { ...read.registry.records };
    delete source[existing.leaseId];
    const built = buildRegistry(source);
    if (!built.ok) return built;
    const written = await writeRegistry(read.registry, built.registry);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      lease: null,
      expired: existing.expiresAt <= input.now,
    };
  });
}

/** Adds the accepted executor attempt as an independent, idempotent owner. */
export async function claimCaptureHeaderLease(
  rawInput: ClaimCaptureHeaderLeaseInput,
): Promise<ClaimCaptureHeaderLeaseResult> {
  const input = parseClaimInput(rawInput);
  if (!input) return invalidInput();
  return withKeyLock(CAPTURE_HEADER_LEASES_STORAGE_KEY, async () => {
    const read = await readStoredRegistry();
    if (!read.ok) return read;
    const existing = read.registry.records[input.binding.leaseId];
    if (!existing) {
      return { ok: false, reason: "lease_not_found", leaseId: input.binding.leaseId };
    }
    const mismatch = bindingFailure(existing, input.binding);
    if (mismatch) return mismatch;
    if (existing.expiresAt <= input.now) {
      return { ok: false, reason: "lease_expired", leaseId: input.binding.leaseId };
    }
    if (existing.acceptedAttemptOwner) {
      return attemptOwnersEqual(existing.acceptedAttemptOwner, input.owner)
        ? {
            ok: true,
            changed: false,
            replayed: true,
            commitState: "committed",
            lease: cloneLease(existing),
          }
        : { ok: false, reason: "owner_conflict", leaseId: input.binding.leaseId };
    }
    const next: CaptureHeaderLeaseV1 = {
      ...cloneLease(existing),
      acceptedAttemptOwner: cloneAttemptOwner(input.owner),
    };
    const source = { ...read.registry.records, [next.leaseId]: next };
    const built = buildRegistry(source);
    if (!built.ok) return built;
    const written = await writeRegistry(read.registry, built.registry);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      lease: cloneLease(next),
    };
  });
}

/**
 * Claims every lease for its exact accepted attempt in one registry write.
 * Preflight is all-or-none: one missing, expired, mismatched, or differently
 * owned lease prevents every unclaimed sibling from changing.
 */
export async function claimCaptureHeaderLeaseBatch(
  rawInput: ClaimCaptureHeaderLeaseBatchInput,
): Promise<ClaimCaptureHeaderLeaseBatchResult> {
  const input = parseBatchInput(rawInput, "claims");
  if (!input) return invalidInput();
  return withKeyLock(CAPTURE_HEADER_LEASES_STORAGE_KEY, async () => {
    const read = await readStoredRegistry();
    if (!read.ok) return read;

    for (const claim of input.entries) {
      const existing = read.registry.records[claim.leaseId];
      if (!existing) {
        return { ok: false, reason: "lease_not_found", leaseId: claim.leaseId };
      }
      const mismatch = bindingFailure(existing, claim);
      if (mismatch) return mismatch;
      if (existing.expiresAt <= input.now) {
        return { ok: false, reason: "lease_expired", leaseId: claim.leaseId };
      }
      if (
        existing.acceptedAttemptOwner &&
        !attemptOwnersEqual(existing.acceptedAttemptOwner, claim)
      ) {
        return { ok: false, reason: "owner_conflict", leaseId: claim.leaseId };
      }
    }

    const source = { ...read.registry.records };
    let changed = false;
    for (const claim of input.entries) {
      const existing = read.registry.records[claim.leaseId];
      if (existing.acceptedAttemptOwner === null) {
        source[claim.leaseId] = {
          ...cloneLease(existing),
          acceptedAttemptOwner: {
            runId: claim.runId,
            jobId: claim.jobId,
            attemptId: claim.attemptId,
          },
        };
        changed = true;
      }
    }

    if (changed) {
      const built = buildRegistry(source);
      if (!built.ok) return built;
      const written = await writeRegistry(read.registry, built.registry);
      if (written !== "committed") return written;
    }
    return {
      ok: true,
      changed,
      replayed: !changed,
      commitState: "committed",
      items: input.entries.map((claim) => ({
        leaseId: claim.leaseId,
        lease: summarizeLease(source[claim.leaseId]),
      })),
    };
  });
}

/**
 * Releases exactly one owner. An expired accepted-attempt lease remains until
 * DNR-aware recovery removes its rule and retires that exact attempt; deleting
 * the record first would lose the proof needed to clean embedded headers.
 */
export async function releaseCaptureHeaderLease(
  rawInput: ReleaseCaptureHeaderLeaseInput,
): Promise<ReleaseCaptureHeaderLeaseResult> {
  const input = parseReleaseInput(rawInput);
  if (!input) return invalidInput();
  return withKeyLock(CAPTURE_HEADER_LEASES_STORAGE_KEY, async () => {
    const read = await readStoredRegistry();
    if (!read.ok) return read;
    const existing = read.registry.records[input.binding.leaseId];
    if (!existing) {
      return {
        ok: true,
        changed: false,
        replayed: true,
        commitState: "committed",
        lease: null,
        expired: false,
      };
    }
    const mismatch = bindingFailure(existing, input.binding);
    if (mismatch) return mismatch;

    const source = { ...read.registry.records };
    const expired = existing.expiresAt <= input.now;
    const next = cloneLease(existing);
    if (input.owner.kind === "draft_item") {
      if (!next.draftItemOwnerActive) {
        return {
          ok: true,
          changed: false,
          replayed: true,
          commitState: "committed",
          lease: cloneLease(next),
          expired,
        };
      }
      next.draftItemOwnerActive = false;
    } else {
      if (next.acceptedAttemptOwner === null) {
        return {
          ok: true,
          changed: false,
          replayed: true,
          commitState: "committed",
          lease: cloneLease(next),
          expired,
        };
      }
      if (!attemptOwnersEqual(next.acceptedAttemptOwner, input.owner)) {
        return { ok: false, reason: "owner_conflict", leaseId: input.binding.leaseId };
      }
      next.acceptedAttemptOwner = null;
    }

    if (!next.draftItemOwnerActive && next.acceptedAttemptOwner === null) {
      delete source[next.leaseId];
    } else {
      source[next.leaseId] = next;
    }
    const built = buildRegistry(source);
    if (!built.ok) return built;
    const written = await writeRegistry(read.registry, built.registry);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      lease: Object.prototype.hasOwnProperty.call(source, next.leaseId)
        ? cloneLease(next)
        : null,
      expired,
    };
  });
}

/**
 * Releases a pack's exact accepted-attempt references atomically. Draft-item
 * ownership is never cleared here; a lease remains available to its selected
 * draft item unless that owner was already released independently.
 */
export async function releaseCaptureHeaderLeaseBatch(
  rawInput: ReleaseCaptureHeaderLeaseBatchInput,
): Promise<ReleaseCaptureHeaderLeaseBatchResult> {
  const input = parseBatchInput(rawInput, "releases");
  if (!input) return invalidInput();
  return withKeyLock(CAPTURE_HEADER_LEASES_STORAGE_KEY, async () => {
    const read = await readStoredRegistry();
    if (!read.ok) return read;

    let activeExactOwnerCount = 0;
    let alreadyReleasedCount = 0;
    let firstAlreadyReleasedLeaseId: string | undefined;
    for (const release of input.entries) {
      const existing = read.registry.records[release.leaseId];
      if (!existing) {
        alreadyReleasedCount += 1;
        firstAlreadyReleasedLeaseId ??= release.leaseId;
        continue;
      }
      const mismatch = bindingFailure(existing, release);
      if (mismatch) return mismatch;
      if (existing.acceptedAttemptOwner === null) {
        alreadyReleasedCount += 1;
        firstAlreadyReleasedLeaseId ??= release.leaseId;
      } else if (!attemptOwnersEqual(existing.acceptedAttemptOwner, release)) {
        return { ok: false, reason: "owner_conflict", leaseId: release.leaseId };
      } else {
        activeExactOwnerCount += 1;
      }
    }
    // A write to this one registry key is atomic. Therefore an exact replay of
    // this batch is either wholly active or wholly released. A mixed cohort
    // proves that at least one entry was never owned by this exact operation
    // (or was changed independently), so releasing the remaining siblings
    // would violate the all-or-none reference boundary.
    if (activeExactOwnerCount > 0 && alreadyReleasedCount > 0) {
      return {
        ok: false,
        reason: "owner_conflict",
        leaseId: firstAlreadyReleasedLeaseId ?? input.entries[0].leaseId,
      };
    }

    const source = { ...read.registry.records };
    let changed = false;
    for (const release of input.entries) {
      const existing = read.registry.records[release.leaseId];
      if (!existing || existing.acceptedAttemptOwner === null) continue;
      const next = cloneLease(existing);
      next.acceptedAttemptOwner = null;
      if (next.draftItemOwnerActive) source[release.leaseId] = next;
      else delete source[release.leaseId];
      changed = true;
    }

    if (changed) {
      const built = buildRegistry(source);
      if (!built.ok) return built;
      const written = await writeRegistry(read.registry, built.registry);
      if (written !== "committed") return written;
    }
    return {
      ok: true,
      changed,
      replayed: !changed,
      commitState: "committed",
      items: input.entries.map((release) => {
        const retained = Object.prototype.hasOwnProperty.call(source, release.leaseId)
          ? source[release.leaseId]
          : undefined;
        return {
          leaseId: release.leaseId,
          lease: retained ? summarizeLease(retained) : null,
        };
      }),
    };
  });
}

/** Removes every expired lease, including leases whose owners crashed. */
export async function sweepExpiredCaptureHeaderLeases(
  now: number,
): Promise<SweepCaptureHeaderLeasesResult> {
  if (!safeInteger(now)) return invalidInput();
  return withKeyLock(CAPTURE_HEADER_LEASES_STORAGE_KEY, async () => {
    const read = await readStoredRegistry();
    if (!read.ok) return read;
    const swept = sourceWithoutExpired(read.registry, now);
    if (swept.expiredLeaseIds.length === 0) {
      return {
        ok: true,
        changed: false,
        commitState: "committed",
        removedLeaseIds: [],
      };
    }
    const built = buildRegistry(swept.records);
    if (!built.ok) return built;
    const written = await writeRegistry(read.registry, built.registry);
    if (written !== "committed") return written;
    return {
      ok: true,
      changed: true,
      commitState: "committed",
      removedLeaseIds: [...swept.expiredLeaseIds],
    };
  });
}

/** Lists newest-first metadata without ever returning header names or values. */
export async function listCaptureHeaderLeases(
  now: number,
): Promise<ListCaptureHeaderLeasesResult> {
  if (!safeInteger(now)) return invalidInput();
  const read = await readStoredRegistry();
  if (!read.ok) return read;
  const leases: CaptureHeaderLeaseSummaryV1[] = [];
  const expiredLeaseIds: string[] = [];
  for (const leaseId of read.registry.orderedLeaseIds) {
    const lease = read.registry.records[leaseId];
    if (lease.expiresAt <= now) expiredLeaseIds.push(leaseId);
    else leases.push(summarizeLease(lease));
  }
  return { ok: true, leases, expiredLeaseIds };
}
