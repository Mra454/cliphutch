import { describe, expect, it } from "vitest";
import { classifyHlsManifestForDrm } from "./drm";

describe("classifyHlsManifestForDrm", () => {
  it("returns not protected for empty text", () => {
    expect(classifyHlsManifestForDrm("")).toEqual({ protected: false });
  });

  it("returns not protected for a manifest with no EXT-X-KEY tags", () => {
    const m = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg-001.ts
#EXTINF:6.0,
seg-002.ts
#EXT-X-ENDLIST`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: false });
  });

  it("returns not protected for METHOD=NONE", () => {
    const m = `#EXTM3U
#EXT-X-KEY:METHOD=NONE
#EXTINF:6.0,
seg-001.ts`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: false });
  });

  it("returns not protected for plain AES-128 with no KEYFORMAT (legacy default)", () => {
    const m = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key.bin",IV=0x1234
#EXTINF:6.0,
seg-001.ts`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: false });
  });

  it('returns not protected for KEYFORMAT="identity"', () => {
    const m = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key.bin",KEYFORMAT="identity"
#EXTINF:6.0,
seg-001.ts`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: false });
  });

  it("flags Widevine in EXT-X-SESSION-KEY (master playlist)", () => {
    const m = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="data:text/plain;base64,..."
#EXT-X-STREAM-INF:BANDWIDTH=1000000
variant.m3u8`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: true, scheme: "widevine" });
  });

  it("flags PlayReady in EXT-X-SESSION-KEY", () => {
    const m = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95",URI="data:text/plain;base64,..."
#EXT-X-STREAM-INF:BANDWIDTH=1000000
variant.m3u8`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: true, scheme: "playready" });
  });

  it("flags FairPlay via com.apple.streamingkeydelivery", () => {
    const m = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://example.com/license"
#EXTINF:6.0,
seg-001.ts`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: true, scheme: "fairplay" });
  });

  it("flags ClearKey", () => {
    const m = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e",URI="https://example.com/clearkey"
#EXTINF:6.0,
seg-001.ts`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: true, scheme: "clearkey" });
  });

  it("flags an unknown DRM KEYFORMAT as protected with scheme=unknown", () => {
    const m = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:00000000-0000-0000-0000-000000000000",URI="data:text/plain;base64,..."
#EXTINF:6.0,
seg-001.ts`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: true, scheme: "unknown" });
  });

  it("is case-insensitive on tag prefix and KEYFORMAT UUID", () => {
    const m = `#EXTM3U
#ext-x-key:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED",URI="data:..."
#EXTINF:6.0,
seg-001.ts`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: true, scheme: "widevine" });
  });

  it("ignores EXT-X-KEY appearing inside an attribute string of an unrelated tag", () => {
    // A line that mentions EXT-X-KEY in an EXTINF title shouldn't trigger.
    const m = `#EXTM3U
#EXTINF:6.0,Title mentions EXT-X-KEY but is not a tag
seg-001.ts`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: false });
  });

  it("returns the first DRM hit if multiple keys are present", () => {
    const m = `#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://..."
#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="data:..."
#EXTINF:6.0,
seg-001.ts`;
    expect(classifyHlsManifestForDrm(m)).toEqual({ protected: true, scheme: "fairplay" });
  });
});
