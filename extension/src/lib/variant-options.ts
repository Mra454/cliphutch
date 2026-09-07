/**
 * Pure C7 manifest-variant normalization.
 *
 * `sourceId` is deliberately kept separate from the selector. For HLS it is
 * the manifest-produced playlist URL; for DASH it is the Representation ID.
 * UI/storage selectors contain only an opaque digest. A caller must resolve a
 * selector against a freshly fetched and normalized manifest before using the
 * returned `sourceId`; accepting a URL from the UI is never equivalent.
 */

export const MAX_NORMALIZED_VARIANT_OPTIONS = 100;
export const MAX_VARIANT_SOURCE_ID_LENGTH = 16_384;
export const MAX_VARIANT_DIMENSION = 100_000;
export const MAX_VARIANT_BANDWIDTH = 1_000_000_000_000;
export const MAX_VARIANT_DURATION_SEC = 31_536_000;

const MAX_DASH_SOURCE_ID_LENGTH = 256;
const MAX_CODECS_LENGTH = 512;
const MAX_CONTAINER_LENGTH = 64;
const CONTROL_OR_BIDI = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const STABLE_ID_PATTERN = /^variant-v1-(hls|dash)-[0-9a-f]{40}$/;
const CONTAINER_PATTERN = /^[a-z0-9][a-z0-9.+-]*(?:\/[a-z0-9][a-z0-9.+-]*)?$/;

export type NormalizedVariantKindV1 = "hls" | "dash";

export type VariantDisabledReasonV1 =
  | "drm"
  | "live"
  | "unsupported_codec"
  | "unsupported_container"
  | "unsupported_manifest_shape"
  | "unsupported_audio"
  | "permanent_download_failure"
  | "invalid_media";

export type NormalizedVariantSelectorV1 =
  | { kind: "hls"; stableId: string }
  | { kind: "dash"; stableId: string };

type NormalizedVariantBaseV1 = {
  stableId: string;
  sourceId: string;
  width?: number;
  height?: number;
  codecs?: string;
  container?: string;
  videoBandwidth?: number;
  audioBandwidth?: number;
  combinedBandwidth?: number;
  durationSec?: number;
  estimatedBytes?: number;
  estimateConfidence: "exact" | "estimated" | "unknown";
  supported: boolean;
  disabledReason?: VariantDisabledReasonV1;
};

export type NormalizedVariantV1 =
  | (NormalizedVariantBaseV1 & {
      kind: "hls";
      selector: { kind: "hls"; stableId: string };
    })
  | (NormalizedVariantBaseV1 & {
      kind: "dash";
      selector: { kind: "dash"; stableId: string };
    });

/**
 * The bandwidth shape is explicit so a missing default-audio bitrate cannot
 * accidentally be interpreted as zero.
 */
export type RawVariantBandwidthV1 =
  | { scope: "combined"; combinedBandwidth: number }
  | { scope: "video_only"; videoBandwidth: number }
  | {
      scope: "video_with_default_audio";
      videoBandwidth: number;
      audioBandwidth: number;
    }
  | { scope: "video_with_unknown_default_audio"; videoBandwidth: number }
  | { scope: "unknown" };

export type RawVariantOptionV1 = {
  sourceId: string;
  /** HLS default/separate audio URI used only as structural identity. */
  audioSourceId?: string;
  width?: number;
  height?: number;
  codecs?: string;
  container?: string;
  bandwidth: RawVariantBandwidthV1;
  durationSec?: number;
  /** A measured complete byte count, rather than a bitrate projection. */
  exactBytes?: number;
  disabledReason?: VariantDisabledReasonV1;
};

export type NormalizeVariantOptionsRequestV1 = {
  kind: NormalizedVariantKindV1;
  variants: RawVariantOptionV1[];
};

export type NormalizeVariantOptionsResultV1 =
  | { ok: true; options: NormalizedVariantV1[] }
  | {
      ok: false;
      code: "invalid_input" | "duplicate_source" | "identifier_failure";
      customerMessage: string;
    };

type DataRecord = Record<string, unknown>;

function copyDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): DataRecord | undefined {
  if (value === null || typeof value !== "object") return undefined;
  try {
    if (Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
      requiredKeys.some((key) => !ownKeys.includes(key))
    ) {
      return undefined;
    }
    const copy = Object.create(null) as DataRecord;
    for (const key of ownKeys) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch {
    return undefined;
  }
}

function copyDenseArray(value: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximum
    ) return undefined;
    const length = lengthDescriptor.value as number;
    const copy: unknown[] = [];
    const expectedKeys = new Set(["length"]);
    for (let index = 0; index < length; index += 1) expectedKeys.add(String(index));
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !expectedKeys.has(key))) {
      return undefined;
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      copy.push(descriptor.value);
    }
    return copy;
  } catch {
    return undefined;
  }
}

function positiveSafeInteger(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

function optionalPositiveSafeInteger(
  value: unknown,
  maximum: number,
): value is number | undefined {
  return value === undefined || positiveSafeInteger(value, maximum);
}

function validDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_VARIANT_DURATION_SEC
  );
}

function optionalDuration(value: unknown): value is number | undefined {
  return value === undefined || validDuration(value);
}

function optionalExactBytes(value: unknown): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function canonicalOptionalText(
  value: unknown,
  maximum: number,
  lowercase: boolean,
): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum || CONTROL_OR_BIDI.test(value)) {
    return null;
  }
  const canonical = value.trim();
  if (canonical.length === 0 || canonical.length > maximum) return null;
  return lowercase ? canonical.toLowerCase() : canonical;
}

const DISABLED_REASONS: readonly VariantDisabledReasonV1[] = [
  "drm",
  "live",
  "unsupported_codec",
  "unsupported_container",
  "unsupported_manifest_shape",
  "unsupported_audio",
  "permanent_download_failure",
  "invalid_media",
];

function validDisabledReason(value: unknown): value is VariantDisabledReasonV1 {
  return typeof value === "string" && DISABLED_REASONS.some((reason) => reason === value);
}

type CanonicalSource = {
  /** Safe structural identity retained in the normalized option. */
  sourceId: string;
  /** Ephemeral exact identity used only to reject ambiguous manifest entries. */
  privateIdentity: string;
};

function canonicalSource(
  kind: NormalizedVariantKindV1,
  value: unknown,
): CanonicalSource | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (CONTROL_OR_BIDI.test(value)) return undefined;
  if (kind === "dash") {
    return value.length <= MAX_DASH_SOURCE_ID_LENGTH
      ? { sourceId: value, privateIdentity: value }
      : undefined;
  }
  if (value.length > MAX_VARIANT_SOURCE_ID_LENGTH) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.hash = "";
    const privateIdentity = parsed.href;
    // Signed query strings and URL userinfo are neither stable selectors nor
    // safe persisted identifiers. Rendition/audio attributes below disambiguate
    // structural members that intentionally share a path.
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href.length <= MAX_VARIANT_SOURCE_ID_LENGTH
      ? { sourceId: parsed.href, privateIdentity }
      : undefined;
  } catch {
    return undefined;
  }
}

type CanonicalBandwidth = Pick<
  NormalizedVariantBaseV1,
  "videoBandwidth" | "audioBandwidth" | "combinedBandwidth"
>;

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function parseBandwidth(value: unknown): CanonicalBandwidth | undefined {
  const scope = readOwnDataProperty(value, "scope");
  // Read the discriminant once without invoking an accessor, then require the
  // exact shape for that branch.
  if (scope === "unknown") {
    return copyDataRecord(value, ["scope"], ["scope"]) ? {} : undefined;
  }
  if (scope === "combined") {
    const record = copyDataRecord(
      value,
      ["scope", "combinedBandwidth"],
      ["scope", "combinedBandwidth"],
    );
    return record && positiveSafeInteger(record.combinedBandwidth, MAX_VARIANT_BANDWIDTH)
      ? { combinedBandwidth: record.combinedBandwidth }
      : undefined;
  }
  if (scope === "video_only" || scope === "video_with_unknown_default_audio") {
    const record = copyDataRecord(
      value,
      ["scope", "videoBandwidth"],
      ["scope", "videoBandwidth"],
    );
    if (!record || !positiveSafeInteger(record.videoBandwidth, MAX_VARIANT_BANDWIDTH)) {
      return undefined;
    }
    return scope === "video_only"
      ? {
          videoBandwidth: record.videoBandwidth,
          combinedBandwidth: record.videoBandwidth,
        }
      : { videoBandwidth: record.videoBandwidth };
  }
  if (scope === "video_with_default_audio") {
    const record = copyDataRecord(
      value,
      ["scope", "videoBandwidth", "audioBandwidth"],
      ["scope", "videoBandwidth", "audioBandwidth"],
    );
    if (
      !record ||
      !positiveSafeInteger(record.videoBandwidth, MAX_VARIANT_BANDWIDTH) ||
      !positiveSafeInteger(record.audioBandwidth, MAX_VARIANT_BANDWIDTH) ||
      record.videoBandwidth > MAX_VARIANT_BANDWIDTH - record.audioBandwidth
    ) {
      return undefined;
    }
    return {
      videoBandwidth: record.videoBandwidth,
      audioBandwidth: record.audioBandwidth,
      combinedBandwidth: record.videoBandwidth + record.audioBandwidth,
    };
  }
  return undefined;
}

