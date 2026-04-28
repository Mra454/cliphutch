// Parses an HLS master playlist (the one that lists EXT-X-STREAM-INF entries)
// into a normalized list of variant choices. Used by the popup's variant
// picker to present resolution + bandwidth options before download.
//
// Variants pointing at separate-audio renditions are filtered out — v1 only
// supports playlists with embedded audio in the same MPEG-TS stream.

import { Parser } from "m3u8-parser";

export type HlsVariant = {
  uri: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
};

type ParsedAttributes = {
  BANDWIDTH?: number;
  RESOLUTION?: { width: number; height: number };
  CODECS?: string;
  AUDIO?: string;
};

type ParsedPlaylist = { uri: string; attributes: ParsedAttributes };

type ParsedMaster = {
  playlists?: ParsedPlaylist[];
  mediaGroups?: {
    AUDIO?: Record<string, Record<string, { uri?: string }>>;
  };
};

function variantHasSeparateAudio(
  v: ParsedPlaylist,
  groups: ParsedMaster["mediaGroups"],
): boolean {
  const audioGroupId = v.attributes.AUDIO;
  if (!audioGroupId) return false;
  const group = groups?.AUDIO?.[audioGroupId];
  if (!group) return false;
  return Object.values(group).some((rendition) => Boolean(rendition.uri));
}

export function parseMasterVariants(text: string): HlsVariant[] {
  const parser = new Parser();
  try {
    parser.push(text);
    parser.end();
  } catch {
    return [];
  }
  const m = parser.manifest as ParsedMaster;
  const playlists = m.playlists ?? [];
  return playlists
    .filter((p) => !variantHasSeparateAudio(p, m.mediaGroups))
    .map((p) => ({
      uri: p.uri,
      bandwidth: p.attributes.BANDWIDTH ?? 0,
      width: p.attributes.RESOLUTION?.width,
      height: p.attributes.RESOLUTION?.height,
      codecs: p.attributes.CODECS,
    }));
}

export function isMasterPlaylist(text: string): boolean {
  return /\#EXT-X-STREAM-INF/.test(text);
}
