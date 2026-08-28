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

export type DashMediaType = "video" | "audio" | "unknown";

export type DashRepresentationUnsupportedShape =
  | "segment-base"
  | "segment-list-range"
  | "negative-repeat"
  | "invalid-segment-template"
  | "segment-limit"
  | "no-segments"
  | "ambiguous-media-type"
  | "unsupported-container";

export type DashRepresentation = {
  id: string;
  mediaType: DashMediaType;
  mimeType: string;
  codecs?: string;
  bandwidth: number;
  width?: number;
  height?: number;
  initSegmentUrl?: string;
  mediaSegmentUrls: string[];
  drm: { protected: boolean; scheme?: DrmScheme };
  unsupportedShape?: DashRepresentationUnsupportedShape;
};

export type DashManifest = {
  type: "static" | "dynamic";
  durationSec?: number;
  video: DashRepresentation[];
  audio: DashRepresentation[];
  other: DashRepresentation[];
  drm: { protected: boolean; scheme?: DrmScheme };
  unsupportedShape?: "multiple-periods" | "representation-limit";
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

// The current downloader eagerly materializes segment URLs. Until the v2
// cursor-based planner lands, fail closed before an MPD can force excessive
// expansion or request fan-out.
export const DASH_MANIFEST_CHAR_LIMIT = 2_000_000;
export const DASH_REPRESENTATION_LIMIT = 256;
export const DASH_SEGMENT_LIMIT_PER_REPRESENTATION = 20_000;
export const DASH_URL_LENGTH_LIMIT = 8_192;
const DASH_TEMPLATE_PADDING_LIMIT = 20;

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
  if (url.length > DASH_URL_LENGTH_LIMIT) {
    throw new DashParseError("DASH URL exceeds the parser length limit");
  }
  return url;
}

function classifyDrm(node: Record<string, unknown>): { protected: boolean; scheme?: DrmScheme } {
  const cps = asArray(node.ContentProtection as Record<string, unknown> | Record<string, unknown>[] | undefined);
  if (cps.length === 0) return { protected: false };

  let sawUnknownProtection = false;
  for (const cp of cps) {
    const schemeIdUri = String(cp["@_schemeIdUri"] ?? "").toLowerCase();
    if (!schemeIdUri) continue;
    if (schemeIdUri === "urn:mpeg:dash:mp4protection:2011") {
      // Bare mp4protection still declares Common Encryption. The DRM system
      // may be unspecified, but treating this as clear content downloads
      // ciphertext and produces a corrupt-looking file for the customer.
      sawUnknownProtection = true;
      continue;
    }
    for (const [marker, scheme] of DRM_SCHEME_IDS) {
      if (schemeIdUri.includes(marker)) return { protected: true, scheme };
    }
    sawUnknownProtection = true;
  }
  return sawUnknownProtection ? { protected: true, scheme: "unknown" } : { protected: false };
}

function firstProtected(
  ...checks: Array<{ protected: boolean; scheme?: DrmScheme }>
): { protected: boolean; scheme?: DrmScheme } {
  return checks.find((check) => check.protected) ?? { protected: false };
}

function applyTemplate(
  tmpl: string,
  vars: { RepresentationID?: string; Number?: number; Time?: number; Bandwidth?: number },
): string {
  const expanded = tmpl.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%(\d+)d)?\$/g, (_m, name, pad) => {
    const v = vars[name as keyof typeof vars];
    if (v === undefined || v === null) return "";
    if (typeof v === "number" && pad) {
      const width = Number(pad);
      if (!Number.isSafeInteger(width) || width > DASH_TEMPLATE_PADDING_LIMIT) {
        throw new DashParseError("DASH template padding exceeds the parser limit");
      }
      return String(v).padStart(width, "0");
    }
    return String(v);
  });
  if (expanded.length > DASH_URL_LENGTH_LIMIT) {
    throw new DashParseError("DASH template URL exceeds the parser length limit");
  }
  return expanded;
}

