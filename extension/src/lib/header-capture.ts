// Pure functions for extracting headers from webRequest events and turning them
// into declarativeNetRequest session rules so the extension's own download
// fetches can replay them. Side-effectful glue lives in background.ts.

export type CapturedHeaders = {
  referer?: string;
  origin?: string;
  userAgent?: string;
  authorization?: string;
  custom?: Record<string, string>;
};

const NAMED_HEADERS: Array<[keyof CapturedHeaders, string]> = [
  ["referer", "referer"],
  ["origin", "origin"],
  ["userAgent", "user-agent"],
  ["authorization", "authorization"],
];

// Headers we deliberately ignore even if they look custom. Either the browser
// always sets them itself (and ours would be ignored or wrong), or replaying
// them is unsafe.
const IGNORED_PREFIXES = ["sec-", "proxy-", "if-"];
const IGNORED_NAMES = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "te",
  "accept",
  "accept-encoding",
  "accept-language",
  "cache-control",
  "pragma",
  "cookie",
  "upgrade-insecure-requests",
  "dnt",
]);

export function extractCapturedHeaders(
  headers: chrome.webRequest.HttpHeader[] | undefined,
): CapturedHeaders {
  const out: CapturedHeaders = {};
  if (!headers) return out;

  const byName = new Map<string, string>();
  for (const h of headers) {
    if (!h.name || h.value === undefined) continue;
    byName.set(h.name.toLowerCase(), h.value);
  }

  for (const [field, headerName] of NAMED_HEADERS) {
    const v = byName.get(headerName);
    if (v) (out as Record<string, string | undefined>)[field as string] = v;
  }

  const custom: Record<string, string> = {};
  for (const [name, value] of byName) {
    if (NAMED_HEADERS.some(([, h]) => h === name)) continue;
    if (IGNORED_NAMES.has(name)) continue;
    if (IGNORED_PREFIXES.some((p) => name.startsWith(p))) continue;
    if (!name.startsWith("x-")) continue;
    custom[name] = value;
  }
  if (Object.keys(custom).length > 0) out.custom = custom;

  return out;
}

// Build the URL filter used for DNR rule matching. For an HLS manifest at
// https://cdn.example.com/v/abc/playlist.m3u8, returns "||cdn.example.com/v/abc/"
// so the segments in the same directory are also matched. For a direct file,
// returns the URL itself, so the rule applies only to that one fetch.
export function buildUrlFilter(url: string, kind: "hls" | "dash" | "direct"): string {
  if (kind === "direct") return url;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/[^/]+$/, "");
    return `||${u.host}${path}`;
  } catch {
    return url;
  }
}

export type DnrHeaderOp = {
  header: string;
  operation: "set";
  value: string;
};

export function buildHeaderOps(captured: CapturedHeaders): DnrHeaderOp[] {
  const ops: DnrHeaderOp[] = [];
  if (captured.referer) ops.push({ header: "referer", operation: "set", value: captured.referer });
  if (captured.origin) ops.push({ header: "origin", operation: "set", value: captured.origin });
  if (captured.userAgent) {
    ops.push({ header: "user-agent", operation: "set", value: captured.userAgent });
  }
  if (captured.authorization) {
    ops.push({ header: "authorization", operation: "set", value: captured.authorization });
  }
  if (captured.custom) {
    for (const [name, value] of Object.entries(captured.custom)) {
      ops.push({ header: name, operation: "set", value });
    }
  }
  return ops;
}

export type RuleInputs = {
  ruleId: number;
  url: string;
  kind: "hls" | "dash" | "direct";
  captured: CapturedHeaders;
  extensionId: string;
};

// Build a single DNR session rule. urlFilter scopes the rule to the
// download's URL space; initiatorDomains scopes it to extension-initiated
// requests, so the page's own player traffic is never modified.
export function buildSessionRule(input: RuleInputs): chrome.declarativeNetRequest.Rule {
  return {
    id: input.ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: buildHeaderOps(input.captured) as unknown as chrome.declarativeNetRequest.ModifyHeaderInfo[],
    },
    condition: {
      urlFilter: buildUrlFilter(input.url, input.kind),
      initiatorDomains: [input.extensionId],
      resourceTypes: [
        "xmlhttprequest" as chrome.declarativeNetRequest.ResourceType,
        "media" as chrome.declarativeNetRequest.ResourceType,
        "other" as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  };
}

export function hasReplayableHeaders(captured: CapturedHeaders): boolean {
  if (captured.referer || captured.origin || captured.userAgent || captured.authorization) {
    return true;
  }
  return Boolean(captured.custom && Object.keys(captured.custom).length > 0);
}
