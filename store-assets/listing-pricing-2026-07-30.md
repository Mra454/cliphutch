# CWS listing pricing paragraphs, 2026-07-30

Dashboard pastes for the two listings. Claims verified against code:
4/day rolling = extension/src/lib/rate-limit.ts:2-4; stills uncounted =
background.ts isStillImage branch; $35 + checkout = lib/constants.ts:34-35;
5 installations = cloudflare/wrangler.toml MAX_DEVICES_PER_LICENSE;
ComputedKit free/Pro split + $29 + 3 activations + 14-day refund =
styleproof docs/COMMERCIAL-DECISION-0.2.0.md and live terms page.

## ClipHutch (append to the detailed description)

CAPTURE PACK
Collect supported videos and larger still images from one page or several tabs into a session-only Hutch, then review the complete pack before saving. ClipHutch shows every planned file and folder, blocked item, known or unknown size, and free-video quota effect. High-confidence Best Copy recommendations appear only for exact-media or page-authored responsive-image families; every related copy remains customer-controlled. For HLS and DASH, ClipHutch can choose the best supported quality at or below 90% of your configured cap and optional height limit. Unknown or changed qualities require Review instead of silently falling back.

A normal pack saves under a predictable `ClipHutch/<pack>/<page>/` hierarchy and includes the required redacted JSON source manifest described below. Optional CSV uses the same terminal records. Quick Capture remains available for one-item saves and creates no manifest. The complete reviewed pack remains visible at the buying gate: free customers can save every ready still plus the ready videos covered by their remaining daily slots, while a license unlocks the complete ready video allocation.

PRICING
The free tier includes every feature, with 4 video downloads in any rolling 24-hour window. Still-image saves never count against the video limit. A $35 one-time license (no subscription) removes the video limit on up to 5 browser installations. Buy inside the extension; the license key arrives by email.

PRIVACY AND PERMISSIONS
ClipHutch requests 7 Chrome API permissions: webRequest, alarms, storage, downloads, offscreen, declarativeNetRequestWithHostAccess, and sidePanel. The alarms permission schedules one-shot local cleanup wakes; it is not used for browsing, analytics, tracking, or periodic polling. Chrome can deliver an alarm late while the browser is asleep, so ClipHutch also reconciles cleanup on the next browser wake.

Media you explicitly add to Hutch keeps a bounded media/page snapshot and review/run context only in chrome.storage.session. It remains available if the source tab navigates or closes, and clears on browser restart, extension update, or Clear Hutch. If selected media needs approved replay headers, ClipHutch copies only those headers into a session-only item lease, bound to the exact item, source tab/page, source scheme/origin/path, and replay kind for extension-initiated XMLHttpRequest/other requests. The lease is never used for previews, sent to ClipHutch, written to disk, or included in a capture manifest, and lasts no more than 60 minutes. Unconsumed leases are removed with the item or Clear Hutch; accepted-run leases remain only until terminal cleanup or expiry. Cleanup occurs on terminal/remove/clear/expiry, the one-shot alarm, or the next browser wake.

LOCAL CAPTURE PACK MANIFESTS
Every normal Capture Pack automatically saves a required redacted `_cliphutch-manifest.json` after all media jobs are terminal. An optional CSV is saved only when you opt in; Quick Capture creates no manifest. The local manifest can include planned relative paths, final basenames when known, bounded media metadata, capture times, terminal statuses and public errors, a source page URL with user information/query/fragment removed, and the source media host, but never a media URL. It never contains captured headers, media URLs or signed queries, Blob URLs, license/install/quota/command IDs, raw internal errors, or absolute local paths. ClipHutch creates a bounded local text Blob in its packaged offscreen document and saves it through Chrome's download manager. The file is intentionally written to your Downloads storage and remains there until you delete it. One-shot alarms may recover manifest delivery or cleanup; this uses the existing alarms permission and adds no new permission.

## ComputedKit (append to the detailed description)

Rewritten 2026-07-30 after the drift-demand mining (chrome-extension-market-scan
/reports/computedkit-pro-drift-demand-mining-2026-07-30.md): lead with the
validated trust story, keep Pro brief and framed to the maintenance audience.

