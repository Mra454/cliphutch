type DomImageCandidate = {
  url: string;
  source: "rendered-image" | "markup";
  width?: number;
  height?: number;
};

const MIN_IMAGE_DIMENSION = 100;
const MIN_IMAGE_AREA = 40_000;
const RESCAN_DELAYS_MS = [250, 1000, 2500];
let lastSignature = "";
let pendingMutationScan: number | undefined;

function absoluteHttpUrl(raw: string): string | undefined {
  if (!raw.trim()) return undefined;
  try {
    const url = new URL(raw.trim(), window.location.href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function bestSrcsetUrl(srcset: string): string | undefined {
  let best: { url: string; score: number } | undefined;
  for (const item of srcset.split(",")) {
    const parts = item.trim().split(/\s+/);
    const rawUrl = parts[0];
    if (!rawUrl) continue;
    const descriptor = parts[1] ?? "1x";
    const score = descriptor.endsWith("w")
      ? Number.parseFloat(descriptor)
      : descriptor.endsWith("x")
        ? Number.parseFloat(descriptor) * 1000
        : 1;
    const url = absoluteHttpUrl(rawUrl);
    if (!url || !Number.isFinite(score)) continue;
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url;
}

function dimensionsForImage(img: HTMLImageElement): { width?: number; height?: number } {
  const rect = img.getBoundingClientRect();
  const width = Math.max(img.naturalWidth, img.width, rect.width);
  const height = Math.max(img.naturalHeight, img.height, rect.height);
  return {
    width: width > 0 ? Math.round(width) : undefined,
    height: height > 0 ? Math.round(height) : undefined,
  };
}

function looksLikeAsset(candidate: DomImageCandidate): boolean {
  if (candidate.width === undefined || candidate.height === undefined) return true;
  const shortSide = Math.min(candidate.width, candidate.height);
  return shortSide >= MIN_IMAGE_DIMENSION && candidate.width * candidate.height >= MIN_IMAGE_AREA;
}

function addCandidate(
  candidates: Map<string, DomImageCandidate>,
  rawUrl: string | undefined | null,
  source: DomImageCandidate["source"],
  dimensions: { width?: number; height?: number } = {},
): void {
  if (!rawUrl) return;
  const url = absoluteHttpUrl(rawUrl);
  if (!url) return;
  const candidate = { url, source, ...dimensions };
  if (!looksLikeAsset(candidate)) return;
  const existing = candidates.get(url);
  if (!existing) {
    candidates.set(url, candidate);
    return;
  }
  if (source === "rendered-image") existing.source = source;
  existing.width = Math.max(existing.width ?? 0, candidate.width ?? 0) || existing.width;
  existing.height = Math.max(existing.height ?? 0, candidate.height ?? 0) || existing.height;
}

function collectImages(): DomImageCandidate[] {
  const candidates = new Map<string, DomImageCandidate>();

  for (const img of document.images) {
    const dimensions = dimensionsForImage(img);
    addCandidate(candidates, img.currentSrc, "rendered-image", dimensions);
    addCandidate(candidates, img.src, "rendered-image", dimensions);
    addCandidate(candidates, bestSrcsetUrl(img.srcset), "rendered-image", dimensions);
  }

  for (const source of document.querySelectorAll("picture source[srcset]")) {
    addCandidate(candidates, bestSrcsetUrl(source.getAttribute("srcset") ?? ""), "markup");
  }

  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[property="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]',
  )) {
    addCandidate(candidates, meta.content, "markup");
  }

  return [...candidates.values()];
}

function sendImages(): void {
  const images = collectImages();
  const signature = images.map((image) => image.url).sort().join("\n");
  if (!images.length || signature === lastSignature) return;
  lastSignature = signature;
  void chrome.runtime.sendMessage({
    type: "dom-images-detected",
    pageUrl: window.location.href,
    pageTitle: document.title,
    images,
  }).catch(() => {});
}

sendImages();
for (const delay of RESCAN_DELAYS_MS) window.setTimeout(sendImages, delay);

const observer = new MutationObserver(() => {
  if (pendingMutationScan !== undefined) return;
  pendingMutationScan = window.setTimeout(() => {
    pendingMutationScan = undefined;
    sendImages();
  }, 100);
});
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "srcset", "poster"],
});
