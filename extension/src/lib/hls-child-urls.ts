import { MAX_MEDIA_CHILD_URLS } from "./media-identity";

export function queryRedactedHlsChildUrls(
  urls: readonly (string | undefined)[],
  limit = MAX_MEDIA_CHILD_URLS,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      const redacted = parsed.href;
      if (seen.has(redacted)) continue;
      seen.add(redacted);
      result.push(redacted);
      if (result.length >= limit) break;
    } catch {
      continue;
    }
  }
  return result;
}
