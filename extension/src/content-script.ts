import type { MediaProvenance } from "./types";

type DomImageCandidate = {
  url: string;
  source: "rendered-image" | "markup";
  width?: number;
  height?: number;
  provenance: MediaProvenance[];
  familyId?: string;
};

type CandidateAccumulator = DomImageCandidate & { familyConflict?: boolean };

const MIN_IMAGE_DIMENSION = 100;
const MIN_IMAGE_AREA = 40_000;
const RESCAN_DELAYS_MS = [250, 1000, 2500];
const IMAGE_MESSAGE_BATCH_SIZE = 500;
const LAZY_URL_ATTRIBUTES = [
  "data-src",
  "data-lazy-src",
  "data-original",
  "data-flickity-lazyload",
] as const;
const LAZY_SRCSET_ATTRIBUTES = ["data-srcset", "data-lazy-srcset"] as const;
const PROVENANCE_ORDER: readonly MediaProvenance[] = [
  "network",
  "rendered-image",
  "picture",
  "metadata",
  "poster",
];
let lastSignature = "";
let lastPageContextUrl = "";
let pendingMutationScan: number | undefined;
let nextFamilyId = 0;
const familyIds = new WeakMap<Element, string>();
const familyNamespace = typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function familyIdFor(element: Element): string {
  const existing = familyIds.get(element);
  if (existing) return existing;
  nextFamilyId += 1;
  const id = `dom-image-v1:${familyNamespace}:${nextFamilyId.toString(36)}`;
  familyIds.set(element, id);
  return id;
}

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
  const pairs = [
    { width: img.naturalWidth, height: img.naturalHeight },
    { width: rect.width, height: rect.height },
    { width: img.width, height: img.height },
  ];
  const pair = pairs.find(({ width, height }) =>
    Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
  );
  return pair
    ? { width: Math.round(pair.width), height: Math.round(pair.height) }
    : {};
}

function looksLikeAsset(candidate: DomImageCandidate): boolean {
  if (candidate.width === undefined || candidate.height === undefined) return true;
  const shortSide = Math.min(candidate.width, candidate.height);
  return shortSide >= MIN_IMAGE_DIMENSION && candidate.width * candidate.height >= MIN_IMAGE_AREA;
}

function preferredDimensions(
  existing: Pick<DomImageCandidate, "width" | "height">,
  candidate: Pick<DomImageCandidate, "width" | "height">,
): Pick<DomImageCandidate, "width" | "height"> {
  const existingComplete = existing.width !== undefined && existing.height !== undefined;
  const candidateComplete = candidate.width !== undefined && candidate.height !== undefined;
  if (existingComplete && candidateComplete) {
    return candidate.width! * candidate.height! > existing.width! * existing.height!
      ? { width: candidate.width, height: candidate.height }
      : { width: existing.width, height: existing.height };
  }
  if (candidateComplete) return { width: candidate.width, height: candidate.height };
  if (existingComplete) return { width: existing.width, height: existing.height };
  if (candidate.width !== undefined || candidate.height !== undefined) {
    return { width: candidate.width, height: candidate.height };
  }
  return { width: existing.width, height: existing.height };
}

function addCandidate(
  candidates: Map<string, CandidateAccumulator>,
  rawUrl: string | undefined | null,
  source: DomImageCandidate["source"],
  provenance: MediaProvenance,
  dimensions: { width?: number; height?: number } = {},
  familyId?: string,
): void {
  if (!rawUrl) return;
  const url = absoluteHttpUrl(rawUrl);
  if (!url) return;
  const candidate: CandidateAccumulator = {
    url,
    source,
    ...dimensions,
    provenance: [provenance],
    familyId,
  };
  if (!looksLikeAsset(candidate)) return;
  const existing = candidates.get(url);
  if (!existing) {
    candidates.set(url, candidate);
    return;
  }
  if (source === "rendered-image") existing.source = source;
  const selectedDimensions = preferredDimensions(existing, candidate);
  existing.width = selectedDimensions.width;
  existing.height = selectedDimensions.height;
  existing.provenance = PROVENANCE_ORDER.filter(
    (entry) => existing.provenance.includes(entry) || candidate.provenance.includes(entry),
  );
  if (
    !existing.familyConflict &&
    existing.familyId &&
    candidate.familyId &&
    existing.familyId !== candidate.familyId
  ) {
    existing.familyId = undefined;
    existing.familyConflict = true;
  } else if (!existing.familyConflict && !existing.familyId) {
    existing.familyId = candidate.familyId;
  }
}