type CanonicalRawVariant = Omit<
  NormalizedVariantBaseV1,
  "stableId" | "estimatedBytes" | "estimateConfidence" | "supported"
> & {
  exactBytes?: number;
  audioSourceId?: string;
  privateSourceIdentity: string;
  privateAudioIdentity?: string;
};

function parseRawVariant(
  kind: NormalizedVariantKindV1,
  value: unknown,
): CanonicalRawVariant | undefined {
  const record = copyDataRecord(
    value,
    [
      "sourceId",
      "audioSourceId",
      "width",
      "height",
      "codecs",
      "container",
      "bandwidth",
      "durationSec",
      "exactBytes",
      "disabledReason",
    ],
    ["sourceId", "bandwidth"],
  );
  if (!record) return undefined;
  const source = canonicalSource(kind, record.sourceId);
  const audioSource = record.audioSourceId === undefined
    ? undefined
    : kind === "hls"
      ? canonicalSource("hls", record.audioSourceId)
      : undefined;
  const codecs = canonicalOptionalText(record.codecs, MAX_CODECS_LENGTH, false);
  const container = canonicalOptionalText(record.container, MAX_CONTAINER_LENGTH, true);
  const bandwidth = parseBandwidth(record.bandwidth);
  if (
    !source ||
    (record.audioSourceId !== undefined && !audioSource) ||
    !optionalPositiveSafeInteger(record.width, MAX_VARIANT_DIMENSION) ||
    !optionalPositiveSafeInteger(record.height, MAX_VARIANT_DIMENSION) ||
    codecs === null ||
    container === null ||
    (container !== undefined && !CONTAINER_PATTERN.test(container)) ||
    !bandwidth ||
    !optionalDuration(record.durationSec) ||
    !optionalExactBytes(record.exactBytes) ||
    (record.disabledReason !== undefined && !validDisabledReason(record.disabledReason))
  ) {
    return undefined;
  }
  return {
    sourceId: source.sourceId,
    privateSourceIdentity: source.privateIdentity,
    ...(audioSource === undefined
      ? {}
      : {
          audioSourceId: audioSource.sourceId,
          privateAudioIdentity: audioSource.privateIdentity,
        }),
    ...(record.width === undefined ? {} : { width: record.width }),
    ...(record.height === undefined ? {} : { height: record.height }),
    ...(codecs === undefined ? {} : { codecs }),
    ...(container === undefined ? {} : { container }),
    ...bandwidth,
    ...(record.durationSec === undefined ? {} : { durationSec: record.durationSec }),
    ...(record.exactBytes === undefined ? {} : { exactBytes: record.exactBytes }),
    ...(record.disabledReason === undefined
      ? {}
      : { disabledReason: record.disabledReason as VariantDisabledReasonV1 }),
  };
}

function conservativeEstimatedBytes(
  combinedBandwidth: number | undefined,
  durationSec: number | undefined,
): number | undefined {
  if (combinedBandwidth === undefined || durationSec === undefined) return undefined;
  const estimate = Math.ceil(combinedBandwidth * (durationSec / 8));
  return Number.isSafeInteger(estimate) && estimate >= 0 ? estimate : undefined;
}

