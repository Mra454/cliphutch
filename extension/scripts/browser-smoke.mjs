import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { readJson } from "./release-utils.mjs";

const extensionDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directoryIndex = process.argv.indexOf("--extension-dir");
const unpackedDirectory = resolve(
  extensionDirectory,
  directoryIndex >= 0 ? process.argv[directoryIndex + 1] : "dist",
);

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next explicit platform path.
    }
  }
  throw new Error("Chrome executable not found. Set CHROME_PATH for exact-archive smoke tests.");
}

const manifest = readJson(resolve(unpackedDirectory, "manifest.json"));
assert.ok(manifest.permissions?.includes("sidePanel"), "manifest must request sidePanel");
assert.equal(
  manifest.side_panel?.default_path,
  "sidepanel.html",
  "manifest must declare the global side-panel page",
);
assert.equal(
  manifest.action?.default_popup,
  "popup.html",
  "the first side-panel release must preserve the toolbar popup",
);
const browser = await puppeteer.launch({
  executablePath: await chromeExecutable(),
  headless: true,
  enableExtensions: [unpackedDirectory],
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  let extension;
  const deadline = Date.now() + 8_000;
  while (!extension && Date.now() < deadline) {
    extension = [...(await browser.extensions()).values()].find(
      (candidate) => candidate.name === manifest.name,
    );
    if (!extension) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.ok(extension, `Chrome did not load ${manifest.name} from ${unpackedDirectory}`);

  let worker;
  const workerDeadline = Date.now() + 8_000;
  while (!worker && Date.now() < workerDeadline) {
    worker = (await extension.workers())[0];
    if (!worker) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.ok(worker, "ClipHutch service worker did not become available");
  const panelOptions = await worker.evaluate(() => chrome.sidePanel.getOptions({}));
  assert.equal(panelOptions.path, "sidepanel.html", "Chrome did not register the global side panel");

  for (const pageName of [
    "popup.html",
    "sidepanel.html",
    "options.html",
    "firstrun.html",
    "offscreen.html",
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(`chrome-extension://${extension.id}/${pageName}`, {
      waitUntil: "load",
    });
    assert.ok(response, `${pageName} did not return a response`);
    assert.equal(response.status(), 200, `${pageName} returned ${response.status()}`);
    assert.ok((await page.content()).length > 100, `${pageName} rendered an empty document`);
    if (pageName === "sidepanel.html") {
      await page.waitForSelector("[data-cliphutch-sidepanel-root]", { timeout: 4_000 });
    }
    assert.deepEqual(errors, [], `${pageName} raised page errors: ${errors.join("; ")}`);
    await page.close();
  }

  // Exercise Chrome's real user-gesture gate without coupling the release
  // smoke to a particular popup layout. The customer-facing Open Hutch button
  // is separately exercised by the store-asset workflow.
  const openHarness = await browser.newPage();
  await openHarness.goto(`chrome-extension://${extension.id}/firstrun.html`, {
    waitUntil: "load",
  });
  const windowId = await openHarness.evaluate(async () => (await chrome.windows.getCurrent()).id);
  assert.equal(typeof windowId, "number", "side-panel smoke could not resolve its Chrome window");
  await openHarness.evaluate((targetWindowId) => {
    const button = document.createElement("button");
    button.id = "side-panel-smoke-open";
    button.type = "button";
    button.textContent = "Open side panel for smoke test";
    button.addEventListener("click", () => {
      void chrome.sidePanel.open({ windowId: targetWindowId }).then(
        () => {
          document.documentElement.dataset.sidePanelOpen = "true";
        },
        (error) => {
          document.documentElement.dataset.sidePanelError = String(error);
        },
      );
    });
    document.body.append(button);
  }, windowId);
  await openHarness.click("#side-panel-smoke-open");
  await openHarness.waitForFunction(
    () =>
      document.documentElement.dataset.sidePanelOpen === "true" ||
      document.documentElement.dataset.sidePanelError !== undefined,
    { timeout: 4_000 },
  );
  const sidePanelOpenError = await openHarness.evaluate(
    () => document.documentElement.dataset.sidePanelError,
  );
  assert.equal(sidePanelOpenError, undefined, `chrome.sidePanel.open() failed: ${sidePanelOpenError}`);

  let visiblePanel;
  const panelDeadline = Date.now() + 4_000;
  while (!visiblePanel && Date.now() < panelDeadline) {
    visiblePanel = (await extension.pages()).find((candidate) => {
      try {
        return new URL(candidate.url()).pathname === "/sidepanel.html";
      } catch {
        return false;
      }
    });
    if (!visiblePanel) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.ok(visiblePanel, "Chrome opened the API call but exposed no side-panel extension page");
  await visiblePanel.waitForSelector("[data-cliphutch-sidepanel-root]", { timeout: 4_000 });
  await openHarness.close();

  console.log(
    `[browser] loaded ${manifest.name} ${manifest.version} from ${unpackedDirectory}`,
  );
} finally {
  await browser.close();
}
