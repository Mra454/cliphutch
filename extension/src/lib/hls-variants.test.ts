import { describe, expect, it } from "vitest";
import { isMasterPlaylist, parseMasterVariants } from "./hls-variants";

const MASTER_THREE_VARIANTS = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8
`;

const MASTER_WITH_SEPARATE_AUDIO = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="audio_en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud1",CODECS="avc1.4d401f,mp4a.40.2"
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud1",CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8
`;

const MASTER_MIXED = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",DEFAULT=YES,URI="audio_en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2"
360p_embedded.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud1",CODECS="avc1.4d401f,mp4a.40.2"
720p_separate.m3u8
`;

const VARIANT_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg-001.ts
#EXTINF:6.0,
seg-002.ts
#EXT-X-ENDLIST
`;

describe("parseMasterVariants", () => {
  it("returns empty for empty or non-master text", () => {
    expect(parseMasterVariants("")).toEqual([]);
    expect(parseMasterVariants(VARIANT_PLAYLIST)).toEqual([]);
  });

  it("returns one entry per STREAM-INF in bandwidth-asc order from m3u8-parser", () => {
    const variants = parseMasterVariants(MASTER_THREE_VARIANTS);
    expect(variants).toHaveLength(3);
    expect(variants[0]).toEqual({
      uri: "360p.m3u8",
      bandwidth: 400000,
      width: 640,
      height: 360,
      codecs: "avc1.42c01e,mp4a.40.2",
      audioRenditionUri: undefined,
    });
    expect(variants[2].uri).toBe("1080p.m3u8");
    expect(variants[2].bandwidth).toBe(5000000);
    expect(variants[2].width).toBe(1920);
    expect(variants[2].height).toBe(1080);
    expect(variants[2].audioRenditionUri).toBeUndefined();
  });

  it("resolves audioRenditionUri for separate-audio variants (DEFAULT=YES rendition)", () => {
    const variants = parseMasterVariants(MASTER_WITH_SEPARATE_AUDIO);
    expect(variants).toHaveLength(2);
    expect(variants[0].uri).toBe("720p.m3u8");
    expect(variants[0].audioRenditionUri).toBe("audio_en.m3u8");
    expect(variants[1].audioRenditionUri).toBe("audio_en.m3u8");
  });

  it("mixed master: embedded variants have no audioRenditionUri; separate ones do", () => {
    const variants = parseMasterVariants(MASTER_MIXED);
    expect(variants).toHaveLength(2);
    const byUri = Object.fromEntries(variants.map((v) => [v.uri, v]));
    expect(byUri["360p_embedded.m3u8"].audioRenditionUri).toBeUndefined();
    expect(byUri["720p_separate.m3u8"].audioRenditionUri).toBe("audio_en.m3u8");
  });

  it("picks first audio rendition when no DEFAULT=YES is set", () => {
    const NO_DEFAULT = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="A",URI="a.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="B",URI="b.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1500000,AUDIO="aud1"
v.m3u8
`;
    const variants = parseMasterVariants(NO_DEFAULT);
    expect(variants[0].audioRenditionUri).toBe("a.m3u8");
  });

  it("skips audio renditions with no URI (signals embedded audio)", () => {
    const EMBEDDED_FLAG = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="Audio",DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1500000,AUDIO="aud1"
v.m3u8
`;
    const variants = parseMasterVariants(EMBEDDED_FLAG);
    expect(variants[0].audioRenditionUri).toBeUndefined();
  });
});

describe("isMasterPlaylist", () => {
  it("returns true for text containing EXT-X-STREAM-INF", () => {
    expect(isMasterPlaylist(MASTER_THREE_VARIANTS)).toBe(true);
  });

  it("returns false for variant playlists with no STREAM-INF", () => {
    expect(isMasterPlaylist(VARIANT_PLAYLIST)).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(isMasterPlaylist("")).toBe(false);
  });
});
