import {
  MAX_NORMALIZED_VARIANT_OPTIONS,
  MAX_VARIANT_BANDWIDTH,
  MAX_VARIANT_DIMENSION,
  MAX_VARIANT_DURATION_SEC,
  MAX_VARIANT_SOURCE_ID_LENGTH,
  type RawVariantBandwidthV1,
  type RawVariantOptionV1,
  type VariantDisabledReasonV1,
} from "./variant-options";

const MAX_ID_LENGTH = 256;
const MAX_URL_LENGTH = 16_384;
const MAX_REPRESENTATION_ID_LENGTH = 1_024;
const SAFE_ID_PATTERN = /^[a-z0-9._:-]+$/i;
const EXECUTION_SNAPSHOT_ID_PATTERN =
  /^execution-snapshot-v1:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_OR_BIDI_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

export type AttemptIdentity = {
  jobId: string;
  attemptId?: string;
};

export type HeavyJobKind = "hls" | "dash" | "webm";

export type HlsStartMessage = AttemptIdentity & {
  type: "hls-download-start";
  url: string;
  sizeCapBytes: number;
  variantUrl?: string;
  audioUrl?: string;
  /** Bind the fresh video/default-audio tuple exactly; never auto-fallback. */
  exactVariantSelection?: boolean;
  /** Opaque, one-use handle for the exact manifests inspected by policy. */
  executionSnapshotId?: string;
  authorizationExpiresAt?: number;
};

export type DashStartMessage = AttemptIdentity & {
  type: "dash-download-start";
  url: string;
  sizeCapBytes: number;
  videoRepresentationId?: string;
  /** Opaque, one-use handle for the exact MPD inspected by policy. */
  executionSnapshotId?: string;
  authorizationExpiresAt?: number;
};

export type WebmStartMessage = AttemptIdentity & {
  type: "webm-transcode-start";
  url: string;
  sizeCapBytes: number;
  authorizationExpiresAt?: number;
};

export type HeavyStartMessage = HlsStartMessage | DashStartMessage | WebmStartMessage;

export type HeavyControlMessage = AttemptIdentity & {
  type:
    | "hls-download-cancel"
    | "hls-download-revoke"
    | "dash-download-cancel"
    | "dash-download-revoke"
    | "webm-transcode-cancel"
    | "webm-transcode-revoke";
};

export type ListVariantsMessage = {
  type: "list-variants-start";
  url: string;
  kind: "hls" | "dash";
};

export type CaptureVariantInspectMessageV1 = {
  type: "capture-variant-inspect";
  requestId: string;
  reviewId: string;
  url: string;
  kind: "hls" | "dash";
  /** Absolute epoch-millisecond deadline shared by the whole review. */
  deadlineAt: number;
  /** Retain the exact fetched manifests for one execution before the deadline. */
  retainForExecution?: true;
};

export const CAPTURE_VARIANT_INSPECT_ERROR_CODES_V1 = [
  "DEADLINE_EXCEEDED",
  "INVALID_DEADLINE",
  "FETCH_FAILED",
  "RESPONSE_TOO_LARGE",
  "REVIEW_BUDGET_EXCEEDED",
  "TOO_MANY_VARIANTS",
  "INVALID_MANIFEST",
  "UNSUPPORTED_MANIFEST",
  "DUPLICATE_REQUEST",
  "DEADLINE_MISMATCH",
  "REVIEW_LIMIT",
  "REVIEW_REQUEST_LIMIT",
  "EXECUTION_SNAPSHOT_LIMIT",
  "EXECUTION_SNAPSHOT_UNAVAILABLE",
] as const;

export type CaptureVariantInspectErrorCodeV1 =
  (typeof CAPTURE_VARIANT_INSPECT_ERROR_CODES_V1)[number];

export type CaptureVariantInspectResponseV1 =
  | { ok: true; variants: RawVariantOptionV1[]; executionSnapshotId?: string }
  | { ok: false; code: CaptureVariantInspectErrorCodeV1 };

