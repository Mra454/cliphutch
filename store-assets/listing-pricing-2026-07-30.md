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