async function sha256Hex(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function stableIdFor(
  kind: NormalizedVariantKindV1,
  structuralIdentity: string,
): Promise<string> {
  const digest = await sha256Hex(
    `cliphutch-variant-v1\u0000${kind}\u0000${structuralIdentity}`,
  );
  return `variant-v1-${kind}-${digest.slice(0, 40)}`;
}

function rawFingerprint(value: CanonicalRawVariant): string {
  return JSON.stringify(value);
}

function selectorStructuralIdentity(
  kind: NormalizedVariantKindV1,
  value: CanonicalRawVariant,
): string {
  return JSON.stringify({
    kind,
    sourceId: value.sourceId,
    ...(value.audioSourceId === undefined ? {} : { audioSourceId: value.audioSourceId }),
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
    ...(value.codecs === undefined ? {} : { codecs: value.codecs }),
    ...(value.container === undefined ? {} : { container: value.container }),
    ...(value.videoBandwidth === undefined ? {} : { videoBandwidth: value.videoBandwidth }),
    ...(value.audioBandwidth === undefined ? {} : { audioBandwidth: value.audioBandwidth }),
    ...(value.combinedBandwidth === undefined
      ? {}
      : { combinedBandwidth: value.combinedBandwidth }),
  });
}

/** Strictly guards, canonicalizes, deduplicates, and identifies raw variants. */
export async function normalizeVariantOptionsV1(
  value: unknown,
): Promise<NormalizeVariantOptionsResultV1> {
  const request = copyDataRecord(value, ["kind", "variants"], ["kind", "variants"]);
  if (!request || (request.kind !== "hls" && request.kind !== "dash")) {
    return {
      ok: false,
      code: "invalid_input",
      customerMessage: "ClipHutch received invalid stream quality information.",
    };
  }
  const rawVariants = copyDenseArray(request.variants, MAX_NORMALIZED_VARIANT_OPTIONS);
  if (!rawVariants) {
    return {
      ok: false,
      code: "invalid_input",
      customerMessage: "ClipHutch received invalid stream quality information.",
    };
  }

  const kind = request.kind;
  const parsed: CanonicalRawVariant[] = [];
  const selectorFingerprints = new Map<string, string>();
  const dashSourceFingerprints = new Map<string, string>();
  for (const rawVariant of rawVariants) {
    const canonical = parseRawVariant(kind, rawVariant);
    if (!canonical) {
      return {
        ok: false,
        code: "invalid_input",
        customerMessage: "ClipHutch received invalid stream quality information.",
      };
    }
    const fingerprint = rawFingerprint(canonical);
    if (kind === "dash") {
      const previousSource = dashSourceFingerprints.get(canonical.sourceId);
      if (previousSource !== undefined && previousSource !== fingerprint) {
        return {
          ok: false,
          code: "duplicate_source",
          customerMessage: "The stream describes one quality inconsistently.",
        };
      }
      dashSourceFingerprints.set(canonical.sourceId, fingerprint);
    }
    const structuralIdentity = selectorStructuralIdentity(kind, canonical);
    const previous = selectorFingerprints.get(structuralIdentity);
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        return {
          ok: false,
          code: "duplicate_source",
          customerMessage: "The stream describes one quality inconsistently.",
        };
      }
      continue;
    }
    selectorFingerprints.set(structuralIdentity, fingerprint);
    parsed.push(canonical);
  }

  try {
    const options = await Promise.all(parsed.map(async (raw): Promise<NormalizedVariantV1> => {
      const stableId = await stableIdFor(kind, selectorStructuralIdentity(kind, raw));
      const exactBytes = raw.exactBytes;
      const projectedBytes = exactBytes === undefined
        ? conservativeEstimatedBytes(raw.combinedBandwidth, raw.durationSec)
        : undefined;
      const estimateConfidence = exactBytes !== undefined
        ? "exact" as const
        : projectedBytes !== undefined
          ? "estimated" as const
          : "unknown" as const;
      const common: NormalizedVariantBaseV1 = {
        stableId,
        sourceId: raw.sourceId,
        ...(raw.width === undefined ? {} : { width: raw.width }),
        ...(raw.height === undefined ? {} : { height: raw.height }),
        ...(raw.codecs === undefined ? {} : { codecs: raw.codecs }),
        ...(raw.container === undefined ? {} : { container: raw.container }),
        ...(raw.videoBandwidth === undefined ? {} : { videoBandwidth: raw.videoBandwidth }),
        ...(raw.audioBandwidth === undefined ? {} : { audioBandwidth: raw.audioBandwidth }),
        ...(raw.combinedBandwidth === undefined
          ? {}
          : { combinedBandwidth: raw.combinedBandwidth }),
        ...(raw.durationSec === undefined ? {} : { durationSec: raw.durationSec }),
        ...(exactBytes !== undefined
          ? { estimatedBytes: exactBytes }
          : projectedBytes === undefined
            ? {}
            : { estimatedBytes: projectedBytes }),
        estimateConfidence,
        supported: raw.disabledReason === undefined,
        ...(raw.disabledReason === undefined ? {} : { disabledReason: raw.disabledReason }),
      };
      return kind === "hls"
        ? { ...common, kind: "hls", selector: { kind: "hls", stableId } }
        : { ...common, kind: "dash", selector: { kind: "dash", stableId } };
    }));
    if (new Set(options.map((option) => option.stableId)).size !== options.length) {
      return {
        ok: false,
        code: "identifier_failure",
        customerMessage: "ClipHutch could not safely identify the available qualities.",
      };
    }
    return { ok: true, options };
  } catch {
    return {
      ok: false,
      code: "identifier_failure",
      customerMessage: "ClipHutch could not safely identify the available qualities.",
    };
  }
}