COMPUTEDKIT PRO
The core inspector is free with no quotas, runs only when you ask, and keeps results in Chrome. ComputedKit Pro is a US$29 one-time purchase, not a subscription, for pages you maintain and revisit: save a local baseline of a page's computed values, and a later scan shows exactly which of them changed. One license activates Pro on up to three browser installations, with a 14-day refund window. Details and purchase: https://cliphutch.com/computedkit/

## CWS declarations paste, 2026-09-03 (0.1.4 candidate)

Dashboard fields under Privacy practices. Every claim traces to PERMISSIONS.md
and PRIVACY.md on the aes128-transport-decrypt branch; edit those first if a
claim changes. New since the live 0.1.3 listing: `alarms`, `sidePanel`, Hutch
session retention, selected header leases, local Capture Pack manifests, and
plain AES-128 HLS decryption.

### Single purpose

ClipHutch detects video and larger image files that a web page loads and saves them to the user's device through Chrome's download manager, combining HLS and DASH streams into one MP4 locally when needed.

### Permission justifications

webRequest: Observes network requests, including request headers, so the extension can detect media URLs as the originating tab loads them and, only when the user starts a download, replay the request headers that page sent. Nothing observed leaves the device.

alarms: Schedules one-shot local cleanup wakes for the next selected-item header-lease expiry and for retrying delivery or cleanup of a local Capture Pack manifest. Not used for polling, tracking, or analytics.

storage: Session storage holds detected media, the user's selected Hutch snapshot, review and run context, download-job state, and bounded header leases; all clear on browser restart. Local storage holds settings, license state, an installation identifier, notices, and rolling free-tier quota timestamps.

sidePanel: Hosts the packaged ClipHutch workspace beside the pages the user browses so the Hutch and download activity stay visible across tab switches. Grants no additional access to page data.

downloads: Saves the media the user chose, plus a Capture Pack's redacted local `_cliphutch-manifest.json` and an optional CSV, through Chrome's built-in download manager.

offscreen: Runs briefly to assemble HLS and DASH segments, combine separate audio and video tracks into one MP4, repackage MPEG-TS into MP4, decrypt standard AES-128 HLS segments with the key named by the selected playlist, convert WebM direct files to MP4, and create a local text Blob for a Capture Pack manifest. All work is on the device.

declarativeNetRequestWithHostAccess: When a selected item needs the request headers its source page sent (such as Referer or Authorization), installs a temporary session rule from that item's bounded header lease, limited to extension-initiated requests and the selected source's exact scheme, origin, and path scope. Removed when the job ends, the item is removed, the lease expires, or the session ends.

Host permissions (http://*/*, https://*/*): Required for webRequest to observe media requests on any HTTP or HTTPS site the user visits, and for the single content script that reads image URL attributes already present in page markup. The extension processes request URLs and headers it observed, image URL attributes, and the originating tab's URL and title; it does not read form fields, text content, cookies, passwords, or other page data.

### Remote code

No. All JavaScript and the WebAssembly media tooling are packaged in the extension.

### Data usage

Collected (licensed tier only): Authentication information. The license key and installation identifier are sent to https://cliphutch-api.mra454.workers.dev when a user activates or deactivates a license and when an activation older than 7 days refreshes its status. The free tier contacts no ClipHutch server.

Not collected: personally identifiable information, health, financial or payment information, personal communications, location, web history, user activity, website content. Media URLs, page titles, hostnames, filenames, and browsing activity stay on the device. AES-128 keys are fetched from the source server, held in memory for that download only, and never stored or sent to ClipHutch.

Certifications: data is not sold to third parties; data is not used or transferred for purposes unrelated to the item's single purpose; data is not used or transferred to determine creditworthiness or for lending purposes.

Privacy policy: https://cliphutch.com/privacy

### Reviewer notes (optional field)

Version 0.1.4 adds a side-panel workspace (sidePanel), one-shot local cleanup alarms (alarms), session-only Hutch retention with bounded header leases, a redacted local Capture Pack manifest, and on-device decryption of standard AES-128 HLS transport encryption. DRM (Widevine, PlayReady, FairPlay) remains unsupported. Permission count is 7 API permissions plus broad host permissions, disclosed at https://cliphutch.com/privacy and in the extension's first-run page.
