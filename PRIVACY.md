# ClipHutch Privacy Policy

> ClipHutch is a Chrome extension that detects video and still-image URLs as web pages load them, shows local popup previews for direct media files, and lets you download direct files or supported HLS/DASH streams. For streams that deliver audio and video as separate tracks, the extension fetches both and combines them into one MP4, and segments in the MPEG-TS format are repackaged into MP4. WebM direct files are converted locally to MP4 before saving. Detection, preview display, conversion, and downloading happen on your device. The extension does not run analytics. A lightweight content script reads image URL attributes from the current page so still images can be detected even when a network event was missed. The free tier never contacts a ClipHutch server. The paid tier contacts a ClipHutch license-validation endpoint at activation and at most once every seven days afterward (see "What leaves your device" below). The technical sections below describe exactly what data the extension accesses and where it goes.

## 1. What this extension does

ClipHutch observes the network requests your browser makes on HTTP and HTTPS pages and identifies the ones that look like media files: direct video formats (`.mp4`, `.webm`, `.mov`, `.m4v`, `.mkv`, `.ogv`), still-image formats (`.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`, `.gif`), HLS playlists (`.m3u8`), and DASH manifests (`.mpd`). It also scans image URL attributes already present in the page DOM so larger still images can appear in the toolbar count without requiring you to click each image first. Small still images under 100KB, or obviously tiny DOM images, are hidden to avoid page icons and tiny UI assets. When the popup opens, direct media files may load a small browser preview from the original source URL. When you click **Download** in the popup, the extension either hands the file to Chrome's download manager, converts WebM direct files locally to MP4, or assembles stream segments locally into a playable MP4 file for supported HLS and DASH streams. For streams whose audio and video are delivered as separate tracks, it also fetches the matching audio rendition (a URL taken from the stream manifest) and combines it with the video. Some streams store their segments as byte ranges of a larger file, so the extension may request specific byte ranges of a segment. Segments delivered in the MPEG-TS format are repackaged into MP4. All processing happens on your device.

## 2. What data it accesses

While you browse, the extension observes only the following data, and only on HTTP/HTTPS pages:

- **Network request URLs and a small number of response headers** (`content-type`, `content-length`, `content-disposition`) for media-related requests (HTML/sub-frame/XHR/image/media/other request types). Segment requests for HLS streams are ignored at detection time.
- **A small set of request headers from the same media requests**, specifically `Referer`, `Origin`, `User-Agent`, `Authorization`, and any `X-*` custom headers the page sent. These are held in browser session memory (`chrome.storage.session`), scoped to the originating tab, and cleared when the tab navigates away or closes. They are used to replay the same headers on the extension's own fetches when you click Download an HLS or DASH stream, covering the video segments, the separate audio rendition, and any byte-range requests, and also on the local WebM to MP4 conversion fetch, so that servers requiring those headers serve the file. Direct media files handed to Chrome's download manager are fetched without replaying these captured headers. The extension never logs these headers, sends them anywhere, or writes them to disk.
- **Image URLs from page markup**, limited to image-related attributes such as `src`, `srcset`, `currentSrc`, and common preview-image meta tags. The content script uses these values only to add still-image candidates to the popup and toolbar badge.
- **The originating tab's URL and title**, for any tab where the page loaded a media-shaped network request, used solely to associate detected media with the page it came from. This is not limited to the foreground tab; any tab that loads a media-shaped request while the extension is enabled has its URL and title read for that purpose.

The extension does not read form fields, text content, cookies, passwords, or private page data from the DOM.

## 3. Where data is stored

| Category | Storage area | Lifetime |
| --- | --- | --- |
| Detected media (per tab) | `chrome.storage.session` | Cleared when the browser restarts, the extension reloads, the extension updates, or the browser closes. Cleared per-tab on top-level navigation or tab close. |
| Captured request headers (per tab) | `chrome.storage.session` | Held only for the browser session so a later download can replay them; cleared per-tab on navigation or tab close, and on browser restart. Not written to disk. |
| User settings (filename template, HLS size cap, etc.) | `chrome.storage.local` | Persistent on your device until you uninstall the extension or click "Reset to defaults". |

The extension does not use `localStorage` or `sessionStorage`.

## 4. What leaves your device

**Free tier.** Nothing leaves your device. The extension does not contact any server operated by the developer.

**Licensed tier.** Your license key and a randomly generated installation UUID are sent to ClipHutch's validation server (a Cloudflare Worker at `https://cliphutch-api.mra454.workers.dev/validate`) under two conditions:

1. **At activation**, when you paste your license key into the Options page and click Activate.
2. **Periodically**, at most once every seven days, to confirm the license has not been refunded or revoked.

The validation server stores: your license key, the installation UUID, your email address (provided by Stripe at checkout), and the timestamp of each activation. It does **not** receive your IP address (other than what Cloudflare needs to route the request), browsing activity, page URLs, media URLs, filenames, or any download history.

There are no analytics, telemetry, or update pings beyond Chrome's own extension-update mechanism.

When the popup shows a preview for a direct media file, or when you download media, the extension fetches the media **directly from the source server** that originally served it, using whatever credentials (cookies, referrer) your browser would normally send to that origin. The extension does not mirror, proxy, or relay these previews or downloads through any third party.

## 5. Chrome Web Store Limited Use

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements. ClipHutch uses data from Chrome extension APIs only to detect media on pages you visit, show it in the popup, save downloads you request, store local settings, and validate paid licenses as described above.

## 6. Open-source notices

ClipHutch includes @ffmpeg/core for local WebM conversion. @ffmpeg/core is licensed under GPL-2.0-or-later. The extension package includes the GPL license text, third-party notices, and a source-code offer. Corresponding source for this release is published at <https://github.com/Mra454/cliphutch/releases/tag/cliphutch-v0.1.1-cws-submit-2026-05-14>. You can also request the source by emailing <licenses@cliphutch.com>.

## 7. Permissions explained

| Permission | Why it's required |
| --- | --- |
| `webRequest` | Observe network requests, including request headers, so the extension can detect media URLs as the page loads them and (when you click Download) replay the request headers the page sent. All processing happens on your device. |
| `storage` | Store detected media URLs in browser session memory and store user settings in browser local storage. |
| `downloads` | Save detected media via Chrome's built-in download manager. |
| `offscreen` | Briefly assemble HLS and DASH audio and video segments, combine separate audio and video tracks into one MP4, repackage MPEG-TS segments into MP4, or locally convert WebM direct files into downloadable MP4 files. |
| `declarativeNetRequestWithHostAccess` | When you click Download on a video that requires headers (such as a Referer or Authorization header) the original page sent, the extension installs a temporary, session-scoped browser rule to attach those captured headers to its own fetches, including the video segments, the separate audio rendition, byte-range requests, and the local WebM conversion fetch. The rule applies only to requests initiated by this extension and is removed when the download completes, fails, or the tab closes. |
| `http://*/*`, `https://*/*` | Required for `webRequest` to observe network requests across HTTP/HTTPS sites and for the content script to scan image URL attributes on HTTP/HTTPS pages. The extension processes network request URLs, request headers it observed when the page loaded, image URL attributes already present in page markup, and the tab URL/title needed to associate detected media with the page. |

## 8. Contact

For privacy questions, contact <licenses@cliphutch.com>.
