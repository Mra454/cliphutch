// Pure MPD (DASH) parser. Takes the raw XML text of a Media Presentation
// Description and returns a normalized representation: one or more video
// Representations and zero-or-more audio Representations, each with a list
// of fully-resolved init + media segment URLs. DRM detection lives here
// too — checking <ContentProtection> elements on AdaptationSet or
// Representation level.
//
// Scope: static (VOD) MPDs with SegmentTemplate (with or without
// SegmentTimeline) or SegmentList. Dynamic (live) MPDs and SegmentBase /
// byterange-only Representations are reported as such by the caller.

import { XMLParser } from "fast-xml-parser";
import type { DrmScheme } from "./drm";

export type DashRepresentation = {
  id: string;
  mimeType: string;
  codecs?: string;
  bandwidth: number;
  width?: number;
  height?: number;
  initSegmentUrl?: string;
  mediaSegmentUrls: string[];
};

export type DashManifest = {
  type: "static" | "dynamic";
  durationSec?: number;
  video: DashRepresentation[];
  audio: DashRepresentation[];
  drm: { protected: boolean; scheme?: DrmScheme };
  unsupportedShape?: "byterange" | "no-segments";
};

export class DashParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashParseError";
  }
}

const DRM_SCHEME_IDS: Array<[string, DrmScheme]> = [
  ["urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed", "widevine"],
  ["urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95", "playready"],
  ["urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2", "fairplay"],
  ["urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e", "clearkey"],
];

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function parseDurationIso(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
  if (!m) return undefined;
  const [, d, h, mi, sec] = m;
  return (
    (Number(d) || 0) * 86400 +
    (Number(h) || 0) * 3600 +
    (Number(mi) || 0) * 60 +
    (Number(sec) || 0)
  );
}

function resolveBaseUrl(parents: string[], child: string | undefined): string {
  const stack = [...parents];
  if (child) stack.push(child);
  let url = stack[0] ?? "";
  for (let i = 1; i < stack.length; i++) {
    try {
      url = new URL(stack[i], url).href;
    } catch {
      // leave as-is
    }
  }
  return url;
}

function classifyDrm(node: Record<string, unknown>): { protected: boolean; scheme?: DrmScheme } {
  const cps = asArray(node.ContentProtection as Record<string, unknown> | Record<string, unknown>[] | undefined);
  if (cps.length === 0) return { protected: false };

  for (const cp of cps) {
    const schemeIdUri = String(cp["@_schemeIdUri"] ?? "").toLowerCase();
    if (!schemeIdUri) continue;
    if (schemeIdUri === "urn:mpeg:dash:mp4protection:2011") {
      // The mp4protection scheme alone is generic CENC marking — it indicates
      // the segments use Common Encryption but not which DRM system. Treat it
      // as protected only if accompanied by a real scheme (handled by other
      // ContentProtection siblings). Skip and continue scanning.
      continue;
    }
    for (const [marker, scheme] of DRM_SCHEME_IDS) {
      if (schemeIdUri.includes(marker)) return { protected: true, scheme };
    }
    return { protected: true, scheme: "unknown" };
  }
  return { protected: false };
}

function applyTemplate(
  tmpl: string,
  vars: { RepresentationID?: string; Number?: number; Time?: number; Bandwidth?: number },
): string {
  return tmpl.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%(\d+)d)?\$/g, (_m, name, pad) => {
    const v = vars[name as keyof typeof vars];
    if (v === undefined || v === null) return "";
    if (typeof v === "number" && pad) {
      return String(v).padStart(Number(pad), "0");
    }
    return String(v);
  });
}

