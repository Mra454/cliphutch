export class HlsDownloadError extends Error {
  code: string;
  userMessage: string;
  constructor(code: string, userMessage: string, message?: string) {
    super(message ?? userMessage);
    this.name = "HlsDownloadError";
    this.code = code;
    this.userMessage = userMessage;
  }
}

export class SeparateAudioError extends HlsDownloadError {
  constructor() {
    super(
      "SEPARATE_AUDIO",
      "This HLS stream uses separate audio renditions. v1 supports only streams with embedded audio.",
    );
    this.name = "SeparateAudioError";
  }
}

export class EncryptedStreamError extends HlsDownloadError {
  constructor() {
    super(
      "ENCRYPTED",
      "This HLS stream is encrypted (AES-128 transport encryption). v1 does not fetch and apply encryption keys.",
    );
    this.name = "EncryptedStreamError";
  }
}

export class DrmProtectedError extends HlsDownloadError {
  scheme?: string;
  constructor(scheme?: string) {
    const schemeLabel = scheme && scheme !== "unknown" ? ` (${scheme})` : "";
    super(
      "DRM_PROTECTED",
      `This stream is DRM-protected${schemeLabel} and cannot be downloaded.`,
    );
    this.name = "DrmProtectedError";
    this.scheme = scheme;
  }
}

export class ByteRangeError extends HlsDownloadError {
  constructor() {
    super(
      "BYTERANGE",
      "This stream uses byte-range segments. v1 does not support byte-range fetching.",
    );
    this.name = "ByteRangeError";
  }
}

export class EmptyManifestError extends HlsDownloadError {
  constructor() {
    super(
      "EMPTY",
      "The manifest contained no usable video representations.",
    );
    this.name = "EmptyManifestError";
  }
}

export class LiveStreamError extends HlsDownloadError {
  constructor() {
    super(
      "LIVE",
      "This is a live stream. v1 supports VOD streams only.",
    );
    this.name = "LiveStreamError";
  }
}

export class SizeCapError extends HlsDownloadError {
  constructor(capBytes: number) {
    const mb = Math.round(capBytes / (1024 * 1024));
    super("SIZE_CAP", `Estimated size exceeds the configured cap of ${mb}MB.`);
    this.name = "SizeCapError";
  }
}

export class AccessDeniedError extends HlsDownloadError {
  constructor() {
    super(
      "ACCESS_DENIED",
      "The stream was detected, but one or more playlist or segment requests were denied. The site may require request headers, a referrer, cookies, or a short-lived URL this extension does not store.",
    );
    this.name = "AccessDeniedError";
  }
}

export class NetworkError extends HlsDownloadError {
  constructor(detail?: string) {
    super("NETWORK", `Network error while fetching the playlist or a segment.${detail ? ` ${detail}` : ""}`);
    this.name = "NetworkError";
  }
}

export class ParseError extends HlsDownloadError {
  constructor() {
    super("PARSE", "Could not parse the HLS playlist.");
    this.name = "ParseError";
  }
}

export class CancelledError extends HlsDownloadError {
  constructor() {
    super("CANCELLED", "Download cancelled.");
    this.name = "CancelledError";
  }
}