function parseSelectorForKind(
  value: unknown,
  expectedKind?: NormalizedVariantKindV1,
): NormalizedVariantSelectorV1 | undefined {
  const record = copyDataRecord(value, ["kind", "stableId"], ["kind", "stableId"]);
  if (
    !record ||
    (record.kind !== "hls" && record.kind !== "dash") ||
    (expectedKind !== undefined && record.kind !== expectedKind) ||
    typeof record.stableId !== "string" ||
    !STABLE_ID_PATTERN.test(record.stableId) ||
    !record.stableId.startsWith(`variant-v1-${record.kind}-`)
  ) {
    return undefined;
  }
  return record.kind === "hls"
    ? { kind: "hls", stableId: record.stableId }
    : { kind: "dash", stableId: record.stableId };
}

export function parseNormalizedVariantSelectorV1(
  value: unknown,
): NormalizedVariantSelectorV1 | undefined {
  try {
    return parseSelectorForKind(value);
  } catch {
    return undefined;
  }
}

const NORMALIZED_OPTION_KEYS = [
  "kind",
  "selector",
  "stableId",
  "sourceId",
  "width",
  "height",
  "codecs",
  "container",
  "videoBandwidth",
  "audioBandwidth",
  "combinedBandwidth",
  "durationSec",
  "estimatedBytes",
  "estimateConfidence",
  "supported",
  "disabledReason",
] as const;