function expandSegmentTemplate(
  template: Record<string, unknown>,
  representationId: string,
  bandwidth: number,
  durationSec: number | undefined,
): { initTmpl?: string; mediaUrls: string[] } {
  const initTmpl = template["@_initialization"] as string | undefined;
  const mediaTmpl = template["@_media"] as string | undefined;
  const startNumber = Number(template["@_startNumber"] ?? 1);
  const timescale = Number(template["@_timescale"] ?? 1);
  const segDuration = template["@_duration"] !== undefined ? Number(template["@_duration"]) : undefined;

  const mediaUrls: string[] = [];

  const timeline = asArray(template.SegmentTimeline as Record<string, unknown> | Record<string, unknown>[] | undefined)[0];
  if (timeline && mediaTmpl) {
    const ses = asArray(timeline.S as Record<string, unknown> | Record<string, unknown>[] | undefined);
    let segNum = startNumber;
    let curTime = 0;
    for (const seg of ses) {
      if (seg["@_t"] !== undefined) curTime = Number(seg["@_t"]);
      const repeat = seg["@_r"] !== undefined ? Number(seg["@_r"]) : 0;
      const d = Number(seg["@_d"] ?? 0);
      for (let i = 0; i <= repeat; i++) {
        mediaUrls.push(
          applyTemplate(mediaTmpl, {
            RepresentationID: representationId,
            Number: segNum,
            Time: curTime,
            Bandwidth: bandwidth,
          }),
        );
        segNum += 1;
        curTime += d;
      }
    }
  } else if (mediaTmpl && segDuration && timescale && durationSec !== undefined) {
    const segLenSec = segDuration / timescale;
    const count = Math.ceil(durationSec / segLenSec);
    for (let i = 0; i < count; i++) {
      mediaUrls.push(
        applyTemplate(mediaTmpl, {
          RepresentationID: representationId,
          Number: startNumber + i,
          Bandwidth: bandwidth,
        }),
      );
    }
  }

  return { initTmpl, mediaUrls };
}

function expandSegmentList(list: Record<string, unknown>): { initUrl?: string; mediaUrls: string[] } {
  const init = asArray(list.Initialization as Record<string, unknown> | Record<string, unknown>[] | undefined)[0];
  const initUrl = init ? (init["@_sourceURL"] as string | undefined) : undefined;
  const urls = asArray(list.SegmentURL as Record<string, unknown> | Record<string, unknown>[] | undefined)
    .map((u) => u["@_media"] as string | undefined)
    .filter((u): u is string => typeof u === "string");
  return { initUrl, mediaUrls: urls };
}

function buildRepresentation(
  rep: Record<string, unknown>,
  parentBaseUrls: string[],
  fallbackMimeType: string,
  inheritedTemplate: Record<string, unknown> | undefined,
  durationSec: number | undefined,
): DashRepresentation | { unsupported: "byterange" | "no-segments" } {
  const id = String(rep["@_id"] ?? "");
  const bandwidth = Number(rep["@_bandwidth"] ?? 0);
  const codecs = rep["@_codecs"] as string | undefined;
  const width = rep["@_width"] !== undefined ? Number(rep["@_width"]) : undefined;
  const height = rep["@_height"] !== undefined ? Number(rep["@_height"]) : undefined;
  const mimeType = String(rep["@_mimeType"] ?? fallbackMimeType);

  const repBaseUrl = asArray(rep.BaseURL as string | string[] | undefined)[0];
  const baseUrls = repBaseUrl ? [...parentBaseUrls, repBaseUrl] : parentBaseUrls;

  if (rep.SegmentBase) {
    return { unsupported: "byterange" };
  }

  const tpl = (rep.SegmentTemplate as Record<string, unknown> | undefined) ?? inheritedTemplate;
  const list = rep.SegmentList as Record<string, unknown> | undefined;

  let initUrl: string | undefined;
  let mediaUrls: string[] = [];

  if (tpl) {
    const { initTmpl, mediaUrls: rawMedia } = expandSegmentTemplate(tpl, id, bandwidth, durationSec);
    if (initTmpl) {
      const initRel = applyTemplate(initTmpl, { RepresentationID: id, Bandwidth: bandwidth });
      initUrl = resolveBaseUrl(baseUrls, initRel);
    }
    mediaUrls = rawMedia.map((u) => resolveBaseUrl(baseUrls, u));
  } else if (list) {
    const { initUrl: rawInit, mediaUrls: rawMedia } = expandSegmentList(list);
    if (rawInit) initUrl = resolveBaseUrl(baseUrls, rawInit);
    mediaUrls = rawMedia.map((u) => resolveBaseUrl(baseUrls, u));
  } else {
    return { unsupported: "no-segments" };
  }

  return {
    id,
    mimeType,
    codecs,
    bandwidth,
    width,
    height,
    initSegmentUrl: initUrl,
    mediaSegmentUrls: mediaUrls,
  };
}

