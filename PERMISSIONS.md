# ClipHutch Permissions

Each permission requested by the extension is listed below with the technical reason it's required. Detection and downloading happen entirely on your device. The free tier never contacts a ClipHutch server; licensed users contact a ClipHutch license-validation endpoint at activation and at most once every seven days afterward (see PRIVACY.md).

| Permission | Purpose |
| --- | --- |
| `webRequest` | Observes network requests, including request headers, so the extension can detect video URLs as the page loads them and (when you click Download) replay the request headers the page sent. All processing happens on your device. |
| `storage` | Stores detected video URLs in browser session memory and stores user settings in browser local storage. |
| `downloads` | Saves detected videos via Chrome's built-in download manager. |
| `offscreen` | Used briefly to assemble HLS video segments into a downloadable file. |
| `declarativeNetRequestWithHostAccess` | When you click Download on an HLS or DASH stream that requires headers (such as a Referer or Authorization header) the original page sent, the extension installs a temporary, session-scoped browser rule to attach those captured headers to its own segment fetches. The rule applies only to requests initiated by this extension and is removed when the download completes, fails, or the tab closes. (Direct video files are downloaded via Chrome's built-in download manager, which does not support extension header injection in Manifest V3, so the rule does not apply to direct downloads.) |
| `http://*/*`, `https://*/*` (host_permissions) | Required for `webRequest` to observe network requests across HTTP/HTTPS sites. The extension does not inject content scripts and does not read page DOM content. It does process network request URLs, request headers it observed when the page loaded, and (for tabs where the page loaded a video-shaped request) that tab's URL/title to associate detected videos with the page. |

## What this extension does NOT do

- Send URLs, page titles, hostnames, filenames, or browsing activity to any server.
- Track usage or include analytics.
- Inject content scripts.
- Bypass logins, paywalls, DRM, encryption, or access controls.
- Decrypt encrypted media streams.
