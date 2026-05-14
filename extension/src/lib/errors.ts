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

export class MixedContainerAudioError extends HlsDownloadError {
  constructor() {
    super(
      "MIXED_CONTAINER_AUDIO",
      "This stream pairs fMP4 video with non-fMP4 audio. ClipHutch does not yet mux across container types.",
    );
    this.name = "MixedContainerAudioError";
  }
}

export class UnsupportedTsCodecError extends HlsDownloadError {
  constructor() {
    super(
      "UNSUPPORTED_TS_CODEC",
      "This HLS stream uses MPEG-TS codecs ClipHutch cannot repackage as MP4. ClipHutch currently supports H.264 video with AAC audio in MPEG-TS.",
    );
    this.name = "UnsupportedTsCodecError";
  }
}

export class EncryptedStreamError extends HlsDownloadError {
  constructor() {
    super(
      "ENCRYPTED",
      "This HLS stream is encrypted with AES-128 transport encryption. ClipHutch does not fetch encryption keys.",
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

// Preemptive refusal — the manifest declares a byte-range shape ClipHutch
// doesn't yet handle (e.g. DASH SegmentBase+indexRange). Distinct from the
// runtime errors below which fire after a Range request is actually sent.
export class ByteRangeError extends HlsDownloadError {
  constructor() {
    super(
      "BYTERANGE",
      "This stream uses a byte-range layout ClipHutch doesn't yet support.",
    );
    this.name = "ByteRangeError";
  }
}

export class ByteRangeUnsupportedError extends HlsDownloadError {
  constructor() {
    super(
      "BYTERANGE_UNSUPPORTED",
      "A server returned a full response to a byte-range request. The stream cannot be downloaded one segment at a time from this origin.",
    );
    this.name = "ByteRangeUnsupportedError";
  }
}

export class ByteRangeOutOfBoundsError extends HlsDownloadError {
  constructor() {
    super(
      "BYTERANGE_OUT_OF_BOUNDS",
      "A byte-range request fell outside the file's size. The manifest may be stale or the source file changed.",
    );
    this.name = "ByteRangeOutOfBoundsError";
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
      "This is a live stream. ClipHutch downloads on-demand (VOD) streams only.",
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
