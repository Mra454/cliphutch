#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(__dirname, "..");
const REPO_DIR = join(EXTENSION_DIR, "..");
const DIST_DIR = join(EXTENSION_DIR, "dist");

const reset = "\x1b[0m";
const red = "\x1b[31m";
const green = "\x1b[32m";
const yellow = "\x1b[33m";
const dim = "\x1b[2m";
const bold = "\x1b[1m";

const summary = { pass: 0, fail: 0, review: 0 };

function header(title) {
  console.log(`\n${bold}=== ${title} ===${reset}`);
}

function pass(msg) {
  console.log(`  ${green}PASS${reset}  ${msg}`);
  summary.pass++;
}

function fail(msg) {
  console.log(`  ${red}FAIL${reset}  ${msg}`);
  summary.fail++;
}

function review(msg) {
  console.log(`  ${yellow}REVIEW${reset}  ${msg}`);
  summary.review++;
}

function info(msg) {
  console.log(`  ${dim}${msg}${reset}`);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

if (!existsSync(DIST_DIR)) {
  console.error(`${red}dist/ not found at ${DIST_DIR}${reset}`);
  console.error(`Run \`npm run build\` first.`);
  process.exit(2);
}

const allDistFiles = walk(DIST_DIR);
const codeFiles = allDistFiles.filter(
  (f) => /\.(js|html|css)$/.test(f) && !f.endsWith(".map"),
);

if (codeFiles.length === 0) {
  console.error(`${red}No .js/.html/.css files in dist/${reset}`);
  process.exit(2);
}

console.log(`${bold}ClipHutch — pre-submission audit${reset}`);
console.log(`${dim}Scanning ${codeFiles.length} files in ${DIST_DIR}${reset}`);

// ---------------------------------------------------------------------------
// 1. CRITICAL CHECKS — auto-fail
// ---------------------------------------------------------------------------

const CRITICAL_PATTERNS = [
  { name: "eval()",                   re: /\beval\s*\(/ },
  { name: "new Function(",            re: /\bnew\s+Function\s*\(/ },
  { name: "chrome.scripting",         re: /\bchrome\.scripting\b/ },
  { name: "content_scripts reference",re: /\bcontent_scripts\b/ },
  { name: "localStorage",             re: /\blocalStorage\b/ },
  { name: "sessionStorage",           re: /\bsessionStorage\b/ },
  { name: "console.log/error/warn/info/debug",
                                      re: /\bconsole\.(log|error|warn|info|debug|trace)\s*\(/ },
  { name: "downloads.open",           re: /\bdownloads\.open\b/ },
  { name: "remote CDN ref (cdn.)",    re: /\bcdn\./i },
  { name: "googleapis",               re: /\bgoogleapis\b/i },
  { name: "gstatic",                  re: /\bgstatic\b/i },
  { name: "jsdelivr",                 re: /\bjsdelivr\b/i },
  { name: "unpkg",                    re: /\bunpkg\b/i },
  // Telemetry — match library signatures (call-site shapes / domain refs),
  // not English words (firstrun.html legitimately uses "analytics" /
  // "telemetry" in privacy disclosures).
  { name: "Google Analytics (gtag)",  re: /\bgtag\s*\(\s*['"]/ },
  { name: "Google Analytics (legacy)",re: /\b_gaq\b|\bga\s*\(\s*['"]send['"]/ },
  { name: "Google Tag Manager",       re: /\bgoogletagmanager\b/i },
  { name: "Mixpanel",                 re: /\bmixpanel\s*\.\s*(track|init|identify)/ },
  { name: "Amplitude",                re: /\bamplitude\s*\.\s*(track|init|getInstance)/ },
  { name: "Segment.io",               re: /\bsegment\.io\b|\banalytics\s*\.\s*track\s*\(/ },
  { name: "Sentry",                   re: /\bSentry\s*\.\s*init\s*\(/ },
  { name: "PostHog",                  re: /\bposthog\s*\.\s*(init|capture)/ },
];

header("CRITICAL — forbidden patterns in dist/ code");
let criticalHits = 0;
for (const file of codeFiles) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const { name, re } of CRITICAL_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        const snippet = lines[i].trim().slice(0, 140);
        fail(`${name} — ${relative(EXTENSION_DIR, file)}:${i + 1}\n          ${dim}${snippet}${reset}`);
        criticalHits++;
      }
    }
  }
}
if (criticalHits === 0) pass("no critical pattern matches");

// ---------------------------------------------------------------------------
// 2. REVIEW — http/https/dynamic-import occurrences
// ---------------------------------------------------------------------------

header("REVIEW — http/https URLs and dynamic imports");
const REVIEW_PATTERNS = [
  { name: "http://",       re: /http:\/\/[^\s'"`,)<>]+/g },
  { name: "https://",      re: /https:\/\/[^\s'"`,)<>]+/g },
  { name: "import(",       re: /\bimport\s*\(/g },
];
let reviewHits = 0;
for (const file of codeFiles) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const { name, re } of REVIEW_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].match(re);
      if (matches) {
        for (const m of matches) {
          review(`${name} — ${relative(EXTENSION_DIR, file)}:${i + 1}\n          ${dim}${m.slice(0, 100)}${reset}`);
          reviewHits++;
        }
      }
    }
  }
}
if (reviewHits === 0) info("(none found)");
else info(`${reviewHits} item(s) above need a one-time human read; not auto-failed.`);

// ---------------------------------------------------------------------------
// 3. MANIFEST — strict invariants
// ---------------------------------------------------------------------------

header("MANIFEST — invariants");
const manifestPath = join(DIST_DIR, "manifest.json");
if (!existsSync(manifestPath)) {
  fail(`manifest.json missing at ${manifestPath}`);
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  if (manifest.manifest_version === 3) pass("manifest_version === 3");
  else fail(`manifest_version is ${manifest.manifest_version}, expected 3`);

  if (manifest.minimum_chrome_version === "116") pass(`minimum_chrome_version === "116"`);
  else fail(`minimum_chrome_version is "${manifest.minimum_chrome_version}", expected "116"`);

  const expectedPerms = [
    "webRequest",
    "storage",
    "downloads",
    "offscreen",
    "declarativeNetRequestWithHostAccess",
  ];
  const perms = manifest.permissions ?? [];
  if (
    perms.length === expectedPerms.length &&
    expectedPerms.every((p) => perms.includes(p))
  ) {
    pass(`permissions match: [${expectedPerms.join(", ")}]`);
  } else {
    fail(`permissions mismatch — got [${perms.join(", ")}], expected [${expectedPerms.join(", ")}]`);
  }

  for (const banned of ["tabs", "activeTab", "downloads.open"]) {
    if (perms.includes(banned)) fail(`forbidden permission present: "${banned}"`);
    else pass(`forbidden permission absent: "${banned}"`);
  }

  const expectedHosts = ["http://*/*", "https://*/*"];
  const hosts = manifest.host_permissions ?? [];
  if (hosts.length === expectedHosts.length && expectedHosts.every((h) => hosts.includes(h))) {
    pass(`host_permissions match: [${expectedHosts.join(", ")}]`);
  } else {
    fail(`host_permissions mismatch — got [${hosts.join(", ")}]`);
  }

  if (!manifest.web_accessible_resources || manifest.web_accessible_resources.length === 0) {
    pass("web_accessible_resources absent or empty");
  } else {
    fail(`web_accessible_resources present: ${JSON.stringify(manifest.web_accessible_resources)}`);
  }

  const contentScripts = manifest.content_scripts ?? [];
  if (
    contentScripts.length === 1 &&
    contentScripts[0].matches?.length === 2 &&
    contentScripts[0].matches.includes("http://*/*") &&
    contentScripts[0].matches.includes("https://*/*") &&
    contentScripts[0].js?.length === 1 &&
    contentScripts[0].js[0] === "content-script.js" &&
    contentScripts[0].run_at === "document_idle"
  ) {
    pass("content_scripts match DOM image scanner");
  } else {
    fail(`content_scripts mismatch: ${JSON.stringify(contentScripts)}`);
  }
}

// ---------------------------------------------------------------------------
// 4. STORAGE — usage check
// ---------------------------------------------------------------------------

header("STORAGE — chrome.storage usage");
const allCode = codeFiles.map((f) => readFileSync(f, "utf8")).join("\n");
const sessionUsed = /chrome\.storage\.session/.test(allCode);
const localUsed = /chrome\.storage\.local/.test(allCode);
const syncUsed = /chrome\.storage\.sync/.test(allCode);

if (sessionUsed) pass("chrome.storage.session referenced (detected videos)");
else fail("chrome.storage.session not referenced — detection storage missing?");

if (localUsed) pass("chrome.storage.local referenced (user settings)");
else fail("chrome.storage.local not referenced — settings storage missing?");

if (syncUsed) review("chrome.storage.sync referenced — document why if intentional");
else pass("chrome.storage.sync not referenced (expected)");

// ---------------------------------------------------------------------------
// 5. GPL / THIRD-PARTY NOTICE FILES
// ---------------------------------------------------------------------------

header("GPL — bundled ffmpeg notices");
const requiredNoticeFiles = [
  "THIRD_PARTY_NOTICES.txt",
  "SOURCE_OFFER.txt",
  "licenses/GPL-2.0.txt",
  "licenses/MIT-ffmpegwasm.txt",
  "licenses/MIT-fast-xml-parser.txt",
  "licenses/MIT-react.txt",
  "licenses/Apache-2.0-m3u8-parser.txt",
  "licenses/Apache-2.0-muxjs.txt",
  "licenses/BSD-3-Clause-mp4box.txt",
  "ffmpeg-core/ffmpeg-core.js",
  "ffmpeg-core/ffmpeg-core.wasm",
];
for (const file of requiredNoticeFiles) {
  const fullPath = join(DIST_DIR, file);
  if (existsSync(fullPath)) pass(`${file} present`);
  else fail(`${file} missing`);
}

const thirdPartyNoticePath = join(DIST_DIR, "THIRD_PARTY_NOTICES.txt");
const sourceOfferPath = join(DIST_DIR, "SOURCE_OFFER.txt");
if (existsSync(thirdPartyNoticePath)) {
  const notice = readFileSync(thirdPartyNoticePath, "utf8");
  const requiredNoticeTerms = [
    /@ffmpeg\/core[\s\S]*GPL-2\.0-or-later/,
    /@ffmpeg\/ffmpeg[\s\S]*MIT/,
    /@ffmpeg\/util[\s\S]*MIT/,
    /fast-xml-parser[\s\S]*MIT/,
    /m3u8-parser[\s\S]*Apache-2\.0/,
    /mp4box[\s\S]*BSD-3-Clause/,
    /mux\.js[\s\S]*Apache-2\.0/,
    /react 18\.3\.1[\s\S]*MIT/,
    /react-dom[\s\S]*MIT/,
  ];
  const missing = requiredNoticeTerms.filter((re) => !re.test(notice));
  if (missing.length === 0) {
    pass("third-party notice identifies bundled runtime dependencies and licenses");
  } else {
    fail(`third-party notice missing ${missing.length} required dependency/license entries`);
  }
}
if (existsSync(sourceOfferPath)) {
  const offer = readFileSync(sourceOfferPath, "utf8");
  const requiredOfferTerms = [
    /cliphutch-v0\.1\.0-cws-submit-2026-05-14-r2/,
    /github\.com\/Mra454\/cliphutch\/releases\/tag\/cliphutch-v0\.1\.0-cws-submit-2026-05-14-r2/,
    /licenses@cliphutch\.com/,
    /three years/,
    /@ffmpeg\/core 0\.12\.10/,
    /does not patch @ffmpeg\/core/,
  ];
  const missing = requiredOfferTerms.filter((re) => !re.test(offer));
  if (missing.length === 0) {
    pass("source-code offer includes tag, repo, contact email, duration, and ffmpeg provenance");
  } else {
    fail(`source-code offer missing ${missing.length} required term(s)`);
  }
}

// ---------------------------------------------------------------------------
// 6. POLICY — marketing/positioning language
// ---------------------------------------------------------------------------

const POLICY_FORBIDDEN = [
  /\bany\s+site\b/i,
  /\bany\s+video\b/i,
  /\brip\s+(?:videos?|content|streams?|files?)\b/i,
  /\bgrab\s+(?:videos?|content|streams?|files?)\b/i,
  /\bbypass\b/i,
  /\bunblock\b/i,
  /\bunlock\b/i,
  /\bfree\s+download\s+from\b/i,
];
const PLATFORM_NAMES = [/\bYouTube\b/i, /\bVimeo\b/i, /\bNetflix\b/i, /\bSquarespace\b/i];

const docFiles = [
  join(REPO_DIR, "PRIVACY.md"),
  join(REPO_DIR, "PERMISSIONS.md"),
  join(REPO_DIR, "README.md"),
  join(REPO_DIR, "fixtures/README.md"),
].filter((f) => existsSync(f));

const policyTargets = [...codeFiles, ...docFiles];

header("POLICY — positioning and platform-name flags");
let policyHits = 0;
for (const file of policyTargets) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  for (const re of POLICY_FORBIDDEN) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        review(`positioning: ${re} — ${relative(REPO_DIR, file)}:${i + 1}\n          ${dim}${lines[i].trim().slice(0, 140)}${reset}`);
        policyHits++;
      }
    }
  }
  for (const re of PLATFORM_NAMES) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        review(`platform name: ${re} — ${relative(REPO_DIR, file)}:${i + 1}\n          ${dim}${lines[i].trim().slice(0, 140)}${reset}`);
        policyHits++;
      }
    }
  }
}
if (policyHits === 0) pass("no marketing/positioning flags");

// ---------------------------------------------------------------------------
// 7. MANUAL CHECKLIST
// ---------------------------------------------------------------------------

header("MANUAL CHECKLIST — must complete before store submission");
const todoTargets = [
  ...allDistFiles.filter((f) => /\.(html|js|css)$/.test(f) && !f.endsWith(".map")),
  ...docFiles,
];
const todoCounts = { TODO_COPY: 0, TODO_LINK: 0, TODO_EMAIL: 0 };
for (const file of todoTargets) {
  const text = readFileSync(file, "utf8");
  for (const k of Object.keys(todoCounts)) {
    const matches = text.match(new RegExp(k, "g"));
    if (matches) todoCounts[k] += matches.length;
  }
}
console.log(`  [ ] Replace TODO_COPY markers (${todoCounts.TODO_COPY} remaining)`);
console.log(`  [ ] Replace TODO_LINK markers (${todoCounts.TODO_LINK} remaining)`);
console.log(`  [ ] Replace TODO_EMAIL markers (${todoCounts.TODO_EMAIL} remaining)`);
console.log(`  [ ] Generate real icons (replace solid-color placeholders in extension/public/icons/)`);
console.log(`  [ ] Generate Chrome Web Store screenshots`);
console.log(`  [ ] Write store listing copy (store-listing-safe positioning, NOT marketing-aspirational)`);
console.log(`  [ ] Register Chrome Web Store developer account ($5)`);
console.log(`  [ ] Run: npm run build && npm run package  →  upload extension/dist.zip`);
console.log(`  [ ] Submit for review`);

// ---------------------------------------------------------------------------
// 8. NETWORK AUDIT (manual)
// ---------------------------------------------------------------------------

header("NETWORK AUDIT — manual procedure");
console.log(`  1. chrome://extensions → toggle Developer mode → Load unpacked dist/`);
console.log(`  2. Open DevTools on the service worker (Inspect views: service worker → Network tab).`);
console.log(`  3. Detect a video on a real site, then download direct + HLS.`);
console.log(`  4. Confirm every outbound request is one of:`);
console.log(`        - the source page's own video URLs (HLS playlist + segments on download)`);
console.log(`        - chrome-extension:// internal URLs`);
console.log(`     Forbidden: any developer-server fetch, analytics endpoint, update server other than Chrome's own.`);
console.log(`  5. Optionally export with chrome://net-export/ for an audit log.`);

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------

header("SUMMARY");
console.log(`  ${green}PASS${reset}: ${summary.pass}`);
console.log(`  ${red}FAIL${reset}: ${summary.fail}`);
console.log(`  ${yellow}REVIEW${reset}: ${summary.review}  (manual judgment needed; not auto-failed)`);

if (summary.fail > 0) {
  console.log(`\n${red}${bold}OVERALL: FAIL${reset} — fix the ${summary.fail} hard failure(s) above before submitting.`);
  process.exit(1);
} else {
  console.log(`\n${green}${bold}OVERALL: PASS${reset} (review items still need a one-time eyeball; manual checklist must be completed before submission).`);
  process.exit(0);
}
