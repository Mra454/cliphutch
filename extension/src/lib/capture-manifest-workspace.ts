import {
  isCaptureManifestRecordV1,
  type CaptureManifestOutputV1,
  type CaptureManifestPublicErrorCode,
  type CaptureManifestRecordV1,
} from "./capture-manifest-delivery";
import type { CaptureManifestFormatV1 } from "./capture-pack-types";

export const MAX_CAPTURE_WORKSPACE_MANIFESTS = 30;

export type CaptureWorkspaceManifestOutputV1 =
  | { format: CaptureManifestFormatV1; state: "pending" }
  | { format: CaptureManifestFormatV1; state: "saving"; downloadId?: number }
  | { format: CaptureManifestFormatV1; state: "complete"; downloadId: number }
  | {
      format: CaptureManifestFormatV1;
      state: "failed";
      errorCode: CaptureManifestPublicErrorCode;
      retryable: boolean;
      downloadId?: number;
    };

/**
 * Deliberately omits the manifest seed, URLs, paths, item metadata, attempt
 * IDs, and raw errors. Activity needs only bounded delivery state.
 */
export type CaptureWorkspaceManifestV1 = {
  runId: string;
  outputs: CaptureWorkspaceManifestOutputV1[];
};

const SAFE_ID_PATTERN = /^[a-z0-9._:-]+$/i;
const MAX_ID_LENGTH = 256;
const PUBLIC_ERROR_CODES = new Set<CaptureManifestPublicErrorCode>([
  "MANIFEST_SERIALIZE_FAILED",
  "MANIFEST_BLOB_FAILED",
  "MANIFEST_SAVE_FAILED",
  "MANIFEST_SAVE_STATE_UNKNOWN",
  "MANIFEST_CANCELLED",
  "UNKNOWN",
]);

type DataRecord = Record<string, unknown>;

function dataRecord(value: unknown): DataRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    const result = Object.create(null) as DataRecord;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function hasOnlyKeys(record: DataRecord, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(value);
}

function safeDownloadId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseOutput(value: unknown): CaptureWorkspaceManifestOutputV1 | undefined {
  const record = dataRecord(value);
  if (!record || (record.format !== "json" && record.format !== "csv")) return undefined;
  if (record.state === "pending") {
    return hasOnlyKeys(record, ["format", "state"])
      ? { format: record.format, state: "pending" }
      : undefined;
  }
  if (record.state === "saving") {
    if (
      !hasOnlyKeys(record, ["format", "state", "downloadId"]) ||
      (record.downloadId !== undefined && !safeDownloadId(record.downloadId))
    ) return undefined;
    return {
      format: record.format,
      state: "saving",
      ...(record.downloadId === undefined ? {} : { downloadId: record.downloadId }),
    };
  }
  if (record.state === "complete") {
    return hasOnlyKeys(record, ["format", "state", "downloadId"]) &&
      safeDownloadId(record.downloadId)
      ? { format: record.format, state: "complete", downloadId: record.downloadId }
      : undefined;
  }
  if (record.state !== "failed") return undefined;
  if (
    !hasOnlyKeys(record, ["format", "state", "errorCode", "retryable", "downloadId"]) ||
    typeof record.errorCode !== "string" ||
    !PUBLIC_ERROR_CODES.has(record.errorCode as CaptureManifestPublicErrorCode) ||
    typeof record.retryable !== "boolean" ||
    (record.downloadId !== undefined && !safeDownloadId(record.downloadId))
  ) return undefined;
  return {
    format: record.format,
    state: "failed",
    errorCode: record.errorCode as CaptureManifestPublicErrorCode,
    retryable: record.retryable,
    ...(record.downloadId === undefined ? {} : { downloadId: record.downloadId }),
  };
}

function outputSummary(output: CaptureManifestOutputV1): CaptureWorkspaceManifestOutputV1 {
  if (output.state === "pending") return { format: output.format, state: "pending" };
  if (output.state === "saving") {
    return {
      format: output.format,
      state: "saving",
      ...(output.downloadId === undefined ? {} : { downloadId: output.downloadId }),
    };
  }
  if (output.state === "complete") {
    return { format: output.format, state: "complete", downloadId: output.downloadId };
  }
  return {
    format: output.format,
    state: "failed",
    errorCode: output.errorCode,
    retryable: output.retryable,
    ...(output.downloadId === undefined ? {} : { downloadId: output.downloadId }),
  };
}

export function createCaptureWorkspaceManifest(
  value: unknown,
): CaptureWorkspaceManifestV1 | undefined {
  if (!isCaptureManifestRecordV1(value)) return undefined;
  const record: CaptureManifestRecordV1 = value;
  return {
    runId: record.seed.runId,
    outputs: record.seed.formats.map((format) => outputSummary(record.outputs[format]!)),
  };
}

export function parseCaptureWorkspaceManifests(
  value: unknown,
): CaptureWorkspaceManifestV1[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length > MAX_CAPTURE_WORKSPACE_MANIFESTS) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some((key) => typeof key !== "string")) {
      return undefined;
    }
    const manifests: CaptureWorkspaceManifestV1[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      const record = dataRecord(descriptor.value);
      if (!record || !hasOnlyKeys(record, ["runId", "outputs"]) || !safeId(record.runId) ||
        !Array.isArray(record.outputs) ||
        Object.getPrototypeOf(record.outputs) !== Array.prototype ||
        record.outputs.length < 1 || record.outputs.length > 2) {
        return undefined;
      }
      const outputKeys = Reflect.ownKeys(record.outputs);
      if (
        outputKeys.length !== record.outputs.length + 1 ||
        outputKeys.some((key) => typeof key !== "string")
      ) return undefined;
      const outputs: CaptureWorkspaceManifestOutputV1[] = [];
      for (let outputIndex = 0; outputIndex < record.outputs.length; outputIndex += 1) {
        const outputDescriptor = Object.getOwnPropertyDescriptor(
          record.outputs,
          String(outputIndex),
        );
        if (!outputDescriptor || !("value" in outputDescriptor)) return undefined;
        const output = parseOutput(outputDescriptor.value);
        if (!output) return undefined;
        outputs.push(output);
      }
      if (outputs[0]?.format !== "json" ||
        (outputs.length === 2 && outputs[1]?.format !== "csv")) return undefined;
      manifests.push({ runId: record.runId, outputs });
    }
    return new Set(manifests.map((manifest) => manifest.runId)).size === manifests.length
      ? manifests
      : undefined;
  } catch {
    return undefined;
  }
}