/** Opaque retirement command. It deliberately carries no manifest locator. */
export type CaptureExecutionSnapshotDiscardMessageV1 = {
  type: "capture-execution-snapshot-discard";
  executionSnapshotId: string;
};

export type CaptureExecutionSnapshotDiscardResponseV1 = { ok: true };

export type CaptureExecutorStatusMessage = {
  type: "capture-executor-status";
};

export type OffscreenIncomingMessage =
  | HeavyStartMessage
  | HeavyControlMessage
  | ListVariantsMessage
  | CaptureVariantInspectMessageV1
  | CaptureExecutionSnapshotDiscardMessageV1
  | CaptureExecutorStatusMessage;

type DataRecord = Record<string, unknown>;

function exactDataRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): DataRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;

  const allowed = new Set([...requiredKeys, ...optionalKeys]);
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
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value)
  );
}

function isOptionalSafeId(value: unknown): value is string | undefined {
  return value === undefined || isSafeId(value);
}

function isExecutionSnapshotId(value: unknown): value is string {
  return typeof value === "string" && EXECUTION_SNAPSHOT_ID_PATTERN.test(value);
}

function isOptionalExecutionSnapshotId(value: unknown): value is string | undefined {
  return value === undefined || isExecutionSnapshotId(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOptionalPositiveSafeInteger(value: unknown): value is number | undefined {
  return value === undefined || isPositiveSafeInteger(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }
  const parsed = new URL(value);
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function isOptionalHttpUrl(value: unknown): value is string | undefined {
  return value === undefined || isHttpUrl(value);
}

function isOptionalRepresentationId(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_REPRESENTATION_ID_LENGTH &&
      !CONTROL_PATTERN.test(value))
  );
}

function identityFrom(record: DataRecord): AttemptIdentity | undefined {
  if (!isSafeId(record.jobId) || !isOptionalSafeId(record.attemptId)) return undefined;
  return record.attemptId === undefined
    ? { jobId: record.jobId }
    : { jobId: record.jobId, attemptId: record.attemptId };
}

function isInspectErrorCode(value: unknown): value is CaptureVariantInspectErrorCodeV1 {
  return (
    typeof value === "string" &&
    CAPTURE_VARIANT_INSPECT_ERROR_CODES_V1.some((code) => code === value)
  );
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !CONTROL_OR_BIDI_PATTERN.test(value)
  );
}

function positiveSafeIntegerAtMost(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

function parseRawBandwidth(value: unknown): RawVariantBandwidthV1 | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const scopeDescriptor = Object.getOwnPropertyDescriptor(value, "scope");
  const scope = scopeDescriptor && "value" in scopeDescriptor
    ? scopeDescriptor.value
    : undefined;
  if (scope === "unknown") {
    return exactDataRecord(value, ["scope"]) ? { scope } : undefined;
  }
  if (scope === "combined") {
    const record = exactDataRecord(value, ["scope", "combinedBandwidth"]);
    return record &&
      positiveSafeIntegerAtMost(record.combinedBandwidth, MAX_VARIANT_BANDWIDTH)
      ? { scope, combinedBandwidth: record.combinedBandwidth }
      : undefined;
  }
  if (scope === "video_only" || scope === "video_with_unknown_default_audio") {
    const record = exactDataRecord(value, ["scope", "videoBandwidth"]);
    return record &&
      positiveSafeIntegerAtMost(record.videoBandwidth, MAX_VARIANT_BANDWIDTH)
      ? { scope, videoBandwidth: record.videoBandwidth }
      : undefined;
  }
  if (scope === "video_with_default_audio") {
    const record = exactDataRecord(
      value,
      ["scope", "videoBandwidth", "audioBandwidth"],
    );
    if (
      !record ||
      !positiveSafeIntegerAtMost(record.videoBandwidth, MAX_VARIANT_BANDWIDTH) ||
      !positiveSafeIntegerAtMost(record.audioBandwidth, MAX_VARIANT_BANDWIDTH) ||
      record.videoBandwidth > MAX_VARIANT_BANDWIDTH - record.audioBandwidth
    ) {
      return undefined;
    }
    return {
      scope,
      videoBandwidth: record.videoBandwidth,
      audioBandwidth: record.audioBandwidth,
    };
  }
  return undefined;
}

