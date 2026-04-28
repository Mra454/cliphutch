# ClipHutch — project rules

This file overrides default behavior and "best practice." Read first, every session.

## What this is

Manifest V3 Chrome extension that detects video URLs as web pages load them and downloads MP4/WebM/HLS. **Submitted to the Chrome Web Store on 2026-04-28 (v0.1.0); pending approval.** First submission triggered an in-depth review due to broad host permissions, so review is expected to take 1–3 weeks rather than 1–3 business days.

Single product, two roots in this tree:

- `extension/` — the MV3 extension (TypeScript + Vite)
- `cloudflare/` — Worker that handles Stripe checkout webhook, license issuance via Resend, and the license-validation endpoint

The marketing/privacy site lives in a **separate** repo at `~/projects/cliphutch-site` (Cloudflare Pages). Don't put marketing copy here.

## Commands

Run from `extension/`:

| Task | Command |
| --- | --- |
| Build | `npm run build` |
| Dist audit (critical-pattern guard + overpromise regex) | `npm run audit:dist` |
| Tests | `npm test -- --run` |

Both build and audit must PASS before any CWS submission. Worker is deployed separately from `cloudflare/` via `wrangler deploy`.

## The wedge — exact wording

The marketing wedge is permission minimalism vs Video DownloadHelper:

> **5 API permissions, not 14. No content scripts. No DOM access.**

Three pinned corrections future sessions must NOT undo:

1. **"5 API permissions"**, never "5 permissions". The `host_permissions` (`http://*/*`, `https://*/*`) are broad and not counted in the 5; this is disclosed explicitly in the firstrun.html footnote, PRIVACY.md, and PERMISSIONS.md. The count basis is API permissions because those determine what code an extension can run on visited pages. Codex audit (2026-04-28) correctly flagged the unqualified "5 permissions" claim as a marketing/code mismatch.

2. **"Originating tab"**, not "active tab". `resolveTabInfo()` in `extension/src/background.ts` reads URL/title for any tab that fires a video-shaped webRequest, not just the foreground tab. All public copy must say "originating tab" or describe the actual scope.

3. **Server-contact disclosure**. The free tier never contacts a ClipHutch server. The licensed tier hits `https://cliphutch-api.mra454.workers.dev/validate` at activation and at most once every 7 days. Public copy must qualify any "all processing on your device" claim with this distinction.

## Public copy rules

- **No em dashes** in firstrun.html, PRIVACY.md, PERMISSIONS.md, or cliphutch-site. Use colons, commas, periods, semicolons, parens.
- **No LLM-tell rhythms.** Avoid triple-parallel "does not X, does not Y, does not Z" (compress to "does not X, Y, or Z"). Avoid em-dash emphasis flourishes ("X — and no other Y"). Avoid "leverage", "robust", "comprehensive", "seamless", "navigate the".
- **Marketing claim must match code.** Codex's top severity tier is marketing/code mismatch. Before changing copy or the manifest, verify the other side still aligns. firstrun.html, PRIVACY.md, and PERMISSIONS.md have parallel claims and must stay consistent — edit all three together.

## Hosted infrastructure

| What | Where | Deploy |
| --- | --- | --- |
| License validation + Stripe webhook Worker | `https://cliphutch-api.mra454.workers.dev` | `wrangler deploy` from `cloudflare/` |
| Marketing + privacy site | `https://cliphutch.com` (CF Pages project: `cliphutch-site`) | `npx wrangler pages deploy public --project-name cliphutch-site` from `~/projects/cliphutch-site` |
| Email | `licenses@cliphutch.com` → `mra454@gmail.com` via Cloudflare Email Routing on cliphutch.com | CF dashboard |
| License-issuance email send | Resend, from cliphutch.com (DKIM/SPF on `send.` subdomain so it doesn't collide with CF Email Routing) | n/a |

`PRIVACY.md` is the source-of-truth for privacy content. `cliphutch-site/public/privacy.html` is the rendered copy served at `cliphutch.com/privacy`. Update both when content changes.

## Licensing model — accepted tradeoff

ClipHutch uses **honest-user client-side licensing**. `isLicensed()` in `extension/src/lib/license.ts` reads `chrome.storage.local["license"].key`. A determined user can bypass the free-tier rate limit by editing extension storage. This is intentional, not a bug. If hardening is requested later, the fix is a server-validated entitlement check, not obfuscation.

## CWS submission status

Submitted v0.1.0 to Chrome Web Store on 2026-04-28. Item ID: `pdpcameeghhppjbhecolnhdepceeldhl`. Pending approval (in-depth review).

Pre-submission codex audit (2026-04-28) — resolved blockers:
- B1 host-permissions claim, B2 server-contact claim, B3 active-tab claim: copy fixed across all three docs.
- B4 privacy URL: live at `https://cliphutch.com/privacy` (Cloudflare Pages + custom domain).
- B7 missing CLAUDE.md: this file.

Open work to do during/after the review window:
- **B5** — Stripe webhook tests (cloudflare/src/index.ts:96): no coverage on issuance/refund path. Touched in last 30 days.
- **B6** — License entry UI tests (extension/src/options/options.tsx:134): no component coverage. Touched in last 30 days.
- **M2** — CORS on validation API is `*`. CWS extension ID is now known (`pdpcameeghhppjbhecolnhdepceeldhl`); restrict CORS to `chrome-extension://pdpcameeghhppjbhecolnhdepceeldhl` plus any controlled admin/test origins.
- **M3** — Wire `audit:dist` and tests into pre-commit/CI.
- **M4** — Resend failure has no recovery path; webhook returns success and logs.
- **M5** — Stale docs in `cloudflare/README.md` (mentions `licenses@cliphutch.app`; "Phase 3 stub" claim is wrong).
- **Trader verification** — Google Payments verification submitted 2026-04-28 with Vismu LLC Articles of Organization; pending. Listing will display "non-trader" until Google approves.

## What future sessions tend to get wrong

- Drop "API" from the 5-permissions claim. **Don't.**
- Say "active tab" when describing URL/title scope. **Don't.** Say "originating tab".
- Promise "never contacts a server" without the licensed-tier qualifier. **Don't.**
- Rewrite one of PRIVACY.md / PERMISSIONS.md / firstrun.html in isolation. **Edit all three together.**
- Add error handling for impossible cases or fallbacks for framework guarantees. **Don't.** Boundaries only.
- Treat the cliphutch-site repo as part of this tree. **It isn't.** It lives at `~/projects/cliphutch-site` and ships independently.
