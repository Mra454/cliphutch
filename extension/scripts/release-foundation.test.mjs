import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  extensionDirectory,
  loadCanonicalIdentity,
  readJson,
  releaseInputInventory,
  renderSourceOffer,
  sourceUrlForRef,
  validateDistReleaseIdentity,
  validateSourceRef,
  writeGeneratedReleaseFiles,
} from "./release-utils.mjs";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const repositoryDirectory = join(extensionDirectory, "..");

function assertC5ManifestDisclosure(rawDisclosure) {
  const disclosure = rawDisclosure.replace(/<[^>]*>/g, " ").replace(/`/g, "").replace(/\s+/g, " ");
  assert.match(disclosure, /normal Capture Pack/i);
  assert.match(disclosure, /required,? redacted _cliphutch-manifest\.json/i);
  assert.match(disclosure, /after all media jobs (?:are )?terminal/i);
  assert.match(disclosure, /optional(?: customer-selected)? CSV/i);
  assert.match(disclosure, /opt in|select CSV/i);
  assert.match(disclosure, /Quick Capture (?:creates (?:no|neither)|does not create)/i);
  assert.match(disclosure, /planned relative (?:download )?path/i);
  assert.match(disclosure, /final basename/i);
  assert.match(disclosure, /source page URL/i);
  assert.match(disclosure, /user information/i);
  assert.match(disclosure, /query/i);
  assert.match(disclosure, /fragment/i);
  assert.match(disclosure, /source (?:media )?host[^.]*never (?:a|the) media URL/i);
  for (const forbidden of [
    /captured headers/i,
    /media URLs? or signed queries/i,
    /Blob URLs/i,
    /license (?:or |\/)?installation data|license\/install/i,
    /quota(?: or |\/)command IDs/i,
    /raw (?:internal )?errors/i,
    /absolute local paths/i,
  ]) {
    assert.match(disclosure, forbidden);
  }
  assert.match(disclosure, /bounded local text Blob/i);
  assert.match(disclosure, /Chrome's download manager/i);
  assert.match(disclosure, /remain(?:s)?[^.]{0,80}until you delete/i);
  assert.match(disclosure, /adds? no (?:new )?permission|does not add (?:a |any )?(?:new )?permission/i);
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "cliphutch-release-test-"));
  mkdirSync(join(root, "release"));
  mkdirSync(join(root, "dist"));
  writeJson(join(root, "manifest.json"), { manifest_version: 3, version: "0.1.3" });
  writeJson(join(root, "package.json"), { name: "fixture", version: "0.1.3" });
  writeJson(join(root, "package-lock.json"), {
    version: "0.1.3",
    packages: { "": { version: "0.1.3" } },
  });
  writeFileSync(
    join(root, "release", "SOURCE_OFFER.release.txt"),
    "{{VERSION}} {{SOURCE_REF}} {{SOURCE_URL}} licenses@cliphutch.com three years @ffmpeg/core 0.12.10 does not patch @ffmpeg/core\n",
  );
  writeFileSync(
    join(root, "release", "SOURCE_OFFER.development.txt"),
    "NOT FOR DISTRIBUTION OR CHROME WEB STORE UPLOAD {{VERSION}} licenses@cliphutch.com three years @ffmpeg/core 0.12.10 does not patch @ffmpeg/core\n",
  );
  writeJson(join(root, "dist", "manifest.json"), { manifest_version: 3, version: "0.1.3" });
  writeFileSync(join(root, "dist", "background.js"), "export {};\n");
  return root;
}

test("the checked-in manifest is the canonical 0.1.4 candidate version", () => {
  assert.equal(loadCanonicalIdentity().version, "0.1.4");
});

test("release input identity excludes generated incremental compiler state", () => {
  const root = fixtureRoot();
  writeFileSync(join(root, "tsconfig.background.tsbuildinfo"), "machine-local state\n");
  const paths = releaseInputInventory(root).map(({ path }) => path);
  assert.equal(paths.includes("tsconfig.background.tsbuildinfo"), false);
});

test("the checked-in manifest exposes one global side panel without replacing the popup", () => {
  const manifest = readJson(join(extensionDirectory, "manifest.json"));
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.deepEqual(manifest.side_panel, { default_path: "sidepanel.html" });
  assert.equal(manifest.action?.default_popup, "popup.html");
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.equal(manifest.permissions.filter((permission) => permission === "sidePanel").length, 1);
  assert.ok(manifest.permissions.includes("alarms"));
  assert.equal(manifest.permissions.filter((permission) => permission === "alarms").length, 1);
  assert.equal(manifest.permissions.length, 7);
  assert.ok(!manifest.permissions.includes("tabs"));
  assert.ok(!manifest.permissions.includes("activeTab"));

  const sidePanelHtml = readFileSync(join(extensionDirectory, "sidepanel.html"), "utf8");
  assert.match(sidePanelHtml, /src="\/src\/sidepanel\/main\.tsx"/);
  assert.match(sidePanelHtml, /id="sidepanel-root"/);
});

test("checked-in C2 disclosures match session-only Hutch and header-lease behavior", () => {
  const firstRun = readFileSync(join(extensionDirectory, "firstrun.html"), "utf8");
  assert.match(firstRun, /\b7 API permissions\b/);
  assert.doesNotMatch(firstRun, /\b[56] API permissions\b/);
  assert.match(firstRun, /<code>alarms<\/code>/);
  assert.match(firstRun, /one-shot local cleanup wake/i);
  assert.match(firstRun, /browser is asleep/i);
  assert.match(firstRun, /chrome\.storage\.session/);
  assert.match(firstRun, /source tab navigates or closes/i);
  assert.match(firstRun, /60 minutes/i);
  assert.match(firstRun, /extension-initiated XMLHttpRequest\/other requests/i);
  assert.match(firstRun, /exact source URL/i);
  assert.match(firstRun, /never\s+used for previews/i);
  assert.match(firstRun, /sent to ClipHutch/i);
  assert.match(firstRun, /written to disk/i);
  assert.match(firstRun, /capture manifest/i);

  for (const relativePath of ["PERMISSIONS.md", "PRIVACY.md"]) {
    const disclosure = readFileSync(join(repositoryDirectory, relativePath), "utf8");
    assert.match(disclosure, /seven Chrome API permissions/i);
    assert.match(disclosure, /`alarms`/);
    assert.match(disclosure, /one-shot local cleanup wake/i);
    assert.match(disclosure, /browser is asleep/i);
    assert.match(disclosure, /chrome\.storage\.session/);
    assert.match(disclosure, /source-tab navigation or close|source tab navigates or closes/i);
    assert.match(disclosure, /60 minutes/i);
    assert.match(disclosure, /exact (?:selected )?source/i);
    assert.match(disclosure, /never (?:used for |supplies )?previews/i);
    assert.match(disclosure, /sent to (?:a )?ClipHutch/i);
    assert.match(disclosure, /written to disk/i);
    assert.match(disclosure, /capture manifest/i);
    assert.match(disclosure, /not accepted for new work/i);
  }

  const storePaste = readFileSync(
    join(repositoryDirectory, "store-assets", "listing-pricing-2026-07-30.md"),
    "utf8",
  );
  assert.match(storePaste, /ClipHutch requests 7 Chrome API permissions/);
  assert.match(storePaste, /alarms permission schedules one-shot local cleanup wakes/i);
  assert.match(storePaste, /source tab navigates or closes/i);
  assert.match(storePaste, /no more than 60 minutes/i);
});

test("checked-in C5 disclosures match terminal local Capture Pack manifest behavior", () => {
  assertC5ManifestDisclosure(readFileSync(join(extensionDirectory, "firstrun.html"), "utf8"));
  assertC5ManifestDisclosure(readFileSync(join(repositoryDirectory, "PERMISSIONS.md"), "utf8"));
  assertC5ManifestDisclosure(readFileSync(join(repositoryDirectory, "PRIVACY.md"), "utf8"));
  assertC5ManifestDisclosure(readFileSync(
    join(repositoryDirectory, "store-assets", "listing-pricing-2026-07-30.md"),
    "utf8",
  ));
});

test("source refs must identify the canonical version", () => {
  assert.equal(validateSourceRef("cliphutch-v0.1.3-test", "0.1.3"), "cliphutch-v0.1.3-test");
  assert.throws(() => validateSourceRef("cliphutch-v0.1.2-old", "0.1.3"));
});

test("release offer names only the explicitly supplied source ref", () => {
  const ref = "cliphutch-v0.1.3-test";
  const offer = renderSourceOffer({ mode: "release", version: "0.1.3", sourceRef: ref });
  assert.match(offer, new RegExp(ref));
  assert.match(offer, new RegExp(sourceUrlForRef(ref).replaceAll(".", "\\.")));
  assert.doesNotMatch(offer, /cliphutch-v0\.1\.2/);
});

test("development artifacts are auditable but never release-eligible", () => {
  const root = fixtureRoot();
  const dist = join(root, "dist");
  writeGeneratedReleaseFiles({
    mode: "development",
    sourceCommit: "fixture-commit",
    root,
    dist,
  });
  assert.ok(validateDistReleaseIdentity({ root, dist }).errors.length > 0);
  assert.deepEqual(
    validateDistReleaseIdentity({ root, dist, allowDevelopment: true }).errors,
    [],
  );
});

test("release metadata, source offer, and artifact content stay consistent", () => {
  const root = fixtureRoot();
  const dist = join(root, "dist");
  const sourceRef = "cliphutch-v0.1.3-test";
  writeGeneratedReleaseFiles({
    mode: "release",
    sourceRef,
    sourceCommit: "fixture-commit",
    root,
    dist,
  });
  assert.deepEqual(validateDistReleaseIdentity({ root, dist }).errors, []);
  writeFileSync(join(dist, "background.js"), "export const changed = true;\n");
  assert.match(
    validateDistReleaseIdentity({ root, dist }).errors.join("\n"),
    /no longer matches/,
  );
});
