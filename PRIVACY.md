# Privacy Policy — Video Archive

> **TODO_COPY** — Replace this block with the user-facing narrative version of the technical structure below. Keep it plain, factual, and one screen long. The technical sections are accurate and may be quoted verbatim if you don't want to rewrite them.

## 1. What this extension does

**TODO_COPY** — One paragraph: detects video URLs that web pages request, lets you download MP4/WebM directly and HLS (.ts) via segment assembly, with all processing on your device.

## 2. What data it accesses

While you browse, the extension observes only the following data, and only on HTTP/HTTPS pages:

- **Network request URLs and a small number of response headers** (`content-type`, `content-length`, `content-disposition`) for video-related requests (HTML/sub-frame/XHR/media/other request types). Segment requests for HLS streams are ignored at detection time.
- **The active tab's URL and title**, used solely to associate detected videos with the page they came from.

The extension does not inject content scripts and does not read page DOM content.

## 3. Where data is stored

| Category | Storage area | Lifetime |
| --- | --- | --- |
| Detected videos (per tab) | `chrome.storage.session` | Cleared when the browser restarts, the extension reloads, the extension updates, or the browser closes. Cleared per-tab on top-level navigation or tab close. |
| User settings (filename template, HLS size cap, etc.) | `chrome.storage.local` | Persistent on your device until you uninstall the extension or click "Reset to defaults". |

The extension does not use `localStorage` or `sessionStorage`.

## 4. What leaves your device

**Nothing.** The extension does not contact any server operated by the developer. There are no analytics, telemetry, or update pings beyond Chrome's own extension-update mechanism.

When you download an HLS stream, the extension fetches the playlist and segments **directly from the source server** that originally served the video, using whatever credentials (cookies, referrer) your browser would normally send to that origin. The extension does not mirror, proxy, or relay these requests through any third party.

## 5. Permissions explained

| Permission | Why it's required |
| --- | --- |
| `webRequest` | Observe network requests so the extension can detect video URLs as the page loads them. All processing happens on your device. |
| `storage` | Store detected video URLs in browser session memory and store user settings in browser local storage. |
| `downloads` | Save detected videos via Chrome's built-in download manager. |
| `offscreen` | Briefly assemble HLS video segments into a downloadable file. |
| `http://*/*`, `https://*/*` | Required for `webRequest` to observe network requests across HTTP/HTTPS sites. The extension does not inject content scripts and does not read page DOM content. It does process network request URLs and the active tab's URL/title to associate detected videos with the page. |

## 6. Open source verification

The full source is available at **TODO_LINK**. The build is reproducible from the published source and the included `package-lock.json`.

## 7. Contact

For privacy questions, contact **TODO_EMAIL**.
