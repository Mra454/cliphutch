import assert from "node:assert/strict";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname, relative } from "node:path";
import puppeteer from "puppeteer-core";

const siteRoot = resolve("../../cliphutch-site/public");
const outputDirectory = resolve(siteRoot, "store-assets");

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

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
      // Try the next known Chrome executable.
    }
  }
  throw new Error("Chrome executable not found. Set CHROME_PATH to capture store assets.");
}

async function staticSite() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const requested = pathname === "/" ? "/index.html" : pathname;
      const file = resolve(siteRoot, `.${requested}`);
      if (!file.startsWith(`${siteRoot}/`) && file !== siteRoot) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const info = await stat(file);
      if (!info.isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(file)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

async function waitForExtension(browser) {
  let extension;
  const deadline = Date.now() + 6_000;
  while (!extension && Date.now() < deadline) {
    const extensions = await browser.extensions();
    extension = [...extensions.values()].find((candidate) =>
      candidate.name === "ClipHutch: Web Media Capture",
    );
    if (!extension) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.ok(extension, "ClipHutch should load for store-asset capture");
  return extension;
}

async function waitForExtensionPage(extension, pageName, timeoutMs = 6_000) {
  const suffix = `/${pageName}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = (await extension.pages()).find((candidate) => {
      try {
        return new URL(candidate.url()).pathname === suffix;
      } catch {
        return false;
      }
    });
    if (page) return page;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for the real ${pageName} extension surface`);
}

await mkdir(outputDirectory, { recursive: true });
console.log("Preparing the local ClipHutch site…");
const server = await staticSite();
console.log(`Local site ready at ${server.url}`);
console.log("Launching Chrome with the built extension…");
const browser = await puppeteer.launch({
  executablePath: await chromeExecutable(),
  headless: true,
  enableExtensions: [resolve("dist")],
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  console.log("Waiting for the ClipHutch extension…");
  const extension = await waitForExtension(browser);
  console.log("Opening the demo page…");
  const inspectedPage = await browser.newPage();
  await inspectedPage.setViewport({ width: 860, height: 800, deviceScaleFactor: 1 });
  await inspectedPage.goto(server.url, { waitUntil: "networkidle0" });
  await inspectedPage.bringToFront();

  let worker;
  const workerDeadline = Date.now() + 5_000;
  while (!worker && Date.now() < workerDeadline) {
    worker = (await extension.workers())[0];
    if (!worker) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.ok(worker, "ClipHutch background worker should be ready");

  console.log("Seeding fictional demo items in extension storage…");
  await worker.evaluate(async () => {
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tabId = activeTabs[0]?.id;
    if (typeof tabId !== "number") throw new Error("No active demo tab");
    await chrome.storage.session.set({
      [`tab:${tabId}`]: [
        {
          id: "demo-hls",
          url: "https://media.example.test/feature-film/master.m3u8",
          kind: "hls",
          detectedAt: Date.now(),
          pageUrl: "https://example.test/cliphutch-demo",
          pageTitle: "ClipHutch demo page",
        },
        {
          id: "demo-dash",
          url: "https://media.example.test/interview/manifest.mpd",
          kind: "dash",
          detectedAt: Date.now() - 1_000,
          pageUrl: "https://example.test/cliphutch-demo",
          pageTitle: "ClipHutch demo page",
        },
        {
          id: "demo-direct",
          url: "https://media.example.test/archive/editorial-cut.mkv",
          kind: "direct",
          detectedAt: Date.now() - 2_000,
          pageUrl: "https://example.test/cliphutch-demo",
          pageTitle: "ClipHutch demo page",
          sizeBytes: 88_000_000,
          contentType: "video/x-matroska",
        },
        {
          id: "demo-still",
          url: "https://media.example.test/archive/editorial-cover.jpg",
          kind: "image",
          detectedAt: Date.now() - 3_000,
          pageUrl: "https://example.test/cliphutch-demo",
          pageTitle: "ClipHutch demo page",
          sizeBytes: 2_400_000,
          contentType: "image/jpeg",
          width: 2400,
          height: 1600,
          provenance: ["rendered-image"],
        },
      ],
    });
  });

  console.log("Opening the real extension popup from the toolbar action…");
  await extension.triggerAction(inspectedPage);
  const popup = await waitForExtensionPage(extension, "popup.html");
  console.log("Waiting for the populated popup UI…");
  await popup.waitForFunction(() => document.body.innerText.includes("ClipHutch"), { timeout: 4_000 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  const popupText = await popup.evaluate(() => document.body.innerText);
  console.log(`Popup preview: ${JSON.stringify(popupText.slice(0, 280))}`);
  await popup.waitForFunction(() =>
    document.body.innerText.includes("Videos 3") && document.body.innerText.includes("Stills 1"),
  { timeout: 4_000 });

  console.log("Adding the visible fictional media to the real Hutch…");
  await popup.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.trim() === "Select visible",
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("Select visible control not found");
    button.click();
  });
  await popup.waitForFunction(() => document.body.innerText.includes("3 selected:"), { timeout: 4_000 });

  console.log("Adding the fictional still to the same Hutch…");
  await popup.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.trim() === "Stills 1",
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("Stills shelf tab not found");
    button.click();
  });
  await popup.waitForFunction(() => document.body.innerText.includes("editorial-cover.jpg"), { timeout: 4_000 });
  await popup.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.trim() === "Select visible",
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("Select visible control not found for stills");
    button.click();
  });
  await popup.waitForFunction(() => document.body.innerText.includes("4 selected:"), { timeout: 4_000 });

  console.log("Opening the real global side panel from the popup…");
  const openPanelSelector = "[data-cliphutch-open-side-panel]";
  await popup.waitForSelector(openPanelSelector, { timeout: 4_000 });
  await popup.click(openPanelSelector);
  const panel = await waitForExtensionPage(extension, "sidepanel.html");
  await panel.setViewport({ width: 420, height: 800, deviceScaleFactor: 1 });
  await panel.waitForSelector("[data-cliphutch-sidepanel-root]", { timeout: 4_000 });
  await panel.waitForFunction(() => document.body.innerText.includes("ClipHutch"), { timeout: 4_000 });
  await panel.waitForFunction(() => document.body.innerText.includes("Hutch · 4 items"), { timeout: 4_000 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));

  console.log("Composing the 1280×800 store screenshot…");
  const siteCapture = await inspectedPage.screenshot({ type: "png" });
  const panelCapture = await panel.screenshot({ type: "png" });
  const siteData = Buffer.from(siteCapture).toString("base64");
  const panelData = Buffer.from(panelCapture).toString("base64");
  const composition = await browser.newPage();
  await composition.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await composition.setContent(`<!doctype html><html><head><style>
    *{box-sizing:border-box} html,body{width:1280px;height:800px;margin:0;overflow:hidden;background:#f7f6f2}
    main{display:grid;grid-template-columns:860px 420px;width:100%;height:100%}.site{position:relative;overflow:hidden}.site img,.panel img{display:block;width:100%;height:100%;object-fit:cover;object-position:top left}.panel{border-left:1px solid #d9dbe4;background:#fff;box-shadow:-18px 0 48px rgb(30 31 42 / 14%)}.badge{position:absolute;top:20px;left:20px;padding:8px 12px;border:1px solid rgb(255 255 255 / 58%);border-radius:999px;color:#fff;background:rgb(23 23 27 / 82%);font:700 12px/1 system-ui,sans-serif;letter-spacing:.02em}
  </style></head><body><main><section class="site"><img src="data:image/png;base64,${siteData}" alt=""><span class="badge">ClipHutch demo page</span></section><section class="panel"><img src="data:image/png;base64,${panelData}" alt=""></section></main></body></html>`);
  await composition.screenshot({ path: resolve(outputDirectory, "cliphutch-screenshot-01.png"), type: "png" });

  const iconData = (await readFile(resolve("dist/icons/128.png"))).toString("base64");
  const promo = await browser.newPage();
  console.log("Rendering the 440×280 promotional tile…");
  await promo.setViewport({ width: 440, height: 280, deviceScaleFactor: 1 });
  await promo.setContent(`<!doctype html><html><head><style>
    *{box-sizing:border-box}html,body{width:440px;height:280px;margin:0;overflow:hidden}body{display:grid;grid-template-columns:108px 1fr;align-items:center;gap:24px;padding:36px;background:#17171b;color:#fff;font-family:Inter,ui-sans-serif,system-ui,sans-serif}img{width:100px;height:100px;border-radius:16px}h1{margin:0 0 10px;font-size:31px;letter-spacing:-.05em;line-height:1}p{margin:0;color:#d1d2db;font-size:16px;line-height:1.35}strong{color:#aebfff}
  </style></head><body><img src="data:image/png;base64,${iconData}" alt=""><div><h1>ClipHutch</h1><p>Build an organized media pack.<br><strong>Collect. Review. Save.</strong></p></div></body></html>`);
  await promo.screenshot({ path: resolve(outputDirectory, "cliphutch-small-promo.png"), type: "png" });

  console.log(`Captured ${relative(process.cwd(), outputDirectory)}/cliphutch-screenshot-01.png`);
  console.log(`Captured ${relative(process.cwd(), outputDirectory)}/cliphutch-small-promo.png`);
  await Promise.all([
    ...(popup.isClosed() ? [] : [popup.close()]),
    ...(panel.isClosed() ? [] : [panel.close()]),
    composition.close(),
    promo.close(),
    inspectedPage.close(),
  ]);
} finally {
  await browser.close();
  await server.close();
}
