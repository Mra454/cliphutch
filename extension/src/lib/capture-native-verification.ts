export type CaptureNativeMediaKind = "direct" | "image";

export type CaptureNativeVerification =
  | {
      status: "verified";
      contentType: string;
      sizeBytes?: number;
    }
  | {
      status: "unverified";
      reason: "missing_content_type" | "generic_content_type";
      sizeBytes?: number;
    }
  | {
      status: "mismatch";
      expectedContentType?: string;
      observedContentType: string;
    };

const GENERIC_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/binary",
  "application/force-download",
  "binary/octet-stream",
]);

const CONTENT_TYPE_ALIASES = new Map([
  ["image/jpg", "image/jpeg"],
  ["image/pjpeg", "image/jpeg"],
  ["image/x-png", "image/png"],
  ["image/x-webp", "image/webp"],
  ["video/x-m4v", "video/mp4"],
]);

function normalizeContentType(value: string | undefined): string | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (!normalized || normalized.length > 256) return undefined;
  return CONTENT_TYPE_ALIASES.get(normalized) ?? normalized;
}

function matchesKind(kind: CaptureNativeMediaKind, contentType: string): boolean {
  return kind === "image"
    ? contentType.startsWith("image/")
    : contentType.startsWith("video/");
}

/**
 * Compares a fresh bounded response with the exact reviewed media type.
 *
 * A generic or absent response type can confirm availability, but it cannot
 * prove that the media representation is unchanged. A specific subtype change
 * is stale even when both values are broadly video/* or image/*; otherwise an
 * MP4 URL returning WebM bytes could retain an MP4 filename and bypass the
 * conversion policy.
 */
export function verifyCaptureNativeMedia(input: {
  kind: CaptureNativeMediaKind;
  expectedContentType?: string;
  observedContentType?: string;
  observedSizeBytes?: number;
}): CaptureNativeVerification {
  const expected = normalizeContentType(input.expectedContentType);
  const observed = normalizeContentType(input.observedContentType);
  const sizeBytes = Number.isSafeInteger(input.observedSizeBytes) &&
    (input.observedSizeBytes ?? -1) > 0
    ? input.observedSizeBytes
    : undefined;

  if (observed === undefined) {
    return {
      status: "unverified",
      reason: "missing_content_type",
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    };
  }
  if (GENERIC_CONTENT_TYPES.has(observed)) {
    return {
      status: "unverified",
      reason: "generic_content_type",
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
    };
  }
  if (!matchesKind(input.kind, observed)) {
    return {
      status: "mismatch",
      ...(expected === undefined ? {} : { expectedContentType: expected }),
      observedContentType: observed,
    };
  }
  if (
    expected !== undefined &&
    !GENERIC_CONTENT_TYPES.has(expected) &&
    expected !== observed
  ) {
    return {
      status: "mismatch",
      expectedContentType: expected,
      observedContentType: observed,
    };
  }
  return {
    status: "verified",
    contentType: observed,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
  };
}
