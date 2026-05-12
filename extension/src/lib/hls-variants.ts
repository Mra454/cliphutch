// Parses an HLS master playlist (the one that lists EXT-X-STREAM-INF entries)
// into a normalized list of variant choices. Used by the popup's variant
// picker to present resolution + bandwidth options before download.
//
// Variants that reference a separate AUDIO group carry the resolved audio
// rendition URI alongside them, so the downloader can fetch + mux both
// streams. The popup picker treats this as transparent — the user picks a
// video variant and gets the matching audio automatically.

import { Parser } from "m3u8-parser";

export type HlsVariant = {
  uri: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  // Resolved URI of the matching audio rendition (DEFAULT=YES preferred,
  // otherwise the first rendition with a non-empty URI in the group).
  // Undefined when the variant has embedded audio.
  audioRenditionUri?: string;
};

type ParsedAttributes = {
  BANDWIDTH?: number;
  RESOLUTION?: { width: number; height: number };
  CODECS?: string;
  AUDIO?: string;
};

type ParsedPlaylist = { uri: string; attributes: ParsedAttributes };

type AudioRendition = { uri?: string; default?: boolean };

type ParsedMaster = {
  playlists?: ParsedPlaylist[];
  mediaGroups?: {
    AUDIO?: Record<string, Record<string, AudioRendition>>;
  };
};

function pickAudioRenditionUri(
  audioGroupId: string | undefined,
  groups: ParsedMaster["mediaGroups"],
): string | undefined {
  if (!audioGroupId) return undefined;
  const group = groups?.AUDIO?.[audioGroupId];
  if (!group) return undefined;
  const renditions = Object.values(group);
  const withUri = renditions.filter((r) => Boolean(r.uri));
  if (withUri.length === 0) return undefined;
  const def = withUri.find((r) => r.default === true);
  return (def ?? withUri[0]).uri;
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
  return playlists.map((p) => ({
    uri: p.uri,
    bandwidth: p.attributes.BANDWIDTH ?? 0,
    width: p.attributes.RESOLUTION?.width,
    height: p.attributes.RESOLUTION?.height,
    codecs: p.attributes.CODECS,
    audioRenditionUri: pickAudioRenditionUri(p.attributes.AUDIO, m.mediaGroups),
  }));
}

export function isMasterPlaylist(text: string): boolean {
  return /\#EXT-X-STREAM-INF/.test(text);
}
