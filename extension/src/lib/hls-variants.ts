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
  // RFC 8216 aggregate average bitrate for every playable media component.
  // When present this is the less conservative input for a size estimate;
  // BANDWIDTH remains the declared peak bitrate.
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  audioGroupId?: string;
  // Resolved URI of the matching audio rendition (DEFAULT=YES preferred,
  // otherwise the first rendition with a non-empty URI in the group).
  // Undefined when the variant has embedded audio.
  audioRenditionUri?: string;
  // Structural metadata is retained independently of the fetch URI so callers
  // can identify a default rendition without persisting a signed query string.
  audioRendition?: HlsAudioRendition;
  defaultAudioRendition?: HlsAudioRendition;
  identityInput?: HlsVariantIdentityInput;
};

export type HlsAudioRendition = {
  groupId: string;
  name: string;
  uri?: string;
  identityUri?: string;
  default: boolean;
  autoselect?: boolean;
  language?: string;
};

export type HlsVariantIdentityInput = {
  uri: string;
  bandwidth: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  audio?: {
    groupId: string;
    name?: string;
    uri?: string;
    language?: string;
  };
};

type ParsedAttributes = {
  BANDWIDTH?: number | string;
  "AVERAGE-BANDWIDTH"?: number | string;
  RESOLUTION?: { width: number; height: number };
  CODECS?: string;
  AUDIO?: string;
};

function numericBandwidth(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

type ParsedPlaylist = { uri: string; attributes: ParsedAttributes };

type ParsedAudioRendition = {
  uri?: string;
  default?: boolean;
  autoselect?: boolean;
  language?: string;
};

type ParsedMaster = {
  playlists?: ParsedPlaylist[];
  mediaGroups?: {
    AUDIO?: Record<string, Record<string, ParsedAudioRendition>>;
  };
};

function queryRedactedUrl(uri: string, baseUrl: string): string | undefined {
  try {
    const parsed = new URL(uri, baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
}

/**
 * Resolves an HLS URI and removes URL credentials, query, and fragment data.
 * This is suitable as structural selector input, never as the fetch URL.
 */
export function hlsQueryRedactedIdentityUri(
  uri: string,
  masterUrl: string,
): string | undefined {
  return queryRedactedUrl(uri, masterUrl);
}

function pickAudioRendition(
  audioGroupId: string | undefined,
  groups: ParsedMaster["mediaGroups"],
  masterUrl: string | undefined,
): HlsAudioRendition | undefined {
  if (!audioGroupId) return undefined;
  const group = groups?.AUDIO?.[audioGroupId];
  if (!group) return undefined;
  const renditions = Object.entries(group);
  const withUri = renditions.filter(([, rendition]) => Boolean(rendition.uri));
  if (withUri.length === 0) return undefined;
  const [name, rendition] =
    withUri.find(([, candidate]) => candidate.default === true) ?? withUri[0];
  const uri = rendition.uri;
  if (!uri) return undefined;
  return {
    groupId: audioGroupId,
    name,
    uri,
    ...(masterUrl === undefined
      ? {}
      : { identityUri: queryRedactedUrl(uri, masterUrl) }),
    default: rendition.default === true,
    ...(rendition.autoselect === undefined
      ? {}
      : { autoselect: rendition.autoselect === true }),
    ...(rendition.language === undefined ? {} : { language: rendition.language }),
  };
}

function pickDefaultAudioRendition(
  audioGroupId: string | undefined,
  groups: ParsedMaster["mediaGroups"],
  masterUrl: string | undefined,
): HlsAudioRendition | undefined {
  if (!audioGroupId) return undefined;
  const group = groups?.AUDIO?.[audioGroupId];
  if (!group) return undefined;
  const renditions = Object.entries(group);
  const selected =
    renditions.find(([, candidate]) => candidate.default === true) ??
    renditions.find(([, candidate]) => Boolean(candidate.uri)) ??
    renditions[0];
  if (!selected) return undefined;
  const [name, rendition] = selected;
  return {
    groupId: audioGroupId,
    name,
    ...(rendition.uri === undefined ? {} : { uri: rendition.uri }),
    ...(masterUrl === undefined || rendition.uri === undefined
      ? {}
      : { identityUri: queryRedactedUrl(rendition.uri, masterUrl) }),
    default: rendition.default === true,
    ...(rendition.autoselect === undefined
      ? {}
      : { autoselect: rendition.autoselect === true }),
    ...(rendition.language === undefined ? {} : { language: rendition.language }),
  };
}

export function parseMasterVariants(text: string, masterUrl?: string): HlsVariant[] {
  const parser = new Parser();
  try {
    parser.push(text);
    parser.end();
  } catch {
    return [];
  }
  const m = parser.manifest as ParsedMaster;
  const playlists = m.playlists ?? [];
  return playlists.map((p) => {
    const bandwidth = numericBandwidth(p.attributes.BANDWIDTH) ?? 0;
    const averageBandwidth = numericBandwidth(
      p.attributes["AVERAGE-BANDWIDTH"],
    );
    const audioGroupId = p.attributes.AUDIO;
    const audioRendition = pickAudioRendition(
      audioGroupId,
      m.mediaGroups,
      masterUrl,
    );
    const defaultAudioRendition = pickDefaultAudioRendition(
      audioGroupId,
      m.mediaGroups,
      masterUrl,
    );
    const identityUri =
      masterUrl === undefined ? undefined : queryRedactedUrl(p.uri, masterUrl);
    const audioIdentity = audioGroupId === undefined
      ? undefined
      : {
          groupId: audioGroupId,
          ...(defaultAudioRendition === undefined
            ? {}
            : {
                name: defaultAudioRendition.name,
                ...(defaultAudioRendition.identityUri === undefined
                  ? {}
                  : { uri: defaultAudioRendition.identityUri }),
                ...(defaultAudioRendition.language === undefined
                  ? {}
                  : { language: defaultAudioRendition.language }),
              }),
        };
    const identityInput = identityUri === undefined
      ? undefined
      : {
          uri: identityUri,
          bandwidth,
          ...(averageBandwidth === undefined
            ? {}
            : { averageBandwidth }),
          ...(p.attributes.RESOLUTION?.width === undefined
            ? {}
            : { width: p.attributes.RESOLUTION.width }),
          ...(p.attributes.RESOLUTION?.height === undefined
            ? {}
            : { height: p.attributes.RESOLUTION.height }),
          ...(p.attributes.CODECS === undefined
            ? {}
            : { codecs: p.attributes.CODECS }),
          ...(audioIdentity === undefined ? {} : { audio: audioIdentity }),
        } satisfies HlsVariantIdentityInput;
    return {
      uri: p.uri,
      bandwidth,
      ...(averageBandwidth === undefined
        ? {}
        : { averageBandwidth }),
      width: p.attributes.RESOLUTION?.width,
      height: p.attributes.RESOLUTION?.height,
      codecs: p.attributes.CODECS,
      ...(audioGroupId === undefined ? {} : { audioGroupId }),
      audioRenditionUri: audioRendition?.uri,
      ...(audioRendition === undefined ? {} : { audioRendition }),
      ...(defaultAudioRendition === undefined
        ? {}
        : { defaultAudioRendition }),
      ...(identityInput === undefined ? {} : { identityInput }),
    };
  });
}

export function isMasterPlaylist(text: string): boolean {
  return /\#EXT-X-STREAM-INF/.test(text);
}