function expandSegmentTemplate(
  template: Record<string, unknown>,
  representationId: string,
  bandwidth: number,
  durationSec: number | undefined,
): {
  initTmpl?: string;
  mediaUrls: string[];
  unsupportedShape?: DashRepresentationUnsupportedShape;
} {
  const initTmpl = template["@_initialization"] as string | undefined;
  const mediaTmpl = template["@_media"] as string | undefined;
  const startNumber = Number(template["@_startNumber"] ?? 1);
  const timescale = Number(template["@_timescale"] ?? 1);
  const segDuration = template["@_duration"] !== undefined ? Number(template["@_duration"]) : undefined;

  const mediaUrls: string[] = [];

  if (
    !Number.isSafeInteger(startNumber) ||
    startNumber < 0 ||
    !Number.isFinite(timescale) ||
    timescale <= 0 ||
    (segDuration !== undefined && (!Number.isFinite(segDuration) || segDuration <= 0))
  ) {
    return { initTmpl, mediaUrls, unsupportedShape: "invalid-segment-template" };
  }

  const timeline = asArray(template.SegmentTimeline as Record<string, unknown> | Record<string, unknown>[] | undefined)[0];
  if (timeline && mediaTmpl) {
    const ses = asArray(timeline.S as Record<string, unknown> | Record<string, unknown>[] | undefined);
    let segNum = startNumber;
    let curTime = 0;
    for (const seg of ses) {
      if (seg["@_t"] !== undefined) {
        curTime = Number(seg["@_t"]);
        if (!Number.isSafeInteger(curTime) || curTime < 0) {
          return { initTmpl, mediaUrls: [], unsupportedShape: "invalid-segment-template" };
        }
      }
      const repeat = seg["@_r"] !== undefined ? Number(seg["@_r"]) : 0;
      const d = Number(seg["@_d"] ?? 0);
      if (repeat < 0) {
        return { initTmpl, mediaUrls: [], unsupportedShape: "negative-repeat" };
      }
      if (!Number.isSafeInteger(repeat) || !Number.isSafeInteger(d) || d <= 0) {
        return { initTmpl, mediaUrls: [], unsupportedShape: "invalid-segment-template" };
      }
      if (mediaUrls.length + repeat + 1 > DASH_SEGMENT_LIMIT_PER_REPRESENTATION) {
        return { initTmpl, mediaUrls: [], unsupportedShape: "segment-limit" };
      }
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
    if (!Number.isSafeInteger(count) || count < 0) {
      return { initTmpl, mediaUrls: [], unsupportedShape: "invalid-segment-template" };
    }
    if (count > DASH_SEGMENT_LIMIT_PER_REPRESENTATION) {
      return { initTmpl, mediaUrls: [], unsupportedShape: "segment-limit" };
    }
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

function expandSegmentList(list: Record<string, unknown>): {
  initUrl?: string;
  mediaUrls: string[];
  unsupportedShape?: DashRepresentationUnsupportedShape;
} {
  const init = asArray(list.Initialization as Record<string, unknown> | Record<string, unknown>[] | undefined)[0];
  const initUrl = init ? (init["@_sourceURL"] as string | undefined) : undefined;
  const segmentUrls = asArray(list.SegmentURL as Record<string, unknown> | Record<string, unknown>[] | undefined);
  if (
    init?.["@_range"] !== undefined ||
    segmentUrls.some((u) => u["@_mediaRange"] !== undefined || u["@_indexRange"] !== undefined)
  ) {
    return { initUrl, mediaUrls: [], unsupportedShape: "segment-list-range" };
  }
  if (segmentUrls.length > DASH_SEGMENT_LIMIT_PER_REPRESENTATION) {
    return { initUrl, mediaUrls: [], unsupportedShape: "segment-limit" };
  }
  const urls = segmentUrls
    .map((u) => u["@_media"] as string | undefined)
    .filter((u): u is string => typeof u === "string");
  return { initUrl, mediaUrls: urls };
}

function resolveMediaType(
  rep: Record<string, unknown>,
  fallbackContentType: string,
  fallbackMimeType: string,
): DashMediaType {
  const ownContentType = String(rep["@_contentType"] ?? "").toLowerCase();
  const ownMimeType = String(rep["@_mimeType"] ?? "").toLowerCase();
  const inheritedContentType = fallbackContentType.toLowerCase();
  const inheritedMimeType = fallbackMimeType.toLowerCase();

  // Representation-local declarations take precedence over an ambiguous or
  // even contradictory AdaptationSet declaration.
  if (ownContentType.startsWith("audio") || ownMimeType.startsWith("audio/")) return "audio";
  if (ownContentType.startsWith("video") || ownMimeType.startsWith("video/")) return "video";
  if (inheritedContentType.startsWith("audio") || inheritedMimeType.startsWith("audio/")) return "audio";
  if (inheritedContentType.startsWith("video") || inheritedMimeType.startsWith("video/")) return "video";
  if (rep["@_width"] !== undefined || rep["@_height"] !== undefined) return "video";
  return "unknown";
}

function buildRepresentation(
  rep: Record<string, unknown>,
  parentBaseUrls: string[],
  fallbackContentType: string,
  fallbackMimeType: string,
  inheritedTemplate: Record<string, unknown> | undefined,
  inheritedList: Record<string, unknown> | undefined,
  inheritedSegmentBase: boolean,
  inheritedDrm: { protected: boolean; scheme?: DrmScheme },
  durationSec: number | undefined,
): DashRepresentation {
  const id = String(rep["@_id"] ?? "");
  const bandwidth = Number(rep["@_bandwidth"] ?? 0);
  const codecs = rep["@_codecs"] as string | undefined;
  const width = rep["@_width"] !== undefined ? Number(rep["@_width"]) : undefined;
  const height = rep["@_height"] !== undefined ? Number(rep["@_height"]) : undefined;
  const mimeType = String(rep["@_mimeType"] ?? fallbackMimeType);
  const mediaType = resolveMediaType(rep, fallbackContentType, fallbackMimeType);
  const drm = firstProtected(classifyDrm(rep), inheritedDrm);

  const repBaseUrl = asArray(rep.BaseURL as string | string[] | undefined)[0];
  const baseUrls = repBaseUrl ? [...parentBaseUrls, repBaseUrl] : parentBaseUrls;

  const tpl = (rep.SegmentTemplate as Record<string, unknown> | undefined) ?? inheritedTemplate;
  const list = (rep.SegmentList as Record<string, unknown> | undefined) ?? inheritedList;

  let initUrl: string | undefined;
  let mediaUrls: string[] = [];
  let unsupportedShape: DashRepresentationUnsupportedShape | undefined;

  if (rep.SegmentBase || inheritedSegmentBase) {
    unsupportedShape = "segment-base";
  } else if (tpl) {
    const {
      initTmpl,
      mediaUrls: rawMedia,
      unsupportedShape: templateUnsupported,
    } = expandSegmentTemplate(tpl, id, bandwidth, durationSec);
    unsupportedShape = templateUnsupported;
    if (initTmpl) {
      const initRel = applyTemplate(initTmpl, { RepresentationID: id, Bandwidth: bandwidth });
      initUrl = resolveBaseUrl(baseUrls, initRel);
    }
    mediaUrls = rawMedia.map((u) => resolveBaseUrl(baseUrls, u));
  } else if (list) {
    const {
      initUrl: rawInit,
      mediaUrls: rawMedia,
      unsupportedShape: listUnsupported,
    } = expandSegmentList(list);
    unsupportedShape = listUnsupported;
    if (rawInit) initUrl = resolveBaseUrl(baseUrls, rawInit);
    mediaUrls = rawMedia.map((u) => resolveBaseUrl(baseUrls, u));
  } else {
    // Single-file on-demand profile (urn:mpeg:dash:profile:isoff-on-demand:2011):
    // a Representation with only <BaseURL>file.m4v</BaseURL> and no segment
    // shape means the entire media is in one file. Treat as a one-segment,
    // no-init Representation so the downloader fetches the whole file.
    const last = baseUrls[baseUrls.length - 1];
    if (last && !last.endsWith("/")) {
      mediaUrls = [resolveBaseUrl(baseUrls, undefined)];
    } else {
      unsupportedShape = "no-segments";
    }
  }

  if (!unsupportedShape && mediaType === "unknown") unsupportedShape = "ambiguous-media-type";
  if (
    !unsupportedShape &&
    mediaType !== "unknown" &&
    mimeType.toLowerCase() !== `${mediaType}/mp4`
  ) {
    unsupportedShape = "unsupported-container";
  }
  if (!unsupportedShape && mediaUrls.length === 0) unsupportedShape = "no-segments";

  return {
    id,
    mediaType,
    mimeType,
    codecs,
    bandwidth,
    width,
    height,
    initSegmentUrl: initUrl,
    mediaSegmentUrls: mediaUrls,
    drm,
    unsupportedShape,
  };
}

export function parseMpd(text: string, manifestUrl: string): DashManifest {
  if (text.length > DASH_MANIFEST_CHAR_LIMIT) {
    throw new DashParseError("MPD exceeds the parser size limit");
  }

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
  const mpdDurationSec = parseDurationIso(mpd["@_mediaPresentationDuration"] as string | undefined);

  const mpdBaseUrl = asArray(mpd.BaseURL as string | string[] | undefined)[0];
  const rootBaseUrls = mpdBaseUrl ? [manifestUrl, mpdBaseUrl] : [manifestUrl];

  const periods = asArray(mpd.Period as Record<string, unknown> | Record<string, unknown>[] | undefined);
  if (periods.length > 1) {
    return {
      type,
      durationSec: mpdDurationSec,
      video: [],
      audio: [],
      other: [],
      drm: classifyDrm(mpd),
      unsupportedShape: "multiple-periods",
    };
  }
  const period = periods[0];
  if (!period) {
    return {
      type,
      durationSec: mpdDurationSec,
      video: [],
      audio: [],
      other: [],
      drm: classifyDrm(mpd),
    };
  }
  const durationSec =
    mpdDurationSec ?? parseDurationIso(period["@_duration"] as string | undefined);

  const periodBaseUrl = asArray(period.BaseURL as string | string[] | undefined)[0];
  const periodBaseUrls = periodBaseUrl ? [...rootBaseUrls, periodBaseUrl] : rootBaseUrls;

  const adaptationSets = asArray(period.AdaptationSet as Record<string, unknown> | Record<string, unknown>[] | undefined);

  const inheritedManifestDrm = firstProtected(classifyDrm(period), classifyDrm(mpd));
  let drm: { protected: boolean; scheme?: DrmScheme } = inheritedManifestDrm;
  const video: DashRepresentation[] = [];
  const audio: DashRepresentation[] = [];
  const other: DashRepresentation[] = [];
  let representationCount = 0;

  for (const as of adaptationSets) {
    const asBaseUrl = asArray(as.BaseURL as string | string[] | undefined)[0];
    const asBaseUrls = asBaseUrl ? [...periodBaseUrls, asBaseUrl] : periodBaseUrls;
    const asContentType = String(as["@_contentType"] ?? "").toLowerCase();
    const asMimeType = String(as["@_mimeType"] ?? "");
    const inheritedTemplate = as.SegmentTemplate as Record<string, unknown> | undefined;
    const inheritedList = as.SegmentList as Record<string, unknown> | undefined;
    const inheritedSegmentBase = Boolean(as.SegmentBase);

    const asDrm = firstProtected(classifyDrm(as), inheritedManifestDrm);
    if (asDrm.protected && !drm.protected) drm = asDrm;

    const reps = asArray(as.Representation as Record<string, unknown> | Record<string, unknown>[] | undefined);
    representationCount += reps.length;
    if (representationCount > DASH_REPRESENTATION_LIMIT) {
      return {
        type,
        durationSec,
        video: [],
        audio: [],
        other: [],
        drm,
        unsupportedShape: "representation-limit",
      };
    }
    for (const rep of reps) {
      const built = buildRepresentation(
        rep,
        asBaseUrls,
        asContentType,
        asMimeType,
        inheritedTemplate,
        inheritedList,
        inheritedSegmentBase,
        asDrm,
        durationSec,
      );
      if (built.drm.protected && !drm.protected) drm = built.drm;

      if (built.mediaType === "video") video.push(built);
      else if (built.mediaType === "audio") audio.push(built);
      else other.push(built);
    }
  }

  // Preserve a manifest-level DRM summary for callers that cannot select a
  // Representation, but do not let one protected alternative poison a clear
  // sibling. The downloader still checks the exact selected video/audio reps.
  const protectedVideo =
    video.length > 0 && video.every((rep) => rep.drm.protected)
      ? video.find((rep) => rep.drm.protected)
      : undefined;
  const protectedAudio =
    audio.length > 0 && audio.every((rep) => rep.drm.protected)
      ? audio.find((rep) => rep.drm.protected)
      : undefined;
  const manifestDrm = firstProtected(
    inheritedManifestDrm,
    protectedVideo?.drm ?? { protected: false },
    protectedAudio?.drm ?? { protected: false },
  );

  return { type, durationSec, video, audio, other, drm: manifestDrm };
}

export function pickHighestBandwidth(reps: DashRepresentation[]): DashRepresentation | undefined {
  if (reps.length === 0) return undefined;
  return [...reps].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0];
}
