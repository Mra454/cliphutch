# Permissions — Video Archive

Each permission requested by the extension is listed below with the technical reason it's required. All processing happens on your device.

| Permission | Purpose |
| --- | --- |
| `webRequest` | Observes network requests so the extension can detect video URLs as the page loads them. All processing happens on your device. |
| `storage` | Stores detected video URLs in browser session memory and stores user settings in browser local storage. |
| `downloads` | Saves detected videos via Chrome's built-in download manager. |
| `offscreen` | Used briefly to assemble HLS video segments into a downloadable file. |
| `http://*/*`, `https://*/*` (host_permissions) | Required for `webRequest` to observe network requests across HTTP/HTTPS sites. The extension does not inject content scripts and does not read page DOM content. It does process network request URLs and the active tab's URL/title to associate detected videos with the page. |

## What this extension does NOT do

- Send URLs, page titles, hostnames, filenames, or browsing activity to any server.
- Track usage or include analytics.
- Inject content scripts.
- Bypass logins, paywalls, DRM, encryption, or access controls.
- Decrypt encrypted media streams.
