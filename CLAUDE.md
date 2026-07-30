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

> **5 API permissions, not 14. No scripting API. Limited image-URL DOM access.**

Three pinned corrections future sessions must NOT undo:

1. **"5 API permissions"**, never "5 permissions". The `host_permissions` (`http://*/*`, `https://*/*`) are broad and not counted in the 5; this is disclosed explicitly in the firstrun.html footnote, PRIVACY.md, and PERMISSIONS.md. The count basis is API permissions because Chrome lists those separately from broad host access and manifest-declared content scripts. Codex audit (2026-04-28) correctly flagged the unqualified "5 permissions" claim as a marketing/code mismatch.

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
- **M4** — RESOLVED 2026-07-30: `email_sent_at` on licenses (migration 0002, applied to prod + backfilled 4/4) + webhook returns 500 on send failure so Stripe redelivery retries the email; idempotent path re-sends when `email_sent_at` IS NULL. Deployed as cliphutch-api version dd889c50.
- **M5** — Stale docs in `cloudflare/README.md` (mentions `licenses@cliphutch.app`; "Phase 3 stub" claim is wrong).
- **Trader verification** — Google Payments verification submitted 2026-04-28 with Vismu LLC Articles of Organization; pending. Listing will display "non-trader" until Google approves.

## Option C + product-improvement work — branch not yet merged

Active branch: **`option-c-stage-1-separate-audio`** (pushed, ~21 commits ahead of master, **no PRs open**). Goal was: download a single playable MP4 containing the selected video variant plus the default audio rendition for separate-audio HLS (Squarespace, Apple advanced fMP4, modern Vimeo non-DRM, Wistia). That shipped, then a larger product-improvement pass (2026-07-02/03) landed on the same branch off a 4-agent audit + Codex-reviewed plan.

**Shipped (all committed, 295 tests pass, build + audit clean):**

| Area | Commits | What |
|---|---|---|
| Stage 1 / 2A | `02fb183`, `178a184` | separate-audio fMP4 + fMP4 (`muxFmp4`, `MixedContainerAudioError`); byte-range segment fetch (`fetchByteRange`, `ByteRange*Error`) |
| Stage 2B/2C | inside `cbd2b1e` (5/14 v0.1.1 resubmission) | `mux.js`, `transmuxTsAudioToFmp4()`, mixed fMP4-video + MPEG-TS-audio path |
| Naming (Track A) | `6be9b5d`, `d96df5d` | machine-noise demotion in `lib/filename.ts` (hashes/UUIDs/camera/`hash_res`/generic-manifest stems lose to page title); `"auto"` FilenameTemplate default; honors the Options filenameTemplate setting; host+date fallback; resolution qualifier; popup preview = saved name |
| Reliability (Track C) | `315fddc`, `ce9505c`, `8cf6493` | `lib/session-jobs` serialized job writes + terminal guards (stuck-"running" fix); segment pools abort siblings on first failure; lost-completion reconcile; quota charged once on completion, not kickoff |
| Recovery (B2) | `b36b85c`, `2d180a0`, `e31e447`, `60bbfd6` | redirect-resolved URL classification; per-tab `addOrUpdateVideo` mutex; `RawAacAudioError` ADTS sniff; WebM DNR header replay; SIZE_CAP "Download anyway"; captured headers persisted to `chrome.storage.session` (`lib/captured-headers`) + deterministic FNV-1a rule IDs surviving SW restart |
| Disclosure (Stage 2D) | `782125f` (+ `fa33894` in cliphutch-site, **not deployed**) | PRIVACY/PERMISSIONS/firstrun + site privacy.html cover separate-audio fetch, byte-range, MPEG-TS repackaging, header-replay scope, captured-header storage; GPL tag → v0.1.1 |
| Upgrade UX | `699df43` | "Already have a key?" link in the at-limit banner |

**Smoke gate: declined by Mikey 2026-07-03; proceeding as if cleared.** Pre-flight only: Mux `tos_ismc` and Apple `img_bipbop_adv_example_fmp4` manifests fetched via browser, confirmed live and exactly the Stage 1 / Stage 1+2A shapes. Browser automation can't load the unpacked ext, drive the popup, or hear audio, so these paths are **logic-verified + unit-tested but NOT browser-smoked** — say so if it matters.

Checkout verified live 2026-07-03: `CHECKOUT_URL` (`buy.stripe.com/8x29ATcsIdsW3V31wUfw400`) → real Stripe page, Vismu LLC, "ClipHutch License $35 one-time, up to 5 devices" — matches in-extension copy.

### What's next (needs Mikey or deferred)

1. **Merge** — needs go-ahead (no push/PR without it). Single PR for the whole branch.
2. **Deploy site privacy** — `fa33894` in cliphutch-site is local only; `npx wrangler pages deploy public --project-name cliphutch-site`.
3. **Track D worker fixes** (deferred by Mikey — Stripe/worker side): device-lockout `POST /deactivate` + stale-eviction (the checkout promises "5 devices" but reinstalls burn slots permanently), partial-refund guard, `[observability]`, route-aware CORS. Separate branch off master; needs `@cloudflare/vitest-pool-workers` install + deploy OK.
4. **Optional:** B3 stills (video posters, CSS bg-images); full raw-ADTS→fMP4 muxing (currently accurate error only); UX batch (direct-download cancel, rate-limit reset time, host-aware empty state); AES-128 spike (post-0.1.2); CI/typecheck gate (M3 — `tsc` has ~35 pre-existing DOM-lib errors, needs tsconfig split first).

### Known concerns parked

- **DNR header replay scope.** `buildUrlFilter` at `lib/header-capture.ts:74` creates `||host/dir/` from the master URL's directory. Works in practice (audio renditions co-located). If a deployment ever places audio at a parallel path on the same host, audio fetches go header-less. Documented inline in `header-capture.ts`. Fix is a second DNR rule for the audio URL when its path falls outside the video's prefix.
- **Multi-track init muxer.** `dash-mux.ts parseFmp4` extracts `tracks[0]` only; multi-track fMP4 input now throws (guard from `5fca8a9`). No public test stream exercises this. Defer the full multi-track fix until a real site reports silent audio.
- **Out of scope after Option C lands:** AES-128 transport encryption, FairPlay/Widevine DRM, live/event playlists, discontinuities with codec changes, multi-period DASH, WebM/Opus HLS, CMAF subtitles/timed metadata, MSE-only flows (YouTube, Twitter), sites needing headers/cookies not captured at detection time.

### Where the master plan lives

In the conversation history of the session that branched `option-c-stage-1-separate-audio`. The plan covered Stages 1, 2A, 2B, 2C, 2D with file-by-file changes and accept criteria. Memory: `~/.claude/projects/-Users-mikey/memory/`. If a future session needs the plan and can't find it: ask Codex to re-draft from this section.

## What future sessions tend to get wrong

- Drop "API" from the 5-permissions claim. **Don't.**
- Say "active tab" when describing URL/title scope. **Don't.** Say "originating tab".
- Promise "never contacts a server" without the licensed-tier qualifier. **Don't.**
- Rewrite one of PRIVACY.md / PERMISSIONS.md / firstrun.html in isolation. **Edit all three together.**
- Add error handling for impossible cases or fallbacks for framework guarantees. **Don't.** Boundaries only.
- Treat the cliphutch-site repo as part of this tree. **It isn't.** It lives at `~/projects/cliphutch-site` and ships independently.
