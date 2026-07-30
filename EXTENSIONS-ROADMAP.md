# Extensions Monetization Roadmap

Source: full code + live-browser audit 2026-07-30 (ClipHutch, ComputedKit, Recoup Radar).
Scope: this file tracks the cross-product monetization work. ClipHutch + ComputedKit worker/site actions land in this repo, `~/projects/styleproof`, and `~/projects/cliphutch-site`; Recoup Radar actions land in `~/deadline-guard`.

## Audit verdict (2026-07-30)

Checkout works everywhere — both Stripe payment links live (HTTP 200), ComputedKit live checkout session verified in-browser, ClipHutch checkout verified 2026-07-03. Revenue is blocked by:

1. **Distribution** — ComputedKit and Recoup Radar have ~2 users each; ClipHutch has 1,000.
2. **Uncommitted production** — CWS builds, the shared worker, and the live site all ran from dirty working trees (being fixed in this pass).
3. **Invisible pricing** — every buyer discovers the price only at the gate; sites/listings are silent.

Freemium calibration is roughly right in all three products and is NOT the constraint.

## Per-product state

| | ClipHutch | ComputedKit | Recoup Radar |
|---|---|---|---|
| CWS | v0.1.3 live 7/22, 1,000 users, 4.0★ | v0.2.0 live ~7/18, 2 users | v1.0.1 live ~7/18, 2 users |
| Price | $35 one-time, 5 devices | $29 one-time, 3 activations, 14-day refund | $30 one-time (never say "lifetime") |
| Free tier | 4 video downloads / rolling 24h; stills + all features free | entire inspector unlimited; Pro = Baselines & Compare only | 3 subs/trials/bills + 5 returns |
| Purchases to date | yes (only product with revenue) | 0 | 0 |
| Checkout | live Payment Link | live Checkout session via worker | live Payment Link; webhook missing refund/dispute events |
| Key funnel gap | site + listing never mention $35 | listing never mentions Pro; free tier has no Pro teaser | content-widget at-limit prompt has no upgrade link; listing over-claims sync/timing |

## TOP 10 actions

- [x] 1. **Commit + push production state** in cliphutch, styleproof, cliphutch-site. (S) — done 2026-07-30, this session
- [x] 2. **Recoup: enable missing live Stripe webhook events** — done 2026-07-30 via dashboard: endpoint `we_1Tqz5aGQjeGFY4e5eijIxhtq` now listens to 5 events (completed, refunded, dispute.created, dispute.closed, async_payment_succeeded). Residual: secret-value verification (chrome-web-store-update.md:226) folds into action 3's E2E
- [ ] 3. **Recoup: real $30 E2E** — purchase → activation → **clean-profile restore → THEN refund** → authoritative revoke on both profiles. (M) — zero live purchases ever; flow unproven. Order matters: restore lookup only matches purchases with status `paid` (worker/src/index.js:170), so refunding first makes the restore test fail by design; repo checklist agrees (chrome-web-store-update.md:235-236)
- [ ] 4. **Recoup: fix CWS listing over-claims.** (M) — artifacts ready 2026-07-30 in ~/deadline-guard/marketing/: dated live capture (listing-capture-2026-07-30.md) + paste-ready restore-free description with dashboard-surface checklist (listing-description-2026-07-30-restore-free.md; restore marketing withheld until E2E per README gate). LEFT: the CWS dashboard session (paste, screenshot 3, Privacy Practices, IAP declaration, submit; budget review time — metadata edits go through review)
- [x] 5. **Worker: alert/retry on Resend failure** — done 2026-07-30: `email_sent_at` (migration 0002 applied to prod, 4/4 rows backfilled) + 500-on-failure so Stripe webhook redelivery retries the email; deployed as cliphutch-api version dd889c50, live /computedkit/validate smoke passed
- [x] 6. **Pricing on funnel tops** — site half DONE 2026-07-30: cliphutch.com #pricing section live + verified (4/day + stills-uncounted + $35/5 installations; ComputedKit free inspector + $29 Pro; install-first, no direct-buy CTA until /deactivate ships); ComputedKit terms false-deactivation sentence replaced, live. LEFT: paste listing paragraphs from store-assets/listing-pricing-2026-07-30.md into both CWS listings
- [ ] 7. **Recoup: real upgrade link in the content-widget capped prompt** — code DONE 2026-07-30 (commit 7ffdfbc: content:goPro + src/lib/purchase.js + inline delete confirms + em-dash sweep; checks pass, 1.0.2 zip built, SHA b79c41ac…). LEFT: Mikey's manual smoke per marketing/release-1.0.2-notes.md checklist, then CWS upload of 1.0.2 (bundle with the item-4 dashboard session)
- [ ] 8. **ComputedKit: 1 free baseline slot** (Pro = 20) so free users experience Compare before the $29 ask. (M)
- [ ] 9. **`/deactivate` endpoint to free device slots** (both licensed products). (M) — terms-claim half done 2026-07-30: live ComputedKit terms now promise support-assisted slot recovery instead of nonexistent in-extension deactivation
- [ ] 10. **Minimal conversion counting** — worker `/go/checkout` 302 redirects (count-only, no IDs) + local gate-hit counters; purchases from Stripe, installs from CWS dashboard. Disclose in privacy pages. (M)

## Below top-10 (polish)

- ClipHutch privacy GPL source-offer links tag `cliphutch-v0.1.2-cws-submit-2026-07-03` while 0.1.3 is live — tag 0.1.3 + retarget the offer chain.
- ClipHutch dead `window.alert` fallback branches in buy buttons (options.tsx:209, popup.tsx:1252) — would silently no-op in the embedded options page if ever reached.
- Recoup popup `window.confirm` in delete flows (popup.js:1280, 1297) → inline confirms (MV3 reliability).
- Recoup site/popup em-dash sweep (still outstanding).
- ComputedKit docs doctrine (AGENTS.md exclusions, ROADMAP gates, "keep beta free") overtaken by the live launch — reconcile against COMMERCIAL-DECISION-0.2.0.md.

## Freemium calibration decisions (recommended, not yet ratified)

- **ClipHutch: keep 4/day.** It converts; don't touch the gate until telemetry (action 10) can measure a change.
- **ComputedKit: keep core inspector free (doctrine); add 1 free baseline slot** as the Pro teaser (action 8).
- **Recoup Radar: keep 3+5 caps.** Calibration isn't the constraint at 2 users; fix plumbing + claims first.