const INSPECT_DISABLED_REASONS: readonly VariantDisabledReasonV1[] = [
  "drm",
  "live",
  "unsupported_codec",
  "unsupported_container",
  "unsupported_manifest_shape",
  "unsupported_audio",
  "permanent_download_failure",
  "invalid_media",
];

function parseRawVariantOption(value: unknown): RawVariantOptionV1 | undefined {
  const record = exactDataRecord(
    value,
    ["sourceId", "bandwidth"],
    [
      "audioSourceId",
      "width",
      "height",
      "codecs",
      "container",
      "durationSec",
      "exactBytes",
      "disabledReason",
    ],
  );
  if (!record || !isBoundedText(record.sourceId, MAX_VARIANT_SOURCE_ID_LENGTH)) {
    return undefined;
  }
  const bandwidth = parseRawBandwidth(record.bandwidth);
  if (!bandwidth) return undefined;
  if (
    record.audioSourceId !== undefined &&
    (!isBoundedText(record.audioSourceId, MAX_VARIANT_SOURCE_ID_LENGTH) ||
      !isHttpUrl(record.audioSourceId))
  ) {
    return undefined;
  }
  if (
    record.width !== undefined &&
    !positiveSafeIntegerAtMost(record.width, MAX_VARIANT_DIMENSION)
  ) return undefined;
  if (
    record.height !== undefined &&
    !positiveSafeIntegerAtMost(record.height, MAX_VARIANT_DIMENSION)
  ) return undefined;
  if (record.codecs !== undefined && !isBoundedText(record.codecs, 512)) return undefined;
  if (
    record.container !== undefined &&
    (!isBoundedText(record.container, 64) ||
      !/^[a-z0-9][a-z0-9.+-]*(?:\/[a-z0-9][a-z0-9.+-]*)?$/.test(record.container))
  ) return undefined;
  if (
    record.durationSec !== undefined &&
    (typeof record.durationSec !== "number" ||
      !Number.isFinite(record.durationSec) ||
      record.durationSec <= 0 ||
      record.durationSec > MAX_VARIANT_DURATION_SEC)
  ) return undefined;
  if (
    record.exactBytes !== undefined &&
    (typeof record.exactBytes !== "number" ||
      !Number.isSafeInteger(record.exactBytes) ||
      record.exactBytes < 0)
  ) return undefined;
  if (
    record.disabledReason !== undefined &&
    !INSPECT_DISABLED_REASONS.some((reason) => reason === record.disabledReason)
  ) return undefined;
  return {
    sourceId: record.sourceId,
    ...(record.audioSourceId === undefined
      ? {}
      : { audioSourceId: record.audioSourceId as string }),
    ...(record.width === undefined ? {} : { width: record.width as number }),
    ...(record.height === undefined ? {} : { height: record.height as number }),
    ...(record.codecs === undefined ? {} : { codecs: record.codecs as string }),
    ...(record.container === undefined ? {} : { container: record.container as string }),
    bandwidth,
    ...(record.durationSec === undefined
      ? {}
      : { durationSec: record.durationSec as number }),
    ...(record.exactBytes === undefined ? {} : { exactBytes: record.exactBytes as number }),
    ...(record.disabledReason === undefined
      ? {}
      : { disabledReason: record.disabledReason as VariantDisabledReasonV1 }),
  };
}

function parseRawVariantArray(value: unknown): RawVariantOptionV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !lengthDescriptor ||
    !("value" in lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.value > MAX_NORMALIZED_VARIANT_OPTIONS
  ) return undefined;
  const length = lengthDescriptor.value as number;
  const expectedKeys = new Set(["length"]);
  for (let index = 0; index < length; index += 1) expectedKeys.add(String(index));
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !expectedKeys.has(key),
    )
  ) return undefined;
  const variants: RawVariantOptionV1[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return undefined;
    const parsed = parseRawVariantOption(descriptor.value);
    if (!parsed) return undefined;
    variants.push(parsed);
  }
  return variants;
}

