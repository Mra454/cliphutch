import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const extensionDirectory = resolve(scriptsDirectory, "..");
export const repositoryDirectory = resolve(extensionDirectory, "..");

const excludedInputDirectories = new Set([
  "coverage",
  "dist",
  "node_modules",
  "release-artifacts",
]);
const excludedInputSuffixes = [".tsbuildinfo"];

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function listFiles(root, { excludeMetadata = false } = {}) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const path = relative(root, absolute).split(sep).join("/");
        if (!excludeMetadata || path !== "RELEASE_METADATA.json") files.push(path);
      }
    }
  }
  visit(root);
  return files.sort((a, b) => a.localeCompare(b, "en"));
}

export function artifactInventory(root, options) {
  return listFiles(root, options).map((path) => {
    const absolute = join(root, path);
    return { path, bytes: statSync(absolute).size, sha256: sha256File(absolute) };
  });
}

export function inventorySha256(inventory) {
  return sha256(
    inventory.map(({ path, bytes, sha256: hash }) => `${path}\0${bytes}\0${hash}\n`).join(""),
  );
}

export function releaseInputInventory(root = extensionDirectory) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && excludedInputDirectories.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (
        entry.isFile() &&
        entry.name !== ".DS_Store" &&
        !entry.name.endsWith(".zip") &&
        !excludedInputSuffixes.some((suffix) => entry.name.endsWith(suffix))
      ) {
        files.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  }
  visit(root);
  files.sort((a, b) => a.localeCompare(b, "en"));
  return files.map((path) => {
    const absolute = join(root, path);
    return { path, bytes: statSync(absolute).size, sha256: sha256File(absolute) };
  });
}

export function releaseInputSha256(root = extensionDirectory) {
  return inventorySha256(releaseInputInventory(root));
}

export function loadCanonicalIdentity(root = extensionDirectory) {
  const manifest = readJson(join(root, "manifest.json"));
  const packageJson = readJson(join(root, "package.json"));
  const packageLock = readJson(join(root, "package-lock.json"));
  const versions = {
    manifest: manifest.version,
    package: packageJson.version,
    lock: packageLock.version,
    lockRoot: packageLock.packages?.[""]?.version,
  };
  const expected = versions.manifest;
  for (const [owner, version] of Object.entries(versions)) {
    if (version !== expected) {
      throw new Error(
        `Release version mismatch: manifest=${expected}, ${owner}=${String(version)}`,
      );
    }
  }
  return { version: expected, manifest, packageJson, packageLock };
}

export function validateSourceRef(sourceRef, version) {
  const prefix = `cliphutch-v${version}`;
  if (
    typeof sourceRef !== "string" ||
    !(sourceRef === prefix || sourceRef.startsWith(`${prefix}-`)) ||
    !/^[A-Za-z0-9._-]+$/.test(sourceRef)
  ) {
    throw new Error(
      `Verified source ref must be a tag beginning with ${prefix}; got ${JSON.stringify(sourceRef)}`,
    );
  }
  return sourceRef;
}

export function sourceUrlForRef(sourceRef) {
  return `https://github.com/Mra454/cliphutch/releases/tag/${encodeURIComponent(sourceRef)}`;
}

function renderTemplate(path, replacements) {
  let text = readFileSync(path, "utf8");
  for (const [token, value] of Object.entries(replacements)) {
    text = text.replaceAll(`{{${token}}}`, value);
  }
  const unresolved = text.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolved) throw new Error(`Unresolved source-offer token(s): ${unresolved.join(", ")}`);
  return text;
}

export function renderSourceOffer({
  mode,
  version,
  sourceRef = null,
  root = extensionDirectory,
}) {
  if (mode === "release") {
    const verifiedRef = validateSourceRef(sourceRef, version);
    return renderTemplate(join(root, "release", "SOURCE_OFFER.release.txt"), {
      VERSION: version,
      SOURCE_REF: verifiedRef,
      SOURCE_URL: sourceUrlForRef(verifiedRef),
    });
  }
  if (mode === "development") {
    return renderTemplate(join(root, "release", "SOURCE_OFFER.development.txt"), {
      VERSION: version,
    });
  }
  throw new Error(`Unknown build mode: ${mode}`);
}

