export const MAX_CAPTURE_MANIFEST_BLOB_BYTES = 1024 * 1024;
export const MAX_CAPTURE_MANIFEST_BLOB_ID_LENGTH = 256;
export const DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_ACTIVE = 8;
export const DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_TOMBSTONES = 256;
export const DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_STATUS_ENTRIES = 32;
export const DEFAULT_CAPTURE_MANIFEST_BLOB_TTL_MS = 60 * 60 * 1000;

const SAFE_ID_PATTERN = /^[a-z0-9._:-]+$/i;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type CaptureManifestBlobFormat = "json" | "csv";

export type CaptureManifestBlobIdentity = {
  runId: string;
  attemptId: string;
};

export type CaptureManifestBlobCreateMessage = CaptureManifestBlobIdentity & {
  type: "capture-manifest-blob-create";
  format: CaptureManifestBlobFormat;
  content: string;
  contentDigest: string;
};

export type CaptureManifestBlobRevokeMessage = CaptureManifestBlobIdentity & {
  type: "capture-manifest-blob-revoke";
};

export type CaptureManifestBlobStatusMessage = {
  type: "capture-manifest-blob-status";
};

export type CaptureManifestBlobMessage =
  | CaptureManifestBlobCreateMessage
  | CaptureManifestBlobRevokeMessage
  | CaptureManifestBlobStatusMessage;

export type CaptureManifestBlobCreateErrorCode =
  | "CONTENT_TOO_LARGE"
  | "CONTENT_DIGEST_MISMATCH"
  | "IDENTITY_CONFLICT"
  | "ATTEMPT_RETIRED"
  | "REGISTRY_FULL"
  | "DIGEST_UNAVAILABLE"
  | "BLOB_CREATE_FAILED";

/**
 * Classifies whether the output may be attempted again with a fresh identity.
 * `ATTEMPT_RETIRED` is retryable only in that sense: the retired ID itself is
 * never reusable, but an orphan cleaned after a pre-commit worker crash must
 * not permanently disable a later customer command.
 */
export function captureManifestBlobCreateErrorIsRetryable(
  code: CaptureManifestBlobCreateErrorCode,
): boolean {
  return code === "ATTEMPT_RETIRED" || code === "REGISTRY_FULL" ||
    code === "DIGEST_UNAVAILABLE" || code === "BLOB_CREATE_FAILED";
}

export type CaptureManifestBlobCreateResponse =
  | (CaptureManifestBlobIdentity & {
      ok: true;
      format: CaptureManifestBlobFormat;
      contentDigest: string;
      blobUrl: string;
      sizeBytes: number;
      mimeType: string;
    })
  | (CaptureManifestBlobIdentity & {
      ok: false;
      code: CaptureManifestBlobCreateErrorCode;
    });

export type CaptureManifestBlobRevokeResponse = CaptureManifestBlobIdentity & {
  ok: true;
};

export type CaptureManifestBlobStatusEntry = CaptureManifestBlobIdentity & {
  format: CaptureManifestBlobFormat;
  contentDigest: string;
  sizeBytes: number;
  mimeType: string;
  expiresAt: number;
};

export type CaptureManifestBlobStatusResponse = {
  ok: true;
  active: CaptureManifestBlobStatusEntry[];
};

type DataRecord = Record<string, unknown>;

type ActiveManifestBlob = CaptureManifestBlobStatusEntry & {
  blobUrl: string;
};

export type CaptureManifestBlobRegistryOptions = {
  maxActive?: number;
  maxTombstones?: number;
  maxStatusEntries?: number;
  ttlMs?: number;
  now?: () => number;
  digestText?: (content: string) => Promise<string>;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (blobUrl: string) => void;
};

function exactDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
): DataRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const allowed = new Set(requiredKeys);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    requiredKeys.some((required) => !ownKeys.includes(required))
  ) {
    return undefined;
  }

  const entries: Array<readonly [string, unknown]> = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return undefined;
    entries.push([key, descriptor.value]);
  }
  return Object.fromEntries(entries);
}

function dataType(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "type");
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CAPTURE_MANIFEST_BLOB_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value)
  );
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