function parseOffscreenIncomingMessageUnsafe(value: unknown): OffscreenIncomingMessage | undefined {
  const type = dataType(value);
  if (type === "capture-execution-snapshot-discard") {
    const record = exactDataRecord(value, ["type", "executionSnapshotId"]);
    if (
      !record ||
      record.type !== type ||
      !isExecutionSnapshotId(record.executionSnapshotId)
    ) {
      return undefined;
    }
    return { type, executionSnapshotId: record.executionSnapshotId };
  }
  if (type === "capture-executor-status") {
    const record = exactDataRecord(value, ["type"]);
    return record?.type === type ? { type } : undefined;
  }
  if (type === "list-variants-start") {
    const record = exactDataRecord(value, ["type", "url", "kind"]);
    if (
      !record ||
      record.type !== type ||
      !isHttpUrl(record.url) ||
      (record.kind !== "hls" && record.kind !== "dash")
    ) {
      return undefined;
    }
    return { type, url: record.url, kind: record.kind };
  }
  if (type === "capture-variant-inspect") {
    const record = exactDataRecord(
      value,
      ["type", "requestId", "reviewId", "url", "kind", "deadlineAt"],
      ["retainForExecution"],
    );
    if (
      !record ||
      record.type !== type ||
      !isSafeId(record.requestId) ||
      !isSafeId(record.reviewId) ||
      !isHttpUrl(record.url) ||
      (record.kind !== "hls" && record.kind !== "dash") ||
      !isPositiveSafeInteger(record.deadlineAt) ||
      (record.retainForExecution !== undefined && record.retainForExecution !== true)
    ) {
      return undefined;
    }
    return {
      type,
      requestId: record.requestId,
      reviewId: record.reviewId,
      url: record.url,
      kind: record.kind,
      deadlineAt: record.deadlineAt,
      ...(record.retainForExecution === true ? { retainForExecution: true as const } : {}),
    };
  }

  if (type === "hls-download-start") {
    const record = exactDataRecord(
      value,
      ["type", "jobId", "url", "sizeCapBytes"],
      [
        "attemptId",
        "variantUrl",
        "audioUrl",
        "exactVariantSelection",
        "executionSnapshotId",
        "authorizationExpiresAt",
      ],
    );
    const identity = record ? identityFrom(record) : undefined;
    if (
      !record ||
      !identity ||
      record.type !== type ||
      !isHttpUrl(record.url) ||
      !isPositiveSafeInteger(record.sizeCapBytes) ||
      !isOptionalHttpUrl(record.variantUrl) ||
      !isOptionalHttpUrl(record.audioUrl) ||
      (record.exactVariantSelection !== undefined &&
        typeof record.exactVariantSelection !== "boolean") ||
      (record.exactVariantSelection === true && record.variantUrl === undefined) ||
      !isOptionalExecutionSnapshotId(record.executionSnapshotId) ||
      (record.executionSnapshotId !== undefined && record.exactVariantSelection !== true) ||
      !isOptionalPositiveSafeInteger(record.authorizationExpiresAt)
    ) {
      return undefined;
    }
    return {
      type,
      ...identity,
      url: record.url,
      sizeCapBytes: record.sizeCapBytes,
      variantUrl: record.variantUrl,
      audioUrl: record.audioUrl,
      ...(record.exactVariantSelection === undefined
        ? {}
        : { exactVariantSelection: record.exactVariantSelection as boolean }),
      ...(record.executionSnapshotId === undefined
        ? {}
        : { executionSnapshotId: record.executionSnapshotId as string }),
      ...(record.authorizationExpiresAt === undefined
        ? {}
        : { authorizationExpiresAt: record.authorizationExpiresAt }),
    };
  }

  if (type === "dash-download-start") {
    const record = exactDataRecord(
      value,
      ["type", "jobId", "url", "sizeCapBytes"],
      [
        "attemptId",
        "videoRepresentationId",
        "executionSnapshotId",
        "authorizationExpiresAt",
      ],
    );
    const identity = record ? identityFrom(record) : undefined;
    if (
      !record ||
      !identity ||
      record.type !== type ||
      !isHttpUrl(record.url) ||
      !isPositiveSafeInteger(record.sizeCapBytes) ||
      !isOptionalRepresentationId(record.videoRepresentationId) ||
      !isOptionalExecutionSnapshotId(record.executionSnapshotId) ||
      (record.executionSnapshotId !== undefined &&
        record.videoRepresentationId === undefined) ||
      !isOptionalPositiveSafeInteger(record.authorizationExpiresAt)
    ) {
      return undefined;
    }
    return {
      type,
      ...identity,
      url: record.url,
      sizeCapBytes: record.sizeCapBytes,
      videoRepresentationId: record.videoRepresentationId,
      ...(record.executionSnapshotId === undefined
        ? {}
        : { executionSnapshotId: record.executionSnapshotId as string }),
      ...(record.authorizationExpiresAt === undefined
        ? {}
        : { authorizationExpiresAt: record.authorizationExpiresAt }),
    };
  }

  if (type === "webm-transcode-start") {
    const record = exactDataRecord(
      value,
      ["type", "jobId", "url", "sizeCapBytes"],
      ["attemptId", "authorizationExpiresAt"],
    );
    const identity = record ? identityFrom(record) : undefined;
    if (
      !record ||
      !identity ||
      record.type !== type ||
      !isHttpUrl(record.url) ||
      !isPositiveSafeInteger(record.sizeCapBytes) ||
      !isOptionalPositiveSafeInteger(record.authorizationExpiresAt)
    ) {
      return undefined;
    }
    return {
      type,
      ...identity,
      url: record.url,
      sizeCapBytes: record.sizeCapBytes,
      ...(record.authorizationExpiresAt === undefined
        ? {}
        : { authorizationExpiresAt: record.authorizationExpiresAt }),
    };
  }

  const controlTypes: readonly HeavyControlMessage["type"][] = [
    "hls-download-cancel",
    "hls-download-revoke",
    "dash-download-cancel",
    "dash-download-revoke",
    "webm-transcode-cancel",
    "webm-transcode-revoke",
  ];
  const isControlType = (candidate: string): candidate is HeavyControlMessage["type"] =>
    controlTypes.some((controlType) => controlType === candidate);
  if (typeof type === "string" && isControlType(type)) {
    const record = exactDataRecord(value, ["type", "jobId"], ["attemptId"]);
    const identity = record ? identityFrom(record) : undefined;
    if (!record || !identity || record.type !== type) return undefined;
    return { type, ...identity };
  }
  return undefined;
}

