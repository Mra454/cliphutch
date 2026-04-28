import { describe, expect, it } from "vitest";
import { DashParseError, parseMpd, pickHighestBandwidth } from "./dash";

const BASE = "https://cdn.example.com/v/manifest.mpd";

describe("parseMpd", () => {
  it("parses a simple SegmentTemplate with $Number$ and uniform duration", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT12S" xmlns="urn:mpeg:dash:schema:mpd:2011">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="vid1" bandwidth="2000000" width="1280" height="720" codecs="avc1.640028">
        <SegmentTemplate initialization="init-$RepresentationID$.m4s" media="seg-$RepresentationID$-$Number$.m4s" startNumber="1" duration="6000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4">
      <Representation id="aud1" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentTemplate initialization="init-$RepresentationID$.m4s" media="seg-$RepresentationID$-$Number$.m4s" startNumber="1" duration="6000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const m = parseMpd(xml, BASE);
    expect(m.type).toBe("static");
    expect(m.video).toHaveLength(1);
    expect(m.audio).toHaveLength(1);
    expect(m.video[0].id).toBe("vid1");
    expect(m.video[0].bandwidth).toBe(2000000);
    expect(m.video[0].width).toBe(1280);
    expect(m.video[0].initSegmentUrl).toBe("https://cdn.example.com/v/init-vid1.m4s");
    expect(m.video[0].mediaSegmentUrls).toHaveLength(2);
    expect(m.video[0].mediaSegmentUrls[0]).toBe("https://cdn.example.com/v/seg-vid1-1.m4s");
    expect(m.video[0].mediaSegmentUrls[1]).toBe("https://cdn.example.com/v/seg-vid1-2.m4s");
    expect(m.audio[0].id).toBe("aud1");
    expect(m.drm.protected).toBe(false);
  });

  it("handles $Number%05d$ zero-pad", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT6S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v" bandwidth="1000000">
        <SegmentTemplate initialization="init.m4s" media="seg-$Number%05d$.m4s" startNumber="1" duration="6000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const m = parseMpd(xml, BASE);
    expect(m.video[0].mediaSegmentUrls[0]).toBe("https://cdn.example.com/v/seg-00001.m4s");
  });

  it("handles SegmentTimeline with $Time$ and explicit durations", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="static">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" bandwidth="3000000" width="1920" height="1080">
        <SegmentTemplate initialization="init.mp4" media="seg-$Time$.m4s" timescale="1000">
          <SegmentTimeline>
            <S t="0" d="2000" r="2"/>
            <S d="3000"/>
          </SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const m = parseMpd(xml, BASE);
    expect(m.video[0].mediaSegmentUrls).toEqual([
      "https://cdn.example.com/v/seg-0.m4s",
      "https://cdn.example.com/v/seg-2000.m4s",
      "https://cdn.example.com/v/seg-4000.m4s",
      "https://cdn.example.com/v/seg-6000.m4s",
    ]);
  });

  it("inherits SegmentTemplate from AdaptationSet", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT12S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate initialization="init-$RepresentationID$.m4s" media="seg-$RepresentationID$-$Number$.m4s" startNumber="1" duration="6000" timescale="1000"/>
      <Representation id="v720" bandwidth="2000000" width="1280" height="720"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080"/>
    </AdaptationSet>
  </Period>
</MPD>`;
    const m = parseMpd(xml, BASE);
    expect(m.video).toHaveLength(2);
    expect(m.video[0].mediaSegmentUrls[0]).toBe("https://cdn.example.com/v/seg-v720-1.m4s");
    expect(m.video[1].mediaSegmentUrls[0]).toBe("https://cdn.example.com/v/seg-v1080-1.m4s");
  });

  it("resolves BaseURL hierarchy (MPD > Period > AdaptationSet > Representation)", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT6S">
  <BaseURL>https://cdn.example.com/v/</BaseURL>
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <BaseURL>720p/</BaseURL>
      <Representation id="v" bandwidth="2000000">
        <SegmentTemplate initialization="init.m4s" media="seg-$Number$.m4s" startNumber="1" duration="6000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const m = parseMpd(xml, "https://example.com/path/manifest.mpd");
    expect(m.video[0].initSegmentUrl).toBe("https://cdn.example.com/v/720p/init.m4s");
    expect(m.video[0].mediaSegmentUrls[0]).toBe("https://cdn.example.com/v/720p/seg-1.m4s");
  });

  it("flags type='dynamic' as dynamic (live)", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="dynamic">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v" bandwidth="1000000">
        <SegmentTemplate initialization="init.m4s" media="seg-$Number$.m4s" startNumber="1" duration="6000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const m = parseMpd(xml, BASE);
    expect(m.type).toBe("dynamic");
  });

  it("flags Widevine ContentProtection on AdaptationSet", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT6S">
  <Period>
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
      <Representation id="v" bandwidth="1000000">
        <SegmentTemplate initialization="init.m4s" media="seg-$Number$.m4s" startNumber="1" duration="6000" timescale="1000"/>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const m = parseMpd(xml, BASE);
    expect(m.drm).toEqual({ protected: true, scheme: "widevine" });
  });

  it("flags PlayReady, FairPlay, ClearKey scheme UUIDs", () => {
    const cases: Array<[string, string]> = [
      ["urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", "playready"],
      ["urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2", "fairplay"],
      ["urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e", "clearkey"],
    ];
    for (const [uri, expected] of cases) {
      const xml = `<?xml version="1.0"?>
<MPD type="static"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
<ContentProtection schemeIdUri="${uri}"/>
<Representation id="v" bandwidth="1"><SegmentTemplate initialization="i.m4s" media="s-$Number$.m4s" startNumber="1" duration="1" timescale="1"/></Representation>
</AdaptationSet></Period></MPD>`;
      const m = parseMpd(xml, BASE);
      expect(m.drm).toEqual({ protected: true, scheme: expected });
    }
  });

  it("does NOT flag bare urn:mpeg:dash:mp4protection:2011 alone (no real DRM scheme)", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="static"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
<Representation id="v" bandwidth="1"><SegmentTemplate initialization="i.m4s" media="s-$Number$.m4s" startNumber="1" duration="1" timescale="1"/></Representation>
</AdaptationSet></Period></MPD>`;
    const m = parseMpd(xml, BASE);
    expect(m.drm.protected).toBe(false);
  });

  it("flags an unknown DRM schemeIdUri as protected with scheme=unknown", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="static"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
<ContentProtection schemeIdUri="urn:uuid:00000000-0000-0000-0000-000000000000"/>
<Representation id="v" bandwidth="1"><SegmentTemplate initialization="i.m4s" media="s-$Number$.m4s" startNumber="1" duration="1" timescale="1"/></Representation>
</AdaptationSet></Period></MPD>`;
    const m = parseMpd(xml, BASE);
    expect(m.drm).toEqual({ protected: true, scheme: "unknown" });
  });

  it("reports SegmentBase as unsupported byterange shape", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="static"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
<Representation id="v" bandwidth="1">
  <SegmentBase indexRange="0-1000"/>
</Representation>
</AdaptationSet></Period></MPD>`;
    const m = parseMpd(xml, BASE);
    expect(m.video).toHaveLength(0);
    expect(m.unsupportedShape).toBe("byterange");
  });

  it("treats a Representation with only <BaseURL>file</BaseURL> (single-file on-demand profile) as one-segment-no-init", () => {
    // Real-world shape from dash.akamaized.net/.../SNE_DASH_SD_CASE1A_REVISED.mpd
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<MPD type="static" mediaPresentationDuration="PT9M57S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period duration="PT9M57S">
    <AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.5">
      <Representation id="2_1" bandwidth="64000">
        <BaseURL>DASH_vodaudio_Track5.m4a</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.4D401E">
      <Representation id="1_1" bandwidth="1005568" width="854" height="480">
        <BaseURL>DASH_vodvideo_Track2.m4v</BaseURL>
      </Representation>
      <Representation id="1_2" bandwidth="1609728" width="854" height="480">
        <BaseURL>DASH_vodvideo_Track1.m4v</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
    const m = parseMpd(xml, "https://dash.akamaized.net/dash264/TestCases/1a/sony/SNE_DASH_SD_CASE1A_REVISED.mpd");
    expect(m.video).toHaveLength(2);
    expect(m.video[0].initSegmentUrl).toBeUndefined();
    expect(m.video[0].mediaSegmentUrls).toEqual([
      "https://dash.akamaized.net/dash264/TestCases/1a/sony/DASH_vodvideo_Track2.m4v",
    ]);
    expect(m.video[1].mediaSegmentUrls).toEqual([
      "https://dash.akamaized.net/dash264/TestCases/1a/sony/DASH_vodvideo_Track1.m4v",
    ]);
    expect(m.audio).toHaveLength(1);
    expect(m.audio[0].mediaSegmentUrls).toEqual([
      "https://dash.akamaized.net/dash264/TestCases/1a/sony/DASH_vodaudio_Track5.m4a",
    ]);
  });

  it("expands a SegmentList", () => {
    const xml = `<?xml version="1.0"?>
<MPD type="static"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
<Representation id="v" bandwidth="1">
  <SegmentList>
    <Initialization sourceURL="init.m4s"/>
    <SegmentURL media="seg1.m4s"/>
    <SegmentURL media="seg2.m4s"/>
  </SegmentList>
</Representation>
</AdaptationSet></Period></MPD>`;
    const m = parseMpd(xml, BASE);
    expect(m.video[0].initSegmentUrl).toBe("https://cdn.example.com/v/init.m4s");
    expect(m.video[0].mediaSegmentUrls).toEqual([
      "https://cdn.example.com/v/seg1.m4s",
      "https://cdn.example.com/v/seg2.m4s",
    ]);
  });

  it("throws DashParseError on malformed XML", () => {
    expect(() => parseMpd("<not><valid", BASE)).toThrow(DashParseError);
  });

  it("throws DashParseError when there is no <MPD> root", () => {
    expect(() => parseMpd("<NotMPD/>", BASE)).toThrow(DashParseError);
  });
});

describe("pickHighestBandwidth", () => {
  it("returns undefined for empty list", () => {
    expect(pickHighestBandwidth([])).toBeUndefined();
  });

  it("returns the highest-bandwidth representation", () => {
    const reps = [
      { id: "a", mimeType: "video/mp4", bandwidth: 1000, mediaSegmentUrls: [] },
      { id: "b", mimeType: "video/mp4", bandwidth: 5000, mediaSegmentUrls: [] },
      { id: "c", mimeType: "video/mp4", bandwidth: 3000, mediaSegmentUrls: [] },
    ];
    expect(pickHighestBandwidth(reps)?.id).toBe("b");
  });
});
