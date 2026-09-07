import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactInventory,
  extensionDirectory,
  inventorySha256,
  loadCanonicalIdentity,
  readJson,
  releaseInputSha256,
  repositoryDirectory,
  sha256File,
  sourceUrlForRef,
  validateDistReleaseIdentity,
  validateSourceRef,
  writeGeneratedReleaseFiles,
} from "./release-utils.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const distDirectory = join(extensionDirectory, "dist");
const artifactsDirectory = join(extensionDirectory, "release-artifacts");
const command = process.argv[2];

function run(executable, args, options = {}) {
  console.log(`\n[release] ${basename(executable)} ${args.join(" ")}`);
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? extensionDirectory,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${basename(executable)} exited with ${result.status ?? "no status"}`);
  }
}

function capture(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? repositoryDirectory,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${basename(executable)} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function gitHead() {
  return capture("git", ["rev-parse", "HEAD"]);
}

function assertVerifiedReleaseSource() {
  const { version } = loadCanonicalIdentity();
  const sourceRef = validateSourceRef(process.env.CLIPHUTCH_VERIFIED_SOURCE_REF, version);
  const head = gitHead();
  const tagCommit = capture("git", ["rev-parse", `refs/tags/${sourceRef}^{commit}`]);
  if (tagCommit !== head) {
    throw new Error(`Verified source tag ${sourceRef} resolves to ${tagCommit}, not HEAD ${head}`);
  }
  const dirty = capture("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) {
    throw new Error(
      `Release source must be a clean tagged tree. Current changes:\n${dirty}`,
    );
  }
  return { sourceRef, head };
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runFoundationChecks() {
  loadCanonicalIdentity();
  run(process.execPath, [join(scriptsDirectory, "typecheck.mjs")]);
  run(process.execPath, [join(scriptsDirectory, "verify-fixtures.mjs")]);
  run(process.execPath, ["--test", join(scriptsDirectory, "release-foundation.test.mjs")]);
  run(process.execPath, [join(extensionDirectory, "node_modules/vitest/vitest.mjs"), "run", "--coverage"]);
  run(npmExecutable(), ["audit", "--omit=dev", "--audit-level=high"]);
  run(npmExecutable(), ["audit", "--audit-level=high"]);
}

function buildAndAudit({ mode, sourceRef = null, sourceCommit }) {
  run(process.execPath, [join(extensionDirectory, "node_modules/vite/bin/vite.js"), "build", "--mode", "production"]);
  writeGeneratedReleaseFiles({ mode, sourceRef, sourceCommit });
  run(
    process.execPath,
    [join(scriptsDirectory, "audit-dist.js"), ...(mode === "development" ? ["--allow-development"] : [])],
  );
}

function verifyDevelopment() {
  runFoundationChecks();
  buildAndAudit({ mode: "development", sourceCommit: gitHead() });
  console.log("\n[release] Development verification passed; packaging remains disabled.");
}

function verifySource() {
  const { sourceRef, head } = assertVerifiedReleaseSource();
  runFoundationChecks();
  buildAndAudit({ mode: "release", sourceRef, sourceCommit: head });
  console.log(`\n[release] Verified source ${sourceRef} (${sourceUrlForRef(sourceRef)})`);
}

function assertReleaseDist() {
  const validation = validateDistReleaseIdentity({ dist: distDirectory });
  if (validation.errors.length > 0) {
    throw new Error(`Release artifact validation failed:\n- ${validation.errors.join("\n- ")}`);
  }
  const metadata = validation.metadata;
  if (!metadata?.releaseEligible || metadata.mode !== "release") {
    throw new Error("dist is not a verified release build");
  }
  if (metadata.sourceInputSha256 !== releaseInputSha256()) {
    throw new Error("Source changed after verify:source; rebuild before packaging");
  }
  const verified = assertVerifiedReleaseSource();
  if (verified.sourceRef !== metadata.sourceRef || verified.head !== metadata.sourceCommit) {
    throw new Error("dist source metadata no longer matches the verified tag/commit");
  }
  return metadata;
}

function packageRelease() {
  const metadata = assertReleaseDist();
  mkdirSync(artifactsDirectory, { recursive: true });
  const archiveName = `${metadata.sourceRef}.zip`;
  const finalArchive = join(artifactsDirectory, archiveName);
  if (existsSync(finalArchive)) {
    throw new Error(`Refusing to overwrite preserved release archive: ${finalArchive}`);
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "cliphutch-package-"));
  const temporaryArchive = join(temporaryDirectory, archiveName);
  const inventory = artifactInventory(distDirectory);
  run("zip", ["-X", "-q", temporaryArchive, ...inventory.map(({ path }) => path)], {
    cwd: distDirectory,
  });
  renameSync(temporaryArchive, finalArchive);
  rmSync(temporaryDirectory, { recursive: true, force: true });

  const state = {
    schemaVersion: 1,
    archive: relative(extensionDirectory, finalArchive),
    sha256: sha256File(finalArchive),
    sourceRef: metadata.sourceRef,
    sourceCommit: metadata.sourceCommit,
    extensionVersion: metadata.extensionVersion,
    artifactContentSha256: inventorySha256(inventory),
    files: inventory,
  };
  writeFileSync(
    join(artifactsDirectory, "release-state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  console.log(`\n[release] ${finalArchive}`);
  console.log(`[release] SHA-256 ${state.sha256}`);
}

function verifyPackage() {
  const statePath = join(artifactsDirectory, "release-state.json");
  if (!existsSync(statePath)) throw new Error("Run npm run package first");
  const state = readJson(statePath);
  const archive = resolve(extensionDirectory, state.archive);
  if (sha256File(archive) !== state.sha256) throw new Error("Archive SHA-256 changed after packaging");

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "cliphutch-verify-"));
  try {
    run("unzip", ["-q", archive, "-d", temporaryDirectory]);
    const extractedInventory = artifactInventory(temporaryDirectory);
    if (JSON.stringify(extractedInventory) !== JSON.stringify(state.files)) {
      throw new Error("Extracted archive inventory differs from the packaged dist inventory");
    }
    const validation = validateDistReleaseIdentity({ dist: temporaryDirectory });
    if (validation.errors.length > 0) {
      throw new Error(`Extracted release failed identity checks:\n- ${validation.errors.join("\n- ")}`);
    }
    run(process.execPath, [join(scriptsDirectory, "audit-dist.js"), "--dist", temporaryDirectory]);
    run(process.execPath, [join(scriptsDirectory, "browser-smoke.mjs"), "--extension-dir", temporaryDirectory]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(`\n[release] exact archive verified: ${state.sha256}`);
}

try {
  if (command === "build-development") {
    buildAndAudit({ mode: "development", sourceCommit: gitHead() });
  }
  else if (command === "verify-development") verifyDevelopment();
  else if (command === "verify-source") verifySource();
  else if (command === "package") packageRelease();
  else if (command === "verify-package") verifyPackage();
  else throw new Error(`Unknown release command: ${String(command)}`);
} catch (error) {
  console.error(`\n[release] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