export function parseOffscreenIncomingMessage(value: unknown): OffscreenIncomingMessage | undefined {
  try {
    return parseOffscreenIncomingMessageUnsafe(value);
  } catch {
    return undefined;
  }
}

export function parseCaptureVariantInspectMessageV1(
  value: unknown,
): CaptureVariantInspectMessageV1 | undefined {
  try {
    const parsed = parseOffscreenIncomingMessageUnsafe(value);
    return parsed?.type === "capture-variant-inspect" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseCaptureExecutionSnapshotDiscardMessageV1(
  value: unknown,
): CaptureExecutionSnapshotDiscardMessageV1 | undefined {
  try {
    const parsed = parseOffscreenIncomingMessageUnsafe(value);
    return parsed?.type === "capture-execution-snapshot-discard" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseCaptureExecutionSnapshotDiscardResponseV1(
  value: unknown,
): CaptureExecutionSnapshotDiscardResponseV1 | undefined {
  try {
    const record = exactDataRecord(value, ["ok"]);
    return record?.ok === true ? { ok: true } : undefined;
  } catch {
    return undefined;
  }
}

export function parseCaptureVariantInspectResponseV1(
  value: unknown,
): CaptureVariantInspectResponseV1 | undefined {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const okDescriptor = Object.getOwnPropertyDescriptor(value, "ok");
    const ok = okDescriptor && "value" in okDescriptor ? okDescriptor.value : undefined;
    if (ok === true) {
      const record = exactDataRecord(value, ["ok", "variants"], ["executionSnapshotId"]);
      const variants = record ? parseRawVariantArray(record.variants) : undefined;
      if (
        !record ||
        !variants ||
        !isOptionalExecutionSnapshotId(record.executionSnapshotId)
      ) return undefined;
      return {
        ok: true,
        variants,
        ...(record.executionSnapshotId === undefined
          ? {}
          : { executionSnapshotId: record.executionSnapshotId }),
      };
    }
    if (ok === false) {
      const record = exactDataRecord(value, ["ok", "code"]);
      return record && isInspectErrorCode(record.code)
        ? { ok: false, code: record.code }
        : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type ClaimFailureCode = "CONCURRENT_LIMIT" | "DUPLICATE_ATTEMPT";

export type ActiveAttempt<Resource> = AttemptIdentity & {
  resource: Resource;
  blobUrl?: string;
};

export class OffscreenAttemptRegistry<Resource> {
  private readonly active = new Map<string, ActiveAttempt<Resource>>();
  private readonly seen = new Map<string, true>();

  constructor(
    private readonly maxActive = 1,
    private readonly maxSeen = 256,
    private readonly maxStatusEntries = 32,
  ) {
    if (
      !Number.isSafeInteger(maxActive) ||
      maxActive < 1 ||
      !Number.isSafeInteger(maxSeen) ||
      maxSeen < 1 ||
      !Number.isSafeInteger(maxStatusEntries) ||
      maxStatusEntries < 1
    ) {
      throw new TypeError("Offscreen attempt registry bounds must be positive safe integers.");
    }
  }

  private key(identity: AttemptIdentity): string {
    return JSON.stringify([identity.jobId, identity.attemptId ?? null]);
  }

  claim(
    identity: AttemptIdentity,
    resource: Resource,
  ): { ok: true; attempt: ActiveAttempt<Resource> } | { ok: false; code: ClaimFailureCode } {
    const key = this.key(identity);
    if (this.active.has(key) || this.seen.has(key)) {
      return { ok: false, code: "DUPLICATE_ATTEMPT" };
    }
    if (this.active.size >= this.maxActive) return { ok: false, code: "CONCURRENT_LIMIT" };
    const attempt: ActiveAttempt<Resource> = identity.attemptId === undefined
      ? { jobId: identity.jobId, resource }
      : { jobId: identity.jobId, attemptId: identity.attemptId, resource };
    this.active.set(key, attempt);
    return { ok: true, attempt };
  }

  get(identity: AttemptIdentity): ActiveAttempt<Resource> | undefined {
    return this.active.get(this.key(identity));
  }

  owns(identity: AttemptIdentity): boolean {
    return this.active.has(this.key(identity));
  }

  attachBlob(identity: AttemptIdentity, blobUrl: string): boolean {
    const attempt = this.get(identity);
    if (!attempt || attempt.blobUrl !== undefined) return false;
    attempt.blobUrl = blobUrl;
    return true;
  }

  release(identity: AttemptIdentity): ActiveAttempt<Resource> | undefined {
    const key = this.key(identity);
    const attempt = this.active.get(key);
    if (attempt) this.active.delete(key);
    this.seen.set(key, true);
    while (this.seen.size > this.maxSeen) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return attempt;
  }

  status(): AttemptIdentity[] {
    return [...this.active.values()].slice(0, this.maxStatusEntries).map((attempt) =>
      attempt.attemptId === undefined
        ? { jobId: attempt.jobId }
        : { jobId: attempt.jobId, attemptId: attempt.attemptId },
    );
  }
}
