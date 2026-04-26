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
      "This HLS stream is encrypted. v1 does not decrypt encrypted streams. This may be DRM or standard HLS encryption.",
    );
    this.name = "EncryptedStreamError";
  }
}

export class FmpfourError extends HlsDownloadError {
  constructor() {
    super(
      "FMP4",
      "This HLS stream uses fMP4 segments (CMAF). v1 supports MPEG-TS only.",
    );
    this.name = "FmpfourError";
  }
}

export class ByteRangeError extends HlsDownloadError {
  constructor() {
    super(
      "BYTERANGE",
      "This HLS stream uses byte-range segments. v1 does not support byte-range fetching.",
    );
    this.name = "ByteRangeError";
  }
}

export class LiveStreamError extends HlsDownloadError {
  constructor() {
    super(
      "LIVE",
      "This is a live HLS stream. v1 supports VOD streams only.",
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