export function captureManifestBlobMimeType(format: CaptureManifestBlobFormat): string {
  return format === "json" ? "application/json;charset=utf-8" : "text/csv;charset=utf-8";
}

export function captureManifestContentSizeBytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function parseCaptureManifestBlobMessageUnsafe(
  value: unknown,
): CaptureManifestBlobMessage | undefined {
  const type = dataType(value);
  if (type === "capture-manifest-blob-status") {
    const record = exactDataRecord(value, ["type"]);
    return record?.type === type ? { type } : undefined;
  }

  if (type === "capture-manifest-blob-revoke") {
    const record = exactDataRecord(value, ["type", "runId", "attemptId"]);
    if (
      !record ||
      record.type !== type ||
      !isSafeId(record.runId) ||
      !isSafeId(record.attemptId)
    ) {
      return undefined;
    }
    return { type, runId: record.runId, attemptId: record.attemptId };
  }

  if (type === "capture-manifest-blob-create") {
    const record = exactDataRecord(value, [
      "type",
      "runId",
      "attemptId",
      "format",
      "content",
      "contentDigest",
    ]);
    if (
      !record ||
      record.type !== type ||
      !isSafeId(record.runId) ||
      !isSafeId(record.attemptId) ||
      (record.format !== "json" && record.format !== "csv") ||
      typeof record.content !== "string" ||
      captureManifestContentSizeBytes(record.content) > MAX_CAPTURE_MANIFEST_BLOB_BYTES ||
      !isSha256Hex(record.contentDigest)
    ) {
      return undefined;
    }
    return {
      type,
      runId: record.runId,
      attemptId: record.attemptId,
      format: record.format,
      content: record.content,
      contentDigest: record.contentDigest,
    };
  }

  return undefined;
}

export function parseCaptureManifestBlobMessage(
  value: unknown,
): CaptureManifestBlobMessage | undefined {
  try {
    return parseCaptureManifestBlobMessageUnsafe(value);
  } catch {
    return undefined;
  }
}

function isBlobUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  try {
    return new URL(value).protocol === "blob:";
  } catch {
    return false;
  }
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseCaptureManifestBlobCreateResponse(
  value: unknown,
): CaptureManifestBlobCreateResponse | undefined {
  try {
    const record = exactDataRecord(
      value,
      dataType(value) === undefined && (value as { ok?: unknown } | null)?.ok === false
        ? ["ok", "runId", "attemptId", "code"]
        : ["ok", "runId", "attemptId", "format", "contentDigest", "blobUrl", "sizeBytes", "mimeType"],
    );
    if (!record || !isSafeId(record.runId) || !isSafeId(record.attemptId)) return undefined;
    if (record.ok === false) {
      const codes = new Set<CaptureManifestBlobCreateErrorCode>([
        "CONTENT_TOO_LARGE",
        "CONTENT_DIGEST_MISMATCH",
        "IDENTITY_CONFLICT",
        "ATTEMPT_RETIRED",
        "REGISTRY_FULL",
        "DIGEST_UNAVAILABLE",
        "BLOB_CREATE_FAILED",
      ]);
      return typeof record.code === "string" && codes.has(record.code as CaptureManifestBlobCreateErrorCode)
        ? {
            ok: false,
            runId: record.runId,
            attemptId: record.attemptId,
            code: record.code as CaptureManifestBlobCreateErrorCode,
          }
        : undefined;
    }
    if (
      record.ok !== true ||
      (record.format !== "json" && record.format !== "csv") ||
      !isSha256Hex(record.contentDigest) ||
      !isBlobUrl(record.blobUrl) ||
      !isSafeNonNegativeInteger(record.sizeBytes) ||
      record.sizeBytes > MAX_CAPTURE_MANIFEST_BLOB_BYTES ||
      record.mimeType !== captureManifestBlobMimeType(record.format)
    ) return undefined;
    return {
      ok: true,
      runId: record.runId,
      attemptId: record.attemptId,
      format: record.format,
      contentDigest: record.contentDigest,
      blobUrl: record.blobUrl,
      sizeBytes: record.sizeBytes,
      mimeType: record.mimeType,
    };
  } catch {
    return undefined;
  }
}

