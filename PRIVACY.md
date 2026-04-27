# Privacy Policy — ClipHutch

> ClipHutch is a Chrome extension that detects video URLs as web pages load them and lets you download direct files (MP4, WebM) or HLS streams. All processing happens on your device. The extension does not contact any server operated by the developer, run analytics, or read page content. The technical sections below describe exactly what data the extension accesses and where it goes.

## 1. What this extension does

ClipHutch observes the network requests your browser makes on HTTP and HTTPS pages and identifies the ones that look like video files: direct video formats (`.mp4`, `.webm`, `.mov`, `.m4v`, `.mkv`, `.ogv`), HLS playlists (`.m3u8`), and DASH manifests (`.mpd`). When you click **Download** in the popup, the extension either hands the file to Chrome's download manager (for direct files) or assembles the HLS segments locally into a playable `.ts` file. All processing happens on your device.

## 2. What data it accesses

While you browse, the extension observes only the following data, and only on HTTP/HTTPS pages:

- **Network request URLs and a small number of response headers** (`content-type`, `content-length`, `content-disposition`) for video-related requests (HTML/sub-frame/XHR/media/other request types). Segment requests for HLS streams are ignored at detection time.
- **A small set of request headers from the same video requests** — specifically `Referer`, `Origin`, `User-Agent`, `Authorization`, and any `X-*` custom headers the page sent. These are kept in browser memory only, scoped to the originating tab, and cleared when the tab navigates away or closes. They are used to replay the same headers on the extension's own segment fetches when you click Download an HLS or DASH stream, so that servers requiring those headers serve the file. (Direct file downloads — `.mp4`, `.webm`, etc. — are handled by Chrome's built-in download manager, which does not allow extension header injection; the extension does not replay headers on those.) The extension never logs these headers, sends them anywhere, or writes them to disk.
- **The active tab's URL and title**, used solely to associate detected videos with the page they came from.

The extension does not inject content scripts and does not read page DOM content.

## 3. Where data is stored

| Category | Storage area | Lifetime |
| --- | --- | --- |
| Detected videos (per tab) | `chrome.storage.session` | Cleared when the browser restarts, the extension reloads, the extension updates, or the browser closes. Cleared per-tab on top-level navigation or tab close. |
| User settings (filename template, HLS size cap, etc.) | `chrome.storage.local` | Persistent on your device until you uninstall the extension or click "Reset to defaults". |

The extension does not use `localStorage` or `sessionStorage`.

## 4. What leaves your device

**Free tier.** Nothing leaves your device. The extension does not contact any server operated by the developer.

**Licensed tier.** Your license key and a randomly generated installation UUID are sent to ClipHutch's validation server (a Cloudflare Worker at `https://cliphutch-api.mra454.workers.dev/validate`) under two conditions:

1. **At activation**, when you paste your license key into the Options page and click Activate.
2. **Periodically**, at most once every seven days, to confirm the license has not been refunded or revoked.

The validation server stores: your license key, the installation UUID, your email address (provided by Stripe at checkout), and the timestamp of each activation. It does **not** receive your IP address (other than what Cloudflare needs to route the request), browsing activity, page URLs, video URLs, filenames, or any download history.

There are no analytics, telemetry, or update pings beyond Chrome's own extension-update mechanism.

When you download a video — whether direct (MP4 / WebM) or HLS — the extension fetches it **directly from the source server** that originally served the video, using whatever credentials (cookies, referrer) your browser would normally send to that origin. The extension does not mirror, proxy, or relay these downloads through any third party.

## 5. Permissions explained

| Permission | Why it's required |
| --- | --- |
| `webRequest` | Observe network requests, including request headers, so the extension can detect video URLs as the page loads them and (when you click Download) replay the request headers the page sent. All processing happens on your device. |
| `storage` | Store detected video URLs in browser session memory and store user settings in browser local storage. |
| `downloads` | Save detected videos via Chrome's built-in download manager. |
| `offscreen` | Briefly assemble HLS video segments into a downloadable file. |
| `declarativeNetRequestWithHostAccess` | When you click Download on a video that requires headers (such as a Referer or Authorization header) the original page sent, the extension installs a temporary, session-scoped browser rule to attach those captured headers to its own download fetch. The rule applies only to requests initiated by this extension and is removed when the download completes, fails, or the tab closes. |
| `http://*/*`, `https://*/*` | Required for `webRequest` to observe network requests across HTTP/HTTPS sites. The extension does not inject content scripts and does not read page DOM content. It does process network request URLs, request headers it observed when the page loaded, and the active tab's URL/title to associate detected videos with the page. |

## 6. Contact

For privacy questions, contact <mra454@gmail.com>.
