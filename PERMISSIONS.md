# ClipHutch Permissions

Each permission requested by the extension is listed below with the technical reason it's required. Detection, preview display, and downloading happen on your device. The free tier never contacts a ClipHutch server; licensed users contact a ClipHutch license-validation endpoint at activation and at most once every seven days afterward (see PRIVACY.md).

| Permission | Purpose |
| --- | --- |
| `webRequest` | Observes network requests, including request headers, so the extension can detect media URLs as the page loads them and (when you click Download) replay the request headers the page sent. All processing happens on your device. |
| `storage` | Stores detected media URLs in browser session memory and stores user settings in browser local storage. |
| `downloads` | Saves detected media via Chrome's built-in download manager. |
| `offscreen` | Used briefly to assemble HLS video segments or locally convert WebM direct files into downloadable MP4 files. |
| `declarativeNetRequestWithHostAccess` | When you click Download on an HLS or DASH stream that requires headers (such as a Referer or Authorization header) the original page sent, the extension installs a temporary, session-scoped browser rule to attach those captured headers to its own segment fetches. The rule applies only to requests initiated by this extension and is removed when the download completes, fails, or the tab closes. Direct media files are downloaded via Chrome's built-in download manager, which does not support extension header injection in Manifest V3, so the rule does not apply to direct downloads. |
| `http://*/*`, `https://*/*` (host_permissions) | Required for `webRequest` to observe network requests across HTTP/HTTPS sites and for the content script to scan image URL attributes on HTTP/HTTPS pages. The extension processes network request URLs, request headers it observed when the page loaded, image URL attributes already present in page markup, and the tab URL/title needed to associate detected media with the page. |

## What this extension does NOT do

- Send URLs, page titles, hostnames, filenames, or browsing activity to any server.
- Track usage or include analytics.
- Read form fields, text content, cookies, passwords, or private page data from the DOM.
- Provide access to media unless your browser is already authorized to load it.
- Decrypt encrypted media streams.

Direct media previews and downloads are fetched directly from the original source server, not from a ClipHutch server. WebM direct files are converted locally to MP4 before saving.