export function parseCaptureManifestBlobRevokeResponse(
  value: unknown,
): CaptureManifestBlobRevokeResponse | undefined {
  try {
    const record = exactDataRecord(value, ["ok", "runId", "attemptId"]);
    return record?.ok === true && isSafeId(record.runId) && isSafeId(record.attemptId)
      ? { ok: true, runId: record.runId, attemptId: record.attemptId }
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseCaptureManifestBlobStatusResponse(
  value: unknown,
  maxEntries = DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_ACTIVE,
): CaptureManifestBlobStatusResponse | undefined {
  try {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || maxEntries > 32) return undefined;
    const record = exactDataRecord(value, ["ok", "active"]);
    if (record?.ok !== true || !Array.isArray(record.active) || record.active.length > maxEntries) {
      return undefined;
    }
    const active: CaptureManifestBlobStatusEntry[] = [];
    const identities = new Set<string>();
    for (let index = 0; index < record.active.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(record.active, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      const entry = exactDataRecord(descriptor.value, [
        "runId", "attemptId", "format", "contentDigest", "sizeBytes", "mimeType", "expiresAt",
      ]);
      if (
        !entry ||
        !isSafeId(entry.runId) ||
        !isSafeId(entry.attemptId) ||
        (entry.format !== "json" && entry.format !== "csv") ||
        !isSha256Hex(entry.contentDigest) ||
        !isSafeNonNegativeInteger(entry.sizeBytes) ||
        entry.sizeBytes > MAX_CAPTURE_MANIFEST_BLOB_BYTES ||
        entry.mimeType !== captureManifestBlobMimeType(entry.format) ||
        !isFiniteTimestamp(entry.expiresAt)
      ) return undefined;
      const identity = `${entry.runId}\0${entry.attemptId}`;
      if (identities.has(identity)) return undefined;
      identities.add(identity);
      active.push({
        runId: entry.runId,
        attemptId: entry.attemptId,
        format: entry.format,
        contentDigest: entry.contentDigest,
        sizeBytes: entry.sizeBytes,
        mimeType: entry.mimeType,
        expiresAt: entry.expiresAt,
      });
    }
    return { ok: true, active };
  } catch {
    return undefined;
  }
}

export async function sha256CaptureManifestContent(content: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto SHA-256 is unavailable.");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

export class CaptureManifestBlobRegistry {
  private readonly active = new Map<string, ActiveManifestBlob>();
  private readonly tombstones = new Map<string, true>();
  private readonly maxActive: number;
  private readonly maxTombstones: number;
  private readonly maxStatusEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly digestText: (content: string) => Promise<string>;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (blobUrl: string) => void;

  constructor(options: CaptureManifestBlobRegistryOptions = {}) {
    this.maxActive = options.maxActive ?? DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_ACTIVE;
    this.maxTombstones =
      options.maxTombstones ?? DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_TOMBSTONES;
    this.maxStatusEntries =
      options.maxStatusEntries ?? DEFAULT_CAPTURE_MANIFEST_BLOB_MAX_STATUS_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_CAPTURE_MANIFEST_BLOB_TTL_MS;
    assertPositiveSafeInteger(this.maxActive, "maxActive");
    assertPositiveSafeInteger(this.maxTombstones, "maxTombstones");
    assertPositiveSafeInteger(this.maxStatusEntries, "maxStatusEntries");
    assertPositiveSafeInteger(this.ttlMs, "ttlMs");
    this.now = options.now ?? Date.now;
    this.digestText = options.digestText ?? sha256CaptureManifestContent;
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = options.revokeObjectUrl ?? ((blobUrl) => URL.revokeObjectURL(blobUrl));
  }

  private key(identity: CaptureManifestBlobIdentity): string {
    return JSON.stringify([identity.runId, identity.attemptId]);
  }

  private rememberTombstone(key: string): void {
    if (!this.tombstones.has(key)) this.tombstones.set(key, true);
    while (this.tombstones.size > this.maxTombstones) {
      const oldest = this.tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
  }

  private releaseKey(key: string): ActiveManifestBlob | undefined {
    const current = this.active.get(key);
    if (current) {
      this.active.delete(key);
      try {
        this.revokeObjectUrl(current.blobUrl);
      } catch {
        // Object URLs can already be invalidated while the offscreen document
        // is closing. The registry must still retire the exact identity.
      }
    }
    this.rememberTombstone(key);
    return current;
  }

  sweepExpired(now = this.now()): number {
    let released = 0;
    for (const [key, current] of this.active) {
      if (current.expiresAt > now) continue;
      this.releaseKey(key);
      released += 1;
    }
    return released;
  }

  nextExpiryAt(): number | undefined {
    let earliest: number | undefined;
    for (const current of this.active.values()) {
      if (earliest === undefined || current.expiresAt < earliest) earliest = current.expiresAt;
    }
    return earliest;
  }

  async create(
    message: CaptureManifestBlobCreateMessage,
  ): Promise<CaptureManifestBlobCreateResponse> {
    const identity = { runId: message.runId, attemptId: message.attemptId };
    const sizeBytes = captureManifestContentSizeBytes(message.content);
    if (sizeBytes > MAX_CAPTURE_MANIFEST_BLOB_BYTES) {
      return { ok: false, ...identity, code: "CONTENT_TOO_LARGE" };
    }
    let computedDigest: string;
    try {
      computedDigest = await this.digestText(message.content);
    } catch {
      return { ok: false, ...identity, code: "DIGEST_UNAVAILABLE" };
    }
    if (computedDigest !== message.contentDigest) {
      return { ok: false, ...identity, code: "CONTENT_DIGEST_MISMATCH" };
    }

    this.sweepExpired();
    const key = this.key(identity);
    const current = this.active.get(key);
    if (current) {
      if (
        current.contentDigest !== message.contentDigest ||
        current.format !== message.format
      ) {
        return { ok: false, ...identity, code: "IDENTITY_CONFLICT" };
      }
      return {
        ok: true,
        ...identity,
        format: current.format,
        contentDigest: current.contentDigest,
        blobUrl: current.blobUrl,
        sizeBytes: current.sizeBytes,
        mimeType: current.mimeType,
      };
    }
    if (this.tombstones.has(key)) {
      return { ok: false, ...identity, code: "ATTEMPT_RETIRED" };
    }
    if (this.active.size >= this.maxActive) {
      return { ok: false, ...identity, code: "REGISTRY_FULL" };
    }

    const mimeType = captureManifestBlobMimeType(message.format);
    let blobUrl: string;
    try {
      blobUrl = this.createObjectUrl(new Blob([message.content], { type: mimeType }));
    } catch {
      return { ok: false, ...identity, code: "BLOB_CREATE_FAILED" };
    }
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    const active: ActiveManifestBlob = {
      ...identity,
      format: message.format,
      contentDigest: message.contentDigest,
      blobUrl,
      sizeBytes,
      mimeType,
      expiresAt,
    };
    this.active.set(key, active);
    return {
      ok: true,
      ...identity,
      format: active.format,
      contentDigest: active.contentDigest,
      blobUrl: active.blobUrl,
      sizeBytes: active.sizeBytes,
      mimeType: active.mimeType,
    };
  }

  revoke(identity: CaptureManifestBlobIdentity): CaptureManifestBlobRevokeResponse {
    this.sweepExpired();
    this.releaseKey(this.key(identity));
    return { ok: true, runId: identity.runId, attemptId: identity.attemptId };
  }

  status(): CaptureManifestBlobStatusEntry[] {
    this.sweepExpired();
    return [...this.active.values()]
      .slice(0, this.maxStatusEntries)
      .map(({ runId, attemptId, format, contentDigest, sizeBytes, mimeType, expiresAt }) => ({
        runId,
        attemptId,
        format,
        contentDigest,
        sizeBytes,
        mimeType,
        expiresAt,
      }));
  }

  dispose(): void {
    for (const key of [...this.active.keys()]) this.releaseKey(key);
  }
}