function collectImages(): DomImageCandidate[] {
  const candidates = new Map<string, CandidateAccumulator>();

  for (const img of document.images) {
    const dimensions = dimensionsForImage(img);
    const familyId = familyIdFor(img);
    addCandidate(candidates, img.currentSrc, "rendered-image", "rendered-image", dimensions, familyId);
    addCandidate(candidates, img.src, "rendered-image", "rendered-image", dimensions, familyId);
    addCandidate(
      candidates,
      bestSrcsetUrl(img.srcset),
      "rendered-image",
      "rendered-image",
      dimensions,
      familyId,
    );
    for (const attribute of LAZY_URL_ATTRIBUTES) {
      addCandidate(
        candidates,
        img.getAttribute(attribute),
        "rendered-image",
        "rendered-image",
        dimensions,
        familyId,
      );
    }
    for (const attribute of LAZY_SRCSET_ATTRIBUTES) {
      addCandidate(
        candidates,
        bestSrcsetUrl(img.getAttribute(attribute) ?? ""),
        "rendered-image",
        "rendered-image",
        dimensions,
        familyId,
      );
    }
  }

  for (const source of document.querySelectorAll<HTMLSourceElement>("picture source")) {
    const picture = source.closest("picture");
    const image = picture?.querySelector("img");
    const familyElement = image ?? picture ?? source;
    const familyId = familyIdFor(familyElement);
    const dimensions = image ? dimensionsForImage(image) : {};
    addCandidate(
      candidates,
      bestSrcsetUrl(source.getAttribute("srcset") ?? ""),
      "markup",
      "picture",
      dimensions,
      familyId,
    );
    for (const attribute of LAZY_SRCSET_ATTRIBUTES) {
      addCandidate(
        candidates,
        bestSrcsetUrl(source.getAttribute(attribute) ?? ""),
        "markup",
        "picture",
        dimensions,
        familyId,
      );
    }
  }

  for (const meta of document.querySelectorAll<HTMLMetaElement>(
    'meta[property="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]',
  )) {
    addCandidate(candidates, meta.content, "markup", "metadata");
  }

  for (const video of document.querySelectorAll<HTMLVideoElement>("video[poster]")) {
    addCandidate(
      candidates,
      video.getAttribute("poster"),
      "markup",
      "poster",
      {},
      familyIdFor(video),
    );
  }

  return [...candidates.values()].map((candidate) => ({
    url: candidate.url,
    source: candidate.source,
    width: candidate.width,
    height: candidate.height,
    provenance: [...candidate.provenance],
    familyId: candidate.familyId,
  }));
}

function sendPageContextIfChanged(): void {
  const pageUrl = window.location.href;
  if (pageUrl === lastPageContextUrl) return;
  lastPageContextUrl = pageUrl;
  void chrome.runtime.sendMessage({
    type: "content-page-context",
    pageUrl,
    pageTitle: document.title,
  }).catch(() => {});
}

function sendImages(): void {
  sendPageContextIfChanged();
  const images = collectImages();
  const signature = JSON.stringify(
    {
      pageUrl: window.location.href,
      pageTitle: document.title,
      images: [...images]
        .sort((left, right) => left.url.localeCompare(right.url))
        .map((image) => ({
          url: image.url,
          source: image.source,
          width: image.width,
          height: image.height,
          provenance: image.provenance,
          familyId: image.familyId,
        })),
    },
  );
  if (!images.length || signature === lastSignature) return;
  lastSignature = signature;
  // Runtime messages are intentionally bounded, but every collected candidate
  // is sent. The background applies each chunk under one tab-scoped lock, so a
  // 500+ image page is accounted for instead of being silently truncated.
  for (let offset = 0; offset < images.length; offset += IMAGE_MESSAGE_BATCH_SIZE) {
    void chrome.runtime.sendMessage({
      type: "dom-images-detected",
      pageUrl: window.location.href,
      pageTitle: document.title,
      images: images.slice(offset, offset + IMAGE_MESSAGE_BATCH_SIZE),
    }).catch(() => {});
  }
}

function scheduleImageScan(): void {
  if (pendingMutationScan !== undefined) return;
  pendingMutationScan = window.setTimeout(() => {
    pendingMutationScan = undefined;
    sendImages();
  }, 100);
}

sendImages();
for (const delay of RESCAN_DELAYS_MS) window.setTimeout(sendImages, delay);

const observer = new MutationObserver(scheduleImageScan);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: [
    "src",
    "srcset",
    "poster",
    ...LAZY_URL_ATTRIBUTES,
    ...LAZY_SRCSET_ATTRIBUTES,
  ],
});

// Intrinsic dimensions often become available without another DOM mutation.
document.addEventListener("load", (event) => {
  if (event.target instanceof HTMLImageElement || event.target instanceof HTMLVideoElement) {
    scheduleImageScan();
  }
}, true);
window.addEventListener("hashchange", scheduleImageScan);
window.addEventListener("popstate", scheduleImageScan);

// Chrome's Navigation API observes History API route changes without polling.
const navigation = (window as unknown as {
  navigation?: { addEventListener(type: "currententrychange", listener: () => void): void };
}).navigation;
navigation?.addEventListener("currententrychange", scheduleImageScan);