export function parseMpd(text: string, manifestUrl: string): DashManifest {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseAttributeValue: false,
    isArray: () => false,
  });

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new DashParseError(err instanceof Error ? err.message : "MPD parse failed");
  }

  const mpd = doc.MPD as Record<string, unknown> | undefined;
  if (!mpd) throw new DashParseError("No <MPD> root element");

  const type = (mpd["@_type"] as string | undefined) === "dynamic" ? "dynamic" : "static";
  const durationSec = parseDurationIso(mpd["@_mediaPresentationDuration"] as string | undefined);

  const mpdBaseUrl = asArray(mpd.BaseURL as string | string[] | undefined)[0];
  const rootBaseUrls = mpdBaseUrl ? [manifestUrl, mpdBaseUrl] : [manifestUrl];

  const periods = asArray(mpd.Period as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const period = periods[0];
  if (!period) {
    return { type, durationSec, video: [], audio: [], drm: { protected: false } };
  }

  const periodBaseUrl = asArray(period.BaseURL as string | string[] | undefined)[0];
  const periodBaseUrls = periodBaseUrl ? [...rootBaseUrls, periodBaseUrl] : rootBaseUrls;

  const adaptationSets = asArray(period.AdaptationSet as Record<string, unknown> | Record<string, unknown>[] | undefined);

  let drm: { protected: boolean; scheme?: DrmScheme } = { protected: false };
  const video: DashRepresentation[] = [];
  const audio: DashRepresentation[] = [];
  let unsupportedShape: "byterange" | "no-segments" | undefined;

  for (const as of adaptationSets) {
    const asBaseUrl = asArray(as.BaseURL as string | string[] | undefined)[0];
    const asBaseUrls = asBaseUrl ? [...periodBaseUrls, asBaseUrl] : periodBaseUrls;
    const asContentType = String(as["@_contentType"] ?? "").toLowerCase();
    const asMimeType = String(as["@_mimeType"] ?? "");
    const isVideo = asContentType.startsWith("video") || /^video\//.test(asMimeType);
    const isAudio = asContentType.startsWith("audio") || /^audio\//.test(asMimeType);
    const inheritedTemplate = as.SegmentTemplate as Record<string, unknown> | undefined;

    const asDrm = classifyDrm(as);
    if (asDrm.protected && !drm.protected) drm = asDrm;

    const reps = asArray(as.Representation as Record<string, unknown> | Record<string, unknown>[] | undefined);
    for (const rep of reps) {
      const repDrm = classifyDrm(rep);
      if (repDrm.protected && !drm.protected) drm = repDrm;

      const built = buildRepresentation(rep, asBaseUrls, asMimeType, inheritedTemplate, durationSec);
      if ("unsupported" in built) {
        unsupportedShape = built.unsupported;
        continue;
      }
      if (isVideo || built.width || built.height) video.push(built);
      else if (isAudio) audio.push(built);
      else video.push(built);
    }
  }

  return { type, durationSec, video, audio, drm, unsupportedShape };
}

export function pickHighestBandwidth(reps: DashRepresentation[]): DashRepresentation | undefined {
  if (reps.length === 0) return undefined;
  return [...reps].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
}
