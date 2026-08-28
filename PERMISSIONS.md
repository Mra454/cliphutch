# ClipHutch Permissions

ClipHutch requests seven Chrome API permissions. Each is listed below with the technical reason it's required. Detection, preview display, and downloading happen on your device. The free tier never contacts a ClipHutch-operated server. Licensed users contact ClipHutch's license service when they activate or deactivate a license and when an existing activation needs a status refresh. A failed refresh may be retried on a later opening of the popup or side-panel workspace, but no more than once per hour (see PRIVACY.md).

| Permission | Purpose |
| --- | --- |
| `webRequest` | Observes network requests, including request headers, so the extension can detect media URLs as the page loads them and (when you click Download) replay the request headers the page sent. All processing happens on your device. |
| `alarms` | Schedules one-shot local cleanup wakes for the next selected-item header-lease expiry and for retrying sensitive download-artifact or Capture Pack manifest delivery/cleanup. It is not used for browsing, tracking, analytics, or periodic polling. Chrome may deliver an alarm late while the browser is asleep; ClipHutch reconciles cleanup on the alarm or the next service-worker/browser wake. |
| `storage` | Stores detected media, the selected Hutch media/page snapshot, review/run context, download-job state, and selected-item replay-header leases in browser session memory. Settings, license state, the installation UUID, notices, and rolling free-tier quota timestamps use browser local storage. |
| `sidePanel` | Hosts ClipHutch's packaged workspace beside the pages you browse so the Hutch and download activity can remain visible when you switch tabs. It does not grant additional access to page data. |
| `downloads` | Saves detected media and a normal Capture Pack's required redacted `_cliphutch-manifest.json`, plus an optional customer-selected CSV, via Chrome's built-in download manager. |
| `offscreen` | Used briefly to assemble HLS and DASH audio and video segments, combine separate audio and video tracks into one MP4, repackage MPEG-TS segments into MP4, locally convert WebM direct files into downloadable MP4 files, or create a bounded local text Blob for a terminal Capture Pack manifest. |
| `declarativeNetRequestWithHostAccess` | When a selected item requires the request headers that its source page sent (such as Referer or Authorization), ClipHutch installs a temporary session rule from that item's bounded header lease. The rule is limited to extension-initiated XMLHttpRequest/other requests and the selected source's exact scheme, origin, and path scope: the exact source URL for direct-media conversion, or the source origin and directory path for an HLS/DASH stream and its parts. It does not apply to previews or other page requests. The rule and lease are cleaned when the owning job becomes terminal, the unconsumed item is removed or Hutch is cleared, the lease expires, or the browser session ends. |
| `http://*/*`, `https://*/*` (host_permissions) | Required for `webRequest` to observe network requests across HTTP/HTTPS sites and for the content script to scan image URL attributes on HTTP/HTTPS pages. The extension processes network request URLs, request headers it observed when the page loaded, image URL attributes already present in page markup, and the tab URL/title needed to associate detected media with the page. |

## Hutch and selected replay headers

When you explicitly add media to Hutch, ClipHutch copies a bounded media/page snapshot and its review/run context into `chrome.storage.session`. Those selected records remain available if the source tab navigates or closes, but are cleared on browser restart, extension update, or **Clear Hutch**. Removing an item clears that item's unconsumed Hutch data.

If the selected source needs approved replay headers, ClipHutch also copies only those headers into a session-only lease bound to the exact selected item, source tab, page, media URL, replay kind, source origin, and path. The lease never supplies previews and is never sent to ClipHutch, written to disk, or included in a capture manifest. It has an immutable maximum lifetime of 60 minutes. An unconsumed lease is released when its item is removed or Hutch is cleared; after a run accepts it, it remains only until the owning attempt is terminal or the lease expires. Cleanup runs at terminal/remove/clear time, on the one-shot expiry alarm, or on the next browser wake. Because Chrome may delay alarms while the browser is asleep, physical removal can occur after the nominal expiry, but expired headers are not accepted for new work.

## Local Capture Pack manifests

Every normal Capture Pack automatically saves a required redacted `_cliphutch-manifest.json` after all media jobs are terminal. If you opt in to CSV, ClipHutch also saves `_cliphutch-manifest.csv` from the same redacted records. Quick Capture creates neither file. The packaged offscreen document creates a bounded local text Blob, and Chrome's download manager saves it as an intentional pack artifact. It remains in your Downloads storage until you delete it. One-shot alarms may recover unfinished manifest delivery or Blob cleanup; this uses the existing `alarms` permission and does not add a permission.

The manifest can contain each item's planned relative path; final basename when known; media kind and bounded width, height, duration, or bitrate metadata when known; capture time and terminal status; bounded public errors; a source page URL with user information, query, and fragment removed; and only the source media host, never the media URL. It never contains captured headers, media URLs or signed queries, Blob URLs, license or installation data, quota or command IDs, raw internal errors, or absolute local paths. The already-redacted manifest record and delivery status remain only in `chrome.storage.session` during the current browser session; the customer-requested downloaded file remains on disk until the customer deletes it.

## What this extension does NOT do

- Send page or media URLs, page titles, hostnames, filenames, or browsing activity to ClipHutch, analytics services, or a download relay. Preview and download requests still go directly to the original source server.
- Track usage or include analytics.
- Read form fields, text content, cookies, passwords, or private page data from the DOM.
- Provide access to media unless your browser is already authorized to load it.
- Decrypt encrypted media streams.

Direct media previews and downloads are fetched directly from the original source server, not from a ClipHutch server. WebM direct files are converted locally to MP4 before saving, and streams with separate audio and video (or MPEG-TS segments) are combined and repackaged into one MP4 on your device.