function parseNormalizedVariant(value: unknown): NormalizedVariantV1 | undefined {
  const record = copyDataRecord(
    value,
    NORMALIZED_OPTION_KEYS,
    [
      "kind",
      "selector",
      "stableId",
      "sourceId",
      "estimateConfidence",
      "supported",
    ],
  );
  if (!record || (record.kind !== "hls" && record.kind !== "dash")) return undefined;
  const selector = parseSelectorForKind(record.selector, record.kind);
  const source = canonicalSource(record.kind, record.sourceId);
  const codecs = canonicalOptionalText(record.codecs, MAX_CODECS_LENGTH, false);
  const container = canonicalOptionalText(record.container, MAX_CONTAINER_LENGTH, true);
  if (
    !selector ||
    typeof record.stableId !== "string" ||
    record.stableId !== selector.stableId ||
    !source ||
    source.sourceId !== record.sourceId ||
    source.privateIdentity !== record.sourceId ||
    !optionalPositiveSafeInteger(record.width, MAX_VARIANT_DIMENSION) ||
    !optionalPositiveSafeInteger(record.height, MAX_VARIANT_DIMENSION) ||
    codecs === null ||
    codecs !== record.codecs ||
    container === null ||
    container !== record.container ||
    (container !== undefined && !CONTAINER_PATTERN.test(container)) ||
    !optionalPositiveSafeInteger(record.videoBandwidth, MAX_VARIANT_BANDWIDTH) ||
    !optionalPositiveSafeInteger(record.audioBandwidth, MAX_VARIANT_BANDWIDTH) ||
    !optionalPositiveSafeInteger(record.combinedBandwidth, MAX_VARIANT_BANDWIDTH) ||
    !optionalDuration(record.durationSec) ||
    !optionalExactBytes(record.estimatedBytes) ||
    (record.estimateConfidence !== "exact" &&
      record.estimateConfidence !== "estimated" &&
      record.estimateConfidence !== "unknown") ||
    typeof record.supported !== "boolean" ||
    (record.disabledReason !== undefined && !validDisabledReason(record.disabledReason))
  ) {
    return undefined;
  }
  if (
    (record.supported && record.disabledReason !== undefined) ||
    (!record.supported && record.disabledReason === undefined) ||
    (record.estimateConfidence === "unknown" && record.estimatedBytes !== undefined) ||
    (record.estimateConfidence !== "unknown" && record.estimatedBytes === undefined) ||
    (record.estimateConfidence === "estimated" &&
      (record.combinedBandwidth === undefined || record.durationSec === undefined)) ||
    (record.audioBandwidth !== undefined && record.videoBandwidth === undefined)
  ) {
    return undefined;
  }
  if (
    record.estimateConfidence === "estimated" &&
    conservativeEstimatedBytes(record.combinedBandwidth, record.durationSec) !==
      record.estimatedBytes
  ) {
    return undefined;
  }
  if (
    record.videoBandwidth !== undefined &&
    record.audioBandwidth !== undefined &&
    (record.videoBandwidth > MAX_VARIANT_BANDWIDTH - record.audioBandwidth ||
      record.combinedBandwidth !== record.videoBandwidth + record.audioBandwidth)
  ) {
    return undefined;
  }
  if (
    record.videoBandwidth !== undefined &&
    record.audioBandwidth === undefined &&
    record.combinedBandwidth !== undefined &&
    record.combinedBandwidth !== record.videoBandwidth
  ) {
    return undefined;
  }
  const common: NormalizedVariantBaseV1 = {
    stableId: record.stableId,
    sourceId: source.sourceId,
    ...(record.width === undefined ? {} : { width: record.width }),
    ...(record.height === undefined ? {} : { height: record.height }),
    ...(record.codecs === undefined ? {} : { codecs: record.codecs as string }),
    ...(record.container === undefined ? {} : { container: record.container as string }),
    ...(record.videoBandwidth === undefined ? {} : { videoBandwidth: record.videoBandwidth }),
    ...(record.audioBandwidth === undefined ? {} : { audioBandwidth: record.audioBandwidth }),
    ...(record.combinedBandwidth === undefined
      ? {}
      : { combinedBandwidth: record.combinedBandwidth }),
    ...(record.durationSec === undefined ? {} : { durationSec: record.durationSec }),
    ...(record.estimatedBytes === undefined ? {} : { estimatedBytes: record.estimatedBytes }),
    estimateConfidence: record.estimateConfidence,
    supported: record.supported,
    ...(record.disabledReason === undefined
      ? {}
      : { disabledReason: record.disabledReason as VariantDisabledReasonV1 }),
  };
  return record.kind === "hls"
    ? { ...common, kind: "hls", selector: { kind: "hls", stableId: record.stableId } }
    : { ...common, kind: "dash", selector: { kind: "dash", stableId: record.stableId } };
}

/** Guards and returns deep canonical clones of normalized cross-context data. */
export function parseNormalizedVariantOptionsV1(
  value: unknown,
): NormalizedVariantV1[] | undefined {
  const raw = copyDenseArray(value, MAX_NORMALIZED_VARIANT_OPTIONS);
  if (!raw) return undefined;
  const options: NormalizedVariantV1[] = [];
  const stableIds = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const item of raw) {
    const option = parseNormalizedVariant(item);
    if (!option) return undefined;
    const sourceKey = `${option.kind}\u0000${option.sourceId}`;
    if (
      stableIds.has(option.stableId) ||
      (option.kind === "dash" && sourceKeys.has(sourceKey))
    ) return undefined;
    stableIds.add(option.stableId);
    sourceKeys.add(sourceKey);
    options.push(option);
  }
  return options;
}

/**
 * Resolves an opaque selector only by membership in a canonical, freshly
 * normalized manifest. Raw URLs are not valid selectors.
 */
export function resolveNormalizedVariantSelectorV1(
  optionsValue: unknown,
  selectorValue: unknown,
): NormalizedVariantV1 | undefined {
  try {
    const options = parseNormalizedVariantOptionsV1(optionsValue);
    const selector = parseNormalizedVariantSelectorV1(selectorValue);
    if (!options || !selector) return undefined;
    return options.find(
      (option) => option.kind === selector.kind && option.stableId === selector.stableId,
    );
  } catch {
    return undefined;
  }
}