export function writeGeneratedReleaseFiles({
  mode,
  sourceRef = null,
  sourceCommit,
  root = extensionDirectory,
  dist = join(root, "dist"),
}) {
  if (!existsSync(dist)) throw new Error(`Build output is missing: ${dist}`);
  const { version } = loadCanonicalIdentity(root);
  const verifiedRef = mode === "release" ? validateSourceRef(sourceRef, version) : null;
  writeFileSync(
    join(dist, "SOURCE_OFFER.txt"),
    renderSourceOffer({ mode, version, sourceRef: verifiedRef, root }),
  );
  const contentInventory = artifactInventory(dist, { excludeMetadata: true });
  const metadata = {
    schemaVersion: 1,
    mode,
    releaseEligible: mode === "release",
    extensionVersion: version,
    sourceRef: verifiedRef,
    sourceUrl: verifiedRef ? sourceUrlForRef(verifiedRef) : null,
    sourceCommit,
    sourceInputSha256: releaseInputSha256(root),
    artifactContentSha256: inventorySha256(contentInventory),
    artifactFileCount: contentInventory.length,
  };
  writeFileSync(join(dist, "RELEASE_METADATA.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export function validateDistReleaseIdentity({
  dist,
  root = extensionDirectory,
  allowDevelopment = false,
}) {
  const errors = [];
  let identity;
  try {
    identity = loadCanonicalIdentity(root);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { errors, metadata: null };
  }

  const manifestPath = join(dist, "manifest.json");
  const metadataPath = join(dist, "RELEASE_METADATA.json");
  const offerPath = join(dist, "SOURCE_OFFER.txt");
  if (!existsSync(manifestPath)) errors.push("Built manifest.json is missing");
  if (!existsSync(metadataPath)) errors.push("RELEASE_METADATA.json is missing");
  if (!existsSync(offerPath)) errors.push("Generated SOURCE_OFFER.txt is missing");
  if (errors.length > 0) return { errors, metadata: null };

  const builtManifest = readJson(manifestPath);
  const metadata = readJson(metadataPath);
  const offer = readFileSync(offerPath, "utf8");
  if (builtManifest.version !== identity.version) {
    errors.push(
      `Built manifest version ${String(builtManifest.version)} does not match ${identity.version}`,
    );
  }
  if (metadata.extensionVersion !== identity.version) {
    errors.push(
      `Artifact metadata version ${String(metadata.extensionVersion)} does not match ${identity.version}`,
    );
  }
  const contentInventory = artifactInventory(dist, { excludeMetadata: true });
  const contentHash = inventorySha256(contentInventory);
  if (metadata.artifactContentSha256 !== contentHash) {
    errors.push("Artifact content no longer matches RELEASE_METADATA.json");
  }
  if (metadata.artifactFileCount !== contentInventory.length) {
    errors.push("Artifact file count no longer matches RELEASE_METADATA.json");
  }

  const requiredOfferTerms = [
    "licenses@cliphutch.com",
    "@ffmpeg/core 0.12.10",
    "does not patch @ffmpeg/core",
  ];
  for (const term of requiredOfferTerms) {
    if (!offer.includes(term)) errors.push(`SOURCE_OFFER.txt is missing: ${term}`);
  }

  if (metadata.mode === "release") {
    if (!offer.includes("three years")) {
      errors.push("Release SOURCE_OFFER.txt is missing: three years");
    }
    try {
      validateSourceRef(metadata.sourceRef, identity.version);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (!metadata.releaseEligible) errors.push("Release metadata is not release-eligible");
    if (!offer.includes(metadata.sourceRef ?? "__missing_source_ref__")) {
      errors.push("SOURCE_OFFER.txt does not name the metadata source ref");
    }
    if (!offer.includes(metadata.sourceUrl ?? "__missing_source_url__")) {
      errors.push("SOURCE_OFFER.txt does not name the metadata source URL");
    }
  } else if (metadata.mode === "development") {
    if (!allowDevelopment) {
      errors.push("Development build is not eligible for release audit or packaging");
    }
    if (metadata.releaseEligible) errors.push("Development metadata is marked release-eligible");
    if (!offer.includes("NOT FOR DISTRIBUTION OR CHROME WEB STORE UPLOAD")) {
      errors.push("Development source notice is missing its distribution warning");
    }
  } else {
    errors.push(`Unknown artifact mode: ${String(metadata.mode)}`);
  }
  return { errors, metadata };
}
