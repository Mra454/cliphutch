// Pure classifier: given an HLS manifest text (master or variant), return
// whether the stream is protected by a DRM scheme (Widevine, PlayReady,
// FairPlay, ClearKey) — as distinct from plain AES-128 transport encryption,
// which uses KEYFORMAT="identity" or omits KEYFORMAT entirely. DRM-keyformat
// streams are never downloadable from a browser context (the segments are
// encrypted with keys exchanged via EME and decrypted in a CDM/TEE we cannot
// reach). Plain AES-128 falls through to EncryptedStreamError so v2 can
// potentially decrypt it.

export type DrmScheme = "widevine" | "playready" | "fairplay" | "clearkey" | "unknown";

export type DrmCheck = { protected: boolean; scheme?: DrmScheme };

const SCHEME_MARKERS: Array<[string, DrmScheme]> = [
  ["urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", "widevine"],
  ["urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", "playready"],
  ["com.apple.streamingkeydelivery", "fairplay"],
  ["urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e", "clearkey"],
];

export function classifyHlsManifestForDrm(text: string): DrmCheck {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    if (!upper.startsWith("#EXT-X-KEY") && !upper.startsWith("#EXT-X-SESSION-KEY")) {
      continue;
    }
    const methodMatch = /METHOD\s*=\s*([^,\s]+)/i.exec(trimmed);
    if (!methodMatch) continue;
    const method = methodMatch[1].trim().toUpperCase();
    if (method === "NONE") continue;

    const keyFormatMatch = /KEYFORMAT\s*=\s*"([^"]+)"/i.exec(trimmed);
    if (!keyFormatMatch) continue;
    const keyFormat = keyFormatMatch[1].toLowerCase();
    if (keyFormat === "identity") continue;

    for (const [marker, scheme] of SCHEME_MARKERS) {
      if (keyFormat.includes(marker.toLowerCase())) {
        return { protected: true, scheme };
      }
    }
    return { protected: true, scheme: "unknown" };
  }
  return { protected: false };
}
