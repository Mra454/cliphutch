# ClipHutch Customer Reliability Build Roadmap

Status: Worker and Capture Pack candidates are checkpointed and locally green; production and Chrome Web Store release remain blocked by the gates below<br>
Created: 2026-08-13<br>
Last execution update: 2026-08-28<br>
Code baseline: Worker checkpoint `9059b19`; extension checkpoint `9b538c1` on `option-c-stage-1-separate-audio`<br>
Scope: `extension/` and `cloudflare/`; the separate `cliphutch-site` and ComputedKit client repositories are coordinated dependencies for privacy, checkout, licensing, support, and cross-product Worker compatibility<br>
Estimates: senior engineer-days, including implementation, automated tests, review, and debugging; excluding Chrome Web Store review time and legal review. Moderated research effort and recruitment lead time are shown separately because they require product/research capacity, not engineering capacity.

## Execution update: 2026-08-28

The roadmap has been executed through the locally safe candidate boundary and
split into reviewable Worker and extension commits. No production Worker,
production D1 migration, hosted privacy page, verified source tag/release,
release-eligible package, or Chrome Web Store upload was performed.

| Workstream | Current result | Remaining release gate |
| --- | --- | --- |
| A0 Worker isolation | Separate staging D1 created and migrated through 0004; staging configuration, exact-version smoke tooling, reconciliation baseline, and guarded production commands added | Deploy a staging Worker with test-only Stripe/Resend secrets, rehearse repair and Time Travel on non-production data, and add an approved alert path |
| A1 artifact/source | Exact live 0.1.3 CWS artifact recorded (SHA-256 `96fe12a93da1626577c7e3630ca983fb8cbaeab36f609b48689d516b4af6c15b`) and materially matched to a clean `d5435d5` rebuild; the historical package/source-offer version mismatch remains documented. Candidate identity is consistently `0.1.4`; generated compiler state is excluded from source identity; release/source audit fails closed | After backend and manual gates pass, create and verify the exact `cliphutch-v0.1.4...` source tag and release archive |
| A2/B6 Worker correctness | Partial/full refund, ordering, replay, activation admission, email delivery, product isolation, retention, and route-contract tests implemented; 40 Worker tests pass | Reconcile the two currently refunded production rows against Stripe and produce a journaled compensating repair; ship a narrow refund-safe hotfix before the broader Worker candidate |
| B1 release foundation | Six extension TypeScript projects, dependency/fixture/release checks, generated source offer, exact-artifact metadata, and packed-browser smoke added; 1,096 tests and nine release-foundation tests pass, and the 0.1.4 development candidate builds and loads | Create the verified source tag and exact release archive only after the backend and manual release gates pass |
| B2 customer containment | Stable command IDs, background idempotency, pending controls, exact direct/still bulk behavior, accessibility feedback, persistent license notices, and explicit server/local deactivation UX added | Complete B3/B4 job ownership, global progress/cancel, tab-close behavior, DNR expiry, offscreen lifecycle, and measured hard limits before calling this the full Safety Release |
| B5 fail-safe media | Long-sample mux crash removed; malformed/unsupported DASH/HLS/CENC shapes fail early; detector precedence and fixtures expanded | Finish bounded-memory and cancellation architecture before enabling larger or broader media support |
| B7 license lifecycle | Versioned activate/status/deactivate routes, generation-safe tombstones, a single background extension owner, and cross-context activation tests added | Supply and verify the exact `CLIPHUTCH_STRIPE_PAYMENT_LINK_ID`; deploy and smoke Worker v2 before the 0.1.4 client; validate the packed/CWS origin matrix |
| Public disclosures | Repository privacy/permission/onboarding copy and the hosted-site source file were aligned with candidate storage, contact, retry, deactivation, and retention behavior | Deploy only in the server-first order after the described behavior is live |

Current decision: **NO-GO for production promotion and Chrome Web Store
submission.** The local development artifact is suitable for continued testing,
not distribution. Detailed operational blockers and rollback limits are recorded
in [`cloudflare/operations/WORKER-ROLLBACK-AND-RECONCILIATION.md`](cloudflare/operations/WORKER-ROLLBACK-AND-RECONCILIATION.md).

Current external/manual gates are concrete: no staging Worker is deployed; the
exact ClipHutch Stripe Payment Link ID is unresolved in accessible configuration;
two production refunded rows still need authoritative Stripe disposition and,
if required, journaled repair; the live Worker predates the new v2 license
routes; and the Chrome 116/current-stable lifecycle, NVDA/VoiceOver, five-person
product-value, hosted privacy, Store screenshot, and Store disclosure checks
remain incomplete.

## 1. Outcome and release decision

Hold the next full ClipHutch Chrome Web Store submission until the Train B Safety Release gate passes. The sole exception is a narrowly scoped emergency Containment Release that passes the dedicated B2 gate below and has an explicit residual-risk publish decision; otherwise the current package is withdrawn or its continued exposure is time-bound and owned. The current branch and existing `dist.zip` should not be submitted as-is because the packaged GPL source offer is stale, stream jobs can be lost on tab lifecycle changes, offscreen dispatch can falsely report success, active header-replay rules can outlive the public tab-close promise, the size-cap bypass is not a real hard ceiling, and the build has no green type-check gate.

The Worker partial-refund defect is independent and should be tested and deployed first as a small hotfix. A partial Stripe refund currently revokes the entire license at [`cloudflare/src/index.ts:280`](cloudflare/src/index.ts#L280).

The program is split into five release trains:

| Train | Customer outcome | Estimated effort | Release policy |
| --- | --- | ---: | --- |
| A. Artifact and Worker containment | Correct refund behavior, provide a safe staging/deploy path, remediate affected licenses, and restore release/source integrity | 5-9 days | Worker hotfix deploys independently; extension exposure receives a named 24-hour decision |
| B. Safety Release | Downloads fail safely within measured path-specific limits, are cancellable and recoverable, preserve privacy contracts, and are reproducibly packaged | 54-93 days | B2 is kept release-capable as an earlier containment patch; the full train gates the complete safety version |
| C. Workflow Release | Accessibility primitives, audio choice, bulk, discovery, recovery, and onboarding work as coherent customer flows | 26-45 days | Ship after Safety Release as a separate version |
| D. Media Pipeline v2 | Demand-justified HLS and static single-period DASH slices use a qualified bounded-memory architecture | 69-116 additional days | Proceed per media shape only after product and technical feasibility gates |
| E. Advanced media, demand-gated | Discontinuities, multiple periods, SegmentBase/SIDX, richer audio policy, and bounded-memory WebM | 65-125 additional days | Optional separate initiatives; do not promise them with Pipeline v2 |

The bottom-up base is approximately 154-263 engineer-days through Train D, or 219-388 including every optional Train E initiative. Use a 20% planning reserve for cross-browser findings, accessibility/research remediation, fixture work, and release hardening: roughly 185-316 days through Train D or 263-466 for the full optional program. These are planning ranges, not commitments; each feasibility gate re-estimates the remaining work.

## 2. Baseline evidence

At the recorded `d5435d5` audit baseline (before the execution update above),
the following behavior and file/line references applied:

- Extension unit/integration tests pass: 18 files and 299 tests.
- The production build passes and bundles a roughly 32 MB FFmpeg WASM asset.
- `audit:dist` reports success but does not catch the live version/source mismatch.
- Extension `tsc --noEmit` fails with 33 errors; Worker `tsc --noEmit` passes.
- Production dependency audits report no known vulnerabilities. The extension development toolchain reports six findings, including one critical and three high.
- `manifest.json` is `0.1.3`, `package.json` is `0.1.1`, and `SOURCE_OFFER.txt` names `0.1.2`.
- The existing `dist.zip` contains the same `0.1.3`/`0.1.2` mismatch.

Primary code evidence:

| Area | Evidence |
| --- | --- |
| Release identity | [`extension/manifest.json:4`](extension/manifest.json#L4), [`extension/package.json:2`](extension/package.json#L2), [`extension/public/SOURCE_OFFER.txt:7`](extension/public/SOURCE_OFFER.txt#L7), [`extension/scripts/audit-dist.js:285`](extension/scripts/audit-dist.js#L285) |
| Duplicate starts/quota | [`extension/src/popup/popup.tsx:637`](extension/src/popup/popup.tsx#L637), [`extension/src/background.ts:415`](extension/src/background.ts#L415) |
| False bulk promise | [`extension/src/popup/popup.tsx:1307`](extension/src/popup/popup.tsx#L1307), [`extension/src/popup/popup.tsx:1437`](extension/src/popup/popup.tsx#L1437) |
| Tab-lifecycle loss | [`extension/src/background.ts:272`](extension/src/background.ts#L272), [`extension/src/background.ts:910`](extension/src/background.ts#L910), [`extension/src/background.ts:1002`](extension/src/background.ts#L1002), [`extension/src/background.ts:1193`](extension/src/background.ts#L1193) |
| Silent offscreen dispatch | [`extension/src/background.ts:824`](extension/src/background.ts#L824), [`extension/src/background.ts:878`](extension/src/background.ts#L878), [`extension/src/background.ts:1163`](extension/src/background.ts#L1163) |
| DNR/header lifecycle | [`extension/src/background.ts:318`](extension/src/background.ts#L318), [`extension/src/background.ts:272`](extension/src/background.ts#L272), [`PRIVACY.md:61`](PRIVACY.md#L61) |
| Cap/memory behavior | [`extension/src/lib/constants.ts:18`](extension/src/lib/constants.ts#L18), [`extension/src/background.ts:773`](extension/src/background.ts#L773), [`extension/src/workers/hls-downloader.ts:433`](extension/src/workers/hls-downloader.ts#L433) |
| Mux sample crash | [`extension/src/workers/dash-mux.ts:132`](extension/src/workers/dash-mux.ts#L132), [`extension/src/workers/dash-mux.ts:136`](extension/src/workers/dash-mux.ts#L136) |
| HLS shape gaps | [`extension/src/workers/hls-downloader.ts:198`](extension/src/workers/hls-downloader.ts#L198), [`extension/src/workers/hls-downloader.ts:448`](extension/src/workers/hls-downloader.ts#L448), [`extension/src/workers/dash-mux.ts:120`](extension/src/workers/dash-mux.ts#L120) |
| DASH shape gaps | [`extension/src/lib/dash.ts:131`](extension/src/lib/dash.ts#L131), [`extension/src/lib/dash.ts:260`](extension/src/lib/dash.ts#L260), [`extension/src/lib/dash.ts:280`](extension/src/lib/dash.ts#L280) |
| Cancellation race | [`extension/src/offscreen/offscreen.ts:368`](extension/src/offscreen/offscreen.ts#L368), [`extension/src/background.ts:931`](extension/src/background.ts#L931) |
| Image recall/cap | [`extension/src/content-script.ts:82`](extension/src/content-script.ts#L82), [`extension/src/content-script.ts:105`](extension/src/content-script.ts#L105), [`extension/src/lib/storage-session.ts:30`](extension/src/lib/storage-session.ts#L30) |
| License lifecycle | [`extension/src/lib/license.ts:42`](extension/src/lib/license.ts#L42), [`extension/src/lib/license.ts:68`](extension/src/lib/license.ts#L68), [`extension/src/lib/license.ts:123`](extension/src/lib/license.ts#L123), [`cloudflare/src/index.ts:81`](cloudflare/src/index.ts#L81) |
| Worker operations | [`cloudflare/src/index.ts:11`](cloudflare/src/index.ts#L11), [`cloudflare/src/types.ts:1`](cloudflare/src/types.ts#L1), [`cloudflare/wrangler.toml:1`](cloudflare/wrangler.toml#L1) |

## 3. Program principles and proposed product decisions

These proposals keep separate pull requests from inventing conflicting behavior. The product/privacy/storage contract in B0 must ratify them before B2/B3 implementation starts.

### 3.1 A started stream download survives source-tab navigation or closure

Recommended behavior: once the background accepts a job, it owns a session-only snapshot of the media URL, display metadata, filename inputs, selected video/audio choices, and the minimum job-scoped header replay needed to finish. Closing or navigating the source tab clears the tab shelf and general captured-header storage immediately, while the narrowly scoped active-job rule remains until success, failure, cancellation, or event-driven expiry cleanup.

Survival is allowed only if the Safety Release adds a global “Active downloads” surface available from any normal tab, with progress, retained-data expiry, Cancel, and terminal result. This is a deliberate change from the current public statement that all captured headers are removed when the tab closes. `PRIVACY.md`, `PERMISSIONS.md`, `firstrun.html`, the hosted privacy page, and the Chrome Web Store privacy declaration must be changed together before release. If product/privacy owners reject the global surface or retained-job policy, the Safety behavior is visible cancellation on tab close. Do not combine “download survives” with invisible work or immediate removal of authorization required to finish.

### 3.2 “Hard cap” means an absolute, background-enforced limit

Remove the 10x bypass. B2 selects separate HLS, DASH, and WebM thresholds from process-memory evidence on low-memory and reference devices; this roadmap deliberately does not nominate 512 MiB as safe. Until those benchmarks pass, default new stream starts to the current path’s most conservative qualified threshold. The UI may have a lower warning threshold, but it must label the enforced source-byte limit separately and no crafted runtime message may raise it.

The source-byte limit counts retained init, selected video, and selected audio bytes while streaming each response. Manifest bytes have their own small decompressed limit. Current mux/sample metadata may still scale within explicit count caps. Train D must make media-payload memory a function of read buffers, concurrency, and mux windows rather than total media size.

### 3.3 Unsupported media fails before large downloads

For the Safety Release, clean refusal is a feature. Multi-period DASH, `r="-1"` timelines not yet expanded safely, ignored SegmentList ranges, ambiguous media types, CENC, changed HLS maps/discontinuities, and embedded multi-track fMP4 must produce typed, customer-readable unsupported errors before segment fetching. Format breadth is re-enabled only with fixtures and output oracles.

### 3.4 Bulk remains limited until a real queue exists

The Safety Release must hide or disable “Download picks” when it cannot fulfill every advertised item. All-direct/all-still batches may remain if the action states the exact count and quota impact. Train C replaces this containment with a persistent sequential queue; increasing offscreen concurrency is not an acceptable bulk fix.

### 3.5 Accessibility is a definition of done, not a polish phase

Every new pending, progress, success, error, cancellation, picker, and queue state must include keyboard behavior, focus behavior, accessible naming, and appropriate live-region behavior in the same pull request.

### 3.6 No silent production analytics

ClipHutch currently promises no analytics. Use deterministic fixtures, browser tests, Chrome Web Store aggregate data, support themes, and an on-device bounded diagnostic ring buffer with explicit redacted export. Remote product analytics or a remote kill-switch require a separate opt-in/privacy/CWS design and are not authorized by this roadmap.

### 3.7 License endpoints deploy before clients

`/deactivate` must be at 100% in production before any extension version calls it. A failed server deactivation leaves the local license in place and explains what happened; a separate, explicit “remove from this browser only” action may remain but must say it does not free a device slot.

### 3.8 Package what was tested

The release command always starts from a clean checkout and a fresh build. CI and manual browser smoke tests inspect the exact archive intended for upload, not a separately built `dist/` directory. Version, tag, source offer, commit, and checksum must agree.

### 3.9 Storage and recovery boundaries

- Raw headers, complete media URLs, page titles, customer-visible filenames, and compact cursor-based media plans remain in `storage.session`, offscreen memory, or session DNR rules only. A serialized plan has a 1 MiB hard limit inside the 10 MiB session quota and may not contain eagerly expanded segment arrays. Session-sensitive state is lost on browser exit, extension reload, or update; the interrupted attempt does not resume automatically.
- An IndexedDB coordinator stores only control-plane IDs, generations, state, quota disposition, redacted reason codes, and delivery intent. It never stores raw headers or source/page metadata.
- `storage.local` retains settings, the existing trusted-context license/installation records, a strictly allowlisted local diagnostic ring, and redacted interruption/reservation tombstones only.
- OPFS contains opaque job-directory names and media bytes/journals only, never raw headers, source URLs, page titles, or filenames.
- Browser exit/update produces a redacted interrupted tombstone, releases or repairs quota on next start, and garbage-collects orphan bytes. It does not pretend `storage.session` survives.
- Both `storage.local` and `storage.session` are explicitly restricted to `TRUSTED_CONTEXTS`; tests prove content scripts cannot read license or job data.

### 3.10 Delivery is at-most-once automatically, not exactly-once

Chrome downloads has no idempotency key and cannot share an atomic transaction with extension storage. Persist a delivery intent before calling Chrome, observe `downloads.onCreated`, and reconcile by unique blob URL, generation, and a narrow start-time window. If a service worker dies at an ambiguous commit point, transition to `SAVE_STATE_UNKNOWN`; never automatically call Chrome twice. The customer can inspect the ambiguity and choose “Download again.”

### 3.11 Worker observability is operational, disclosed, and metadata-minimized

Production invocation logs and traces remain disabled. If Workers Logs is enabled for custom operational events, set `observability.logs.invocation_logs = false`, emit only approved route-category/outcome/version/latency buckets, use the platform’s three- or seven-day maximum account retention, restrict access, and update privacy/CWS surfaces before deployment. Do not log request URLs/bodies, IP-derived fields, keys, emails, installation IDs, Stripe payloads, or media data.

## 4. Target architecture

### 4.1 Customer command and job lifecycle

```text
User intent
    │ stable commandId (new ID only for an intentional repeat)
    ▼
Background idempotency record
    ▼
created → preflighting → awaiting_choice → queued → running → processing
                                                │             │
                                                └── cancelling┘
                                                           ▼
                                      saving → succeeded / failed / cancelled
```

Each accepted job owns:

- `commandId`, `jobId`, and `attemptId`/generation;
- an immutable media and filename snapshot;
- selected video and audio choices;
- quota reservation state;
- progress, timestamps, lease/expiry, and allowed next actions;
- DNR rule ownership and expiry;
- a redacted typed terminal result;
- optional Chrome `downloadId`, a delivery intent/blob URL generation, and temporary-storage journal.

IndexedDB transactions serialize control-plane transitions. A message from an older attempt cannot own a new transition, save a file, or overwrite a newer terminal state. Storage cannot atomically commit with `chrome.downloads.download`, so delivery follows section 3.10 and guarantees at most one automatic save; ambiguity is customer-recoverable rather than silently retried.

### 4.2 Candidate Media Pipeline v2

```text
Bounded manifest fetch
        ▼
Pure format parser
        ▼
Normalized MediaPlan ──► policy validator ──► typed unsupported result
        ▼
Range-aware bounded fetcher
        ▼
Versioned temporary job store
        ▼
Cancellable CPU worker + D2-selected mux/transmux candidate
        ▼
Qualified output delivery candidate → Blob URL/file → chrome.downloads
```

The normalized plan must represent tracks, language/role, initialization changes, byte ranges, timelines, discontinuities, encryption, distinct origins, request counts, and estimated bytes. Long templates/timelines use bounded `SegmentCursor` descriptors rather than eagerly expanded URL arrays. Only bounded control-plane state belongs in extension storage.

The lower half is a candidate architecture selected separately for each media shape by D2. It compares validated fMP4 fragment pass-through, a fragmented-MP4 writer, a seekable OPFS/random-access mux, and disk-backed WASM. OPFS is not assumed to solve memory: the gate must prove that both mux output and Chrome download delivery avoid materializing the whole source/output in JS, WASM, or the relevant Chrome process tree. Current MP4Box `getBuffer()` and FFmpeg MEMFS are explicit blockers.

## 5. Dependency map

```text
A0 safe Worker staging ──► A2 refund hotfix/remediation
A1 exact-source containment ──► B1 reproducible release pipeline ─────────────┐
                                                                            │
A2 refund tests/hotfix ──► B6 Worker test foundation ──► B7a deactivate ──► B7b CORS
                                                                            ▼
B0 approved product/storage/privacy contract
 └──► B1 ──► B2 release-capable containment ──► B3 job/delivery protocol ──► B4 lifecycle/privacy
       │                 │                           │                         │
       │                 └──► B5 fail-safe media ───┘                         │
       └──────────────────────────────────────────────────────────────────────► Safety RC

B2/B3 state and error contracts ──► C1 accessible shared components
B5 support/track identity ─────────► C2 video/audio choice contract
C1 + C2 + variant timeout ─────────► C3 persistent bulk queue
B3 acknowledgement protocol ───────► C4 lazy-image lifecycle
C1-C4 + formative findings ────────► C5 onboarding

B1 test foundation + B3/B4 ownership + B5 support contract + D0 product gate
        ▼
D1 compact MediaPlan ──► D2 per-shape mux/storage/download feasibility gate
                     ├── NO-GO: keep conservative caps and stop breadth work
                     └── GO ─► D3 spooler/delivery ─► D4 incremental worker/mux
                                                       ├──► D5 HLS slices
                                                       └──► D6 DASH slices
```

## 6. Train A: artifact and Worker containment

Run A0, A1, and A2 with separate owners where possible. Within 24 hours, the accountable product/release owner must also choose one extension-exposure response: (a) accelerate the B1-lite plus B2 containment patch and trusted-test it before the long B3 migration, (b) temporarily withdraw the current package, or (c) record explicit risk acceptance with owner, reason, support plan, and expiry date. Train A does not itself pretend to fix the installed extension.

### A0. Establish a safe Worker staging and mutation-recovery path

Effort: 2-4 days<br>
Owner: Worker/backend engineer<br>
Dependency: none

Tasks:

1. Create a staging Worker/environment bound to a separate staging D1 database and test Stripe/Resend credentials. Production version overrides change code routing, not production bindings, and are not a substitute for mutation testing in staging.
2. Add version metadata and assert the executing version in every staging/production smoke. A failed override must fail the smoke rather than fall through to ordinary traffic.
3. Add an append-only redacted mutation/event journal or equivalent Stripe-event correlation for license status and activation changes.
4. Produce pre/post-deploy reconciliation reports and a row-level compensating repair script. Rehearse repair on an exported/staging copy.
5. Treat D1 Time Travel as database-wide disaster recovery, not normal row repair. Record whether the account has the current seven-day Free or 30-day Paid retention and rehearse restoration only on a non-production database.

Acceptance:

- Mutation tests cannot reach production D1, Stripe, or Resend resources.
- Smoke output proves which Worker version and environment executed.
- Every status/activation mutation can be correlated and repaired at row level without erasing later legitimate purchases or activations.

### A1. Reconcile the live artifact and exact corresponding source

Effort: 1-2 days<br>
Owner: release engineer<br>
Audit coverage: H-01

Tasks:

1. Obtain the exact currently published `0.1.3` package from the Chrome Web Store dashboard and record its SHA-256.
2. Compare it with the repo’s `extension/dist.zip` and determine the exact source commit. Do not infer the commit from version text alone.
3. If exact source is proven, publish an anonymously accessible commit/tag/archive and update the hosted privacy/source-offer link. If it cannot be proven, preserve the evidence and obtain a legal/compliance disposition plus corrected customer communication; do not label a reconstruction as exact corresponding source.
4. Freeze new CWS uploads until the generated release pipeline in B1 is green.
5. Record the current CWS package, previous package, listing copy, privacy declarations, and rollback version in a release evidence bundle.

Acceptance:

- One of two terminal outcomes is recorded: (a) a reviewer reproduces shipped files byte-for-byte except explicitly documented ZIP metadata, or (b) exact reproduction is unproven and legal/compliance remediation blocks the next release.
- Every public source link resolves to the exact source it names.
- No tag claims to represent an artifact unless the artifact-to-commit match is verified.

### A2. Test and hotfix partial-refund handling

Effort: 2-3 days<br>
Owner: Worker/backend engineer<br>
Audit coverage: M-05

Tasks:

1. Add `@cloudflare/vitest-pool-workers` and a minimal staging-D1-backed Worker test harness.
2. Extend the local Stripe event type with the authoritative charge refund fields.
3. Leave a license active for a partial refund; mark it refunded only when the Charge object reports `refunded === true` (Stripe defines this as fully refunded). Preserve `amount`/`amount_refunded` for validation/audit but do not infer full refund from event type alone.
4. Test duplicate events, multiple `v1` signatures during secret rotation, bounded request bodies, missing/unknown payment intents, malformed signed payloads, and full cumulative refunds.
5. Generate a read-only report of currently refunded license rows and compare them with Stripe. For every potentially affected row, record restored, confirmed-legitimate, or unresolved status; give unresolved customers an owner, SLA, and support/communication plan.
6. Pass the full mutation suite in A0 staging. Then create a production `100% old / 0% new` deployment, assert the new version through an override, run read-only or explicitly reversible production smoke, and promote to 100%. A gradual split is inappropriate because any event hitting the old version can still revoke incorrectly.

Acceptance:

- Partial refunds never change an active license to `refunded`.
- A full refund changes the matching license once; event replay is idempotent.
- Unknown/malformed events make no license mutation.
- No license key, email, installation ID, or Stripe secret appears in logs.
- The prior Worker version ID and rollback command/runbook are recorded before promotion.
- Every potentially affected prior refund is restored, confirmed legitimate, or explicitly unresolved with owner/SLA.

Current platform references: [Stripe `charge.refunded` includes partial refunds](https://docs.stripe.com/api/events/types), [Stripe Charge full-refund fields](https://docs.stripe.com/api/charges/object), [Workers version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/), and [D1 Time Travel limitations](https://developers.cloudflare.com/d1/reference/time-travel/).

### Train A gate

- [ ] Live artifact/source state documented and public source link corrected where evidence permits.
- [ ] Staging bindings, mutation journal, reconciliation, and compensating repair are proven.
- [ ] Worker refund tests pass in the Workers runtime.
- [ ] Refund hotfix is deployed and controlled production smoke passes.
- [ ] Prior customer remediation is evidence-based and every row has a recorded disposition.
- [ ] The 24-hour extension-exposure decision is recorded and acted on.

## 7. Train B: Safety Release

### B0. Ratify product, storage, privacy, and research contracts

Effort: 2-4 days plus recruitment lead time<br>
Owners: product, privacy/security, extension engineering, accessibility/research<br>
Dependency: Train A evidence

Before implementation, approve:

- survive-tab-close with a global Active downloads surface, or visible cancel-on-close;
- numeric leases/cleanup semantics and whether adding the `alarms` permission is worth changing the “5 API permissions” claim;
- field-by-field storage placement from section 3.9 and browser-exit/update outcomes;
- automatic-save ambiguity behavior from section 3.10;
- exact supported/refused media matrix and temporary path-specific size limits;
- formative research protocol for bulk preflight, audio choice, tab-close behavior, and onboarding.

Recommended defaults to ratify or replace with documented evidence: command dedupe 10 minutes after the last response; running inactivity lease 5 minutes renewed by meaningful progress; absolute job/DNR lifetime 4 hours; terminal/`SAVE_STATE_UNKNOWN` redacted control record 24 hours; offscreen idle grace 30 seconds; local diagnostics 200 events or 7 days, whichever expires first. Event-driven DNR deletion occurs on the first extension wake after expiry, while request policy refuses new work immediately once state is observed expired.

Run 5-8 formative sessions across new/experienced customers and include at least one keyboard-only and one screen-reader or low-vision participant. Findings may change the proposed contract before B2/B3; they are not a summative percentage gate.

Acceptance:

- Each field has a storage owner, purpose, exposure, lifetime, cleanup trigger, and disclosure decision.
- Product/privacy/accessibility owners sign the behavior contract before code depends on it.
- Research notes use no raw captured media/auth data and produce testable design changes or a recorded no-change decision.

### B1. Reproducible quality and release gates

Effort: 4-7 days<br>
Owner: extension/platform engineer<br>
Audit coverage: H-01, M-10, M-11

Tasks:

1. Choose one canonical extension version source. Generate or validate `manifest.json`, `package.json`, lockfile root metadata, source-offer tag, privacy source link, and artifact metadata from it.
2. Replace the stale hard-coded GPL check in `audit-dist.js` with comparisons against the built manifest and exact release identifier.
3. Define a non-recursive release DAG: `verify:source` runs typecheck, unit/integration, coverage, dependency and source/build audits; `package` archives the one freshly built `dist`; `verify:package` extracts the archive to an immutable temporary directory and runs archive audits plus automated/manual Chrome tests against that extraction. CI runs `npm ci` once, then these stages in order, and emits SHA-256 plus a file inventory only after verification.
4. Split TypeScript projects by environment: DOM UI/content, MV3 service worker, offscreen document, Web Workers, and tests/build config. Remove the program-wide default-lib contamination from [`ffmpeg-worker.ts:1`](extension/src/workers/ffmpeg-worker.ts#L1).
5. Add `typecheck`, non-watch `test:run`, browser test, coverage, `verify:source`, `package`, and `verify:package` scripts.
6. Upgrade Vite/Vitest/esbuild and related development dependencies until the full audit is clean or each remaining advisory has an explicit expiry and compensating control. Production advisories always fail.
7. Make required media fixtures fail CI when missing; do not conditionally skip critical mux tests.
8. Generate Worker binding types with `wrangler types` and add Worker runtime tests. Verify configuration fields against the current Wrangler schema. Do not combine a compatibility-date/runtime-flag deployment with licensing behavior, and implement the observability policy in section 3.11 before enabling persisted logs.

If the 24-hour exposure decision selects an accelerated B2 release, first cut a B1-lite milestone: exact version/source identity, clean-checkout fresh build, current 299-test/build/dist gates, B2-specific stress/browser tests, archive extraction inspection, and a formal expiring exception showing that the 33 pre-existing TypeScript errors did not increase. The full B1 zero-error/split-config gate still blocks the complete Safety Release. If owners will not accept that exception, withdraw or explicitly accept the current exposure rather than silently delaying the decision.

Acceptance:

- Zero TypeScript errors in every target.
- All tests, production build, dist audit, dependency policy, and clean-tree checks pass in CI.
- The archive tested in Chrome has the same SHA-256 as the upload candidate.
- Manifest version, package metadata, source identifier, Git tag/commit, and release record agree.
- The release script cannot package an old `dist/` directory.
- Production Worker tests run against real Workers bindings, not only Node mocks.

### B2. Stop immediate customer harm

Effort: 8-14 days<br>
Owner: extension/product engineer<br>
Audit coverage: H-05, H-12, H-13, H-15, M-06

Tasks:

1. Generate one stable `commandId` per explicit customer intent. Persist redacted background idempotency control state under the B0 storage contract so replay after service-worker restart returns the same accepted job/result; browser exit/update produces an interruption tombstone rather than false resumption.
2. Set card and bulk pending state synchronously, retain the initiating control in the DOM, and disable mouse, keyboard, and touch activation while pending.
3. Permit an intentional repeat only through an explicit post-terminal “Download again” action that creates a new command ID.
4. Reserve quota once per accepted video command; release it on pre-start/start failure and charge it once on successful terminal completion.
5. Disable video actions at the free limit while leaving still-image actions available.
6. Disable/hide bulk for selections the current implementation cannot fully execute. For retained all-direct/all-still bulk actions, state exact item and quota counts and report each failure by item.
7. Remove the 10x bypass. Enforce a path-specific source-byte limit in the background even for forged messages. Rename the setting to “Stream size limit (HLS and DASH)” and distinguish warning from enforced limit if both remain. Clamp/migrate stored values and explain any reduction beside the setting.
8. Add `fetchBoundedBytes`: read fixed-size stream chunks, cap decompressed manifest and media bytes, validate declared and actual lengths, share one in-flight byte budget across concurrent fetchers, and abort all siblings before retained bytes exceed the limit plus one fixed read chunk. Test four simultaneous unknown-length responses crossing the aggregate budget.
9. Benchmark representative current-path jobs on a pinned low-memory profile and reference hardware on Chrome 116/current stable. Record baseline and peak total relevant Chrome-process private memory, wall time, ten-job leakage, many-small-segment and long-sample cases. Select lower per-path limits when evidence requires; never raise them in Train B.
10. Create a central error registry with category, customer message, retry policy, action set, diagnostic code, and accessibility priority. Permanent errors such as DRM, encryption, live content, and unsupported layout get no Retry action.
11. Complete minimum accessibility remediation for every existing popup/options download and license state: stable initiating controls, contextual names, labelled progress, polite ordinary statuses, assertive urgent/blocking alerts only, form labels/error associations, selected-tab semantics, focus return, contrast, target size, and 400%/320 CSS-pixel reflow.
12. Give variant lookup and popup/background request-response boundaries B0-approved abortable timeouts. Timeout always leaves pending state, preserves customer choices, removes lookup DNR state, and offers only the mapped recovery action.

Acceptance:

- Ten same-tick clicks produce one accepted command and at most one automatic job/download/output/quota outcome.
- Replaying a command before and after service-worker restart never creates a second job.
- Failed start releases the reservation; successful completion charges exactly once.
- Aggregate retained source bytes across init/video/audio plus in-flight read chunks never exceed the path limit plus the documented one-chunk bound; the limit applies even without `Content-Length`.
- The selected temporary cap has recorded Chrome 116/current-stable process-memory measurements and a fail-safe rationale.
- A mixed shelf cannot display a success-looking bulk summary while silently skipping supported items.
- Known deterministic errors never expose Retry; transient retries preserve prior choices.
- Variant lookup cannot remain pending beyond the numeric timeout and leaves no lookup replay rule.
- Focus remains on the disabled initiator while pending, moves to the named result/error when terminal, and returns to the origin after picker cancellation.
- The scripted keyboard/focus/reflow/contrast/target-size matrix passes, and named NVDA/Chrome plus VoiceOver/Chrome versions announce all required states.

### B2 emergency Containment Release gate

This optional release improves active customer harm before B3-B8 but does not claim lifecycle/media architecture completion. It may publish only when all are true:

- [ ] B0 owners approve the B2 command/storage/cap/accessibility behavior and the documented residual H-02/H-03/H-04/H-11/B5 risks.
- [ ] B1-lite and every B2 acceptance criterion pass; the type-error exception has an owner and expires at the full Safety Release.
- [ ] Coordinated bundled/hosted privacy, permission, CWS, support, and release-note surfaces describe actual B2 behavior and remaining limitations without implying full Safety completion.
- [ ] The exact extracted archive passes targeted Chrome 116/current-stable duplicate/quota/cap/bulk/error/accessibility tests and has a reproducible version/source/checksum record.
- [ ] At least five named trusted testers complete a three-calendar-day bake across the targeted direct/HLS/DASH/WebM/still and accessibility matrix with no duplicate automatic save/quota, cap breach, serious/critical accessibility defect, new privacy leak, corrupt `ACCEPT` output, or unexplained data loss. Any blocker resets the bake after a fix.
- [ ] The prior package is preserved, stored-state rollback compatibility is tested, and the CWS rollback procedure/owner is recorded.
- [ ] Product, privacy/security, engineering, and release owners explicitly choose Publish based on the contained harm versus documented residual risk. A No decision triggers withdrawal or the time-bounded risk-acceptance branch from Train A.

### B3. Persisted job protocol and cancellation ownership

Effort: 12-20 days<br>
Owner: extension/platform engineer<br>
Audit coverage: H-02, H-03, H-11, M-02, M-03

Tasks:

1. Replace separate loosely aligned HLS, DASH, WebM, and direct records with an IndexedDB-coordinated state model and media-specific session payloads under section 3.9.
2. Snapshot the `DetectedVideo`, inferred filename inputs, selected choices, source URL, and customer-visible label at acceptance. Blob-ready handling must never depend on the tab shelf.
3. Add `jobId` plus `attemptId` to every message. Require the current attempt to own planning, progress, blob-ready, save, terminal, and cleanup transitions.
4. Implement a single-flight offscreen creation promise and filter context lookup to the exact offscreen document URL.
5. Await the offscreen start acknowledgement. A missing, rejected, or non-OK response transitions the job to a visible error and compensates quota/DNR/temp state before returning.
6. Move current HLS/DASH CPU work into a minimal per-job terminable worker in Train B, even though it remains in-memory. Persist cancellation first, request cooperative abort/close, force termination after a deadline, and recheck ownership before blob creation/delivery. Train D later replaces the algorithms with incremental implementations.
7. Implement the section 3.10 delivery-intent protocol. Observe `downloads.onCreated`; reconcile exact blob URL/generation/time before any retry; ambiguous commits become `SAVE_STATE_UNKNOWN`, never a blind second `downloads.download()` call.
8. Define cancel after delivery: before commit suppress save; for known active `downloadId` call `chrome.downloads.cancel` and wait for complete/interrupted; if already complete, success wins and Cancel disappears; ambiguous commit reconciles without retry.
9. Acknowledge terminal and cleanup messages. Retry only after state/message ownership is idempotent; external delivery remains governed by the ambiguity protocol.
10. Add event-driven reconciliation for service-worker/offscreen disappearance, stale leases, quota reservations, DNR ownership, blobs, and Chrome download terminal state.
11. Add the global Active downloads surface required by section 3.1 if jobs survive tab closure. It exposes item, stage/progress, session-retained-data expiry semantics, Cancel, ambiguous save, and terminal result from any normal tab.
12. Retain terminal control records for the numeric B0 window; promptly scrub session URLs and filename/page metadata when terminal.

Acceptance:

- Source-tab close, navigation, and same-URL reload never cause `VIDEO_MISSING` after job acceptance.
- Two simultaneous starts create exactly one offscreen document.
- A rejected dispatch never returns success and leaves no quota reservation or replay rule.
- For cancellation at planning, fetch, processing, blob-ready, delivery intent, known download ID, and completed download, assert terminal state, automatic file count, quota disposition, and DNR/temp cleanup; CPU/network stops within one second, cleanup finishes within five seconds or is journaled for next-start retry.
- Run at least 1,000 randomized terminal/cancel/restart race iterations with no more than one automatic save and no terminal reversal; ambiguous external commits become `SAVE_STATE_UNKNOWN`.
- Popup closure/reopen and service-worker restart reconstruct an actionable state.
- Every accepted command reaches a terminal state or, within the numeric B0 reconciliation deadline, shows the cause plus exact Resume/Retry/Discard/Download-again actions appropriate to the state.

### B4. Tab, DNR, offscreen, and privacy lifecycle

Effort: 7-12 days<br>
Owner: extension/security engineer<br>
Audit coverage: H-04, M-01, M-02, M-09

Tasks:

1. Implement the tab-close decision from section 3.1. Separate tab-scoped captured-header storage from the active job’s minimum replay material.
2. Store explicit DNR ownership, allowed origin/path scope, creation time, and expiry for every rule. Reconcile actual Chrome session rules against this registry at startup.
3. Clear shelf/header state on every top-level load, including same-URL reload; do not require `changeInfo.url` to be present.
4. For separate audio/variant URLs outside the master directory, build a narrow rule for the actual selected origin/path. Never replay Authorization or custom headers from one origin onto another without headers captured for that origin and an approved policy.
5. Close the offscreen document only after all jobs are terminal, all Chrome downloads no longer depend on its blob URLs, and cleanup/revoke is acknowledged. Recreate it cleanly for a later job.
6. Implement the B0 expiry decision. Preferred no-new-permission design: cleanup is event-driven on every progress/start/runtime/tab/download event and startup, and every extension-owned network path passes the reconciliation gate before fetching; no request may begin after lease expiry, even if a sleeping browser delays rule deletion. Document expiry as removal on the first extension wake after expiry. If wall-clock wake is required, add `chrome.alarms`, test sleep/late alarms, and update the manifest plus every “5 API permissions”/privacy/CWS claim before release.
7. Serialize or reject overlapping active DNR scopes carrying different sensitive header values. Preserve `initiatorDomains` restriction and narrow resource types/path scope.
8. Set `storage.local` and `storage.session` access to `TRUSTED_CONTEXTS` and test content-script denial for license, diagnostic, and job records.
9. Add a candidate acknowledgement message/state to the shared B3 protocol for C4’s lazy-image lifecycle.
10. Update `PRIVACY.md`, `PERMISSIONS.md`, `firstrun.html`, hosted privacy copy, and CWS privacy declarations together. Inventory full URLs in session jobs, local license fields, installation IDs, captured headers, DNR rules, temporary files, local diagnostics, and retention.
11. Implement the local diagnostic ring as a strict allowlisted schema with a numeric retention/count cap plus Preview, Delete, and Export controls. Add secret-canary tests containing URL/query/header/key/email/installation-ID/manifest markers and require zero forbidden values in storage/export.

Acceptance:

- Close, cross-document navigate, and same-URL reload clear all tab-scoped state.
- An accepted job follows the documented survive-or-cancel behavior exactly.
- Startup removes orphan rules and never removes a rule still owned by a live job.
- Header values are never replayed cross-origin by inheritance from a master URL.
- No offscreen document remains after the last dependent Chrome download is terminal and the numeric B0 idle grace period expires/on the first extension wake thereafter.
- A privacy inventory test/table matches actual storage keys, fields, owners, and lifetimes.

Current platform references: [Chrome storage lifetimes and access levels](https://developer.chrome.com/docs/extensions/reference/api/storage/), [Chrome downloads events/search/cancel](https://developer.chrome.com/docs/extensions/reference/api/downloads), [Chrome alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms), and [Chrome offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen).

### B5. Fail-safe media behavior on the current pipeline

Effort: 7-12 days<br>
Owner: media engineer<br>
Audit coverage: H-06 through H-10, M-06, M-07

Tasks:

1. Replace million-sample extraction and `samples.push(...batch)` with bounded batches and iterative append.
2. Add parser limits for manifest bytes, representations, periods, segment count, timeline expansion, URL length, redirects, distinct origins, and total planned requests. Reject non-finite, negative, unsafe, or excessive values.
3. Treat bare `mp4protection` CENC and recognized encryption metadata as encrypted/unsupported. Inspect init data for common encrypted sample-entry/box markers before saving output.
4. Detect and reject, before segment download, current unsupported shapes: multiple DASH periods, unsupported negative timeline repeats, SegmentBase, ignored SegmentList ranges, changed HLS maps/discontinuities, and embedded multi-track fMP4.
5. Resolve DASH media type per representation. Keep unsupported status representation-local so an unrelated unsupported representation does not reject a supported selected one.
6. Return `VARIANT_STALE` if a selected representation disappears instead of silently picking the largest replacement.
7. Throw typed empty-manifest and unsupported-shape errors before mux.
8. Correct detector precedence for generic MIME types and known extensions; treat segment MIME types as segments, not standalone direct videos; continue rejecting HTML masquerading as media.
9. Define the advertised support matrix from passing fixtures. Remove or narrow any format/codec claim not backed by a non-mocked output test.
10. For every extension-controlled HLS, DASH, or WebM fetch in Train B, validate the initial destination and use `redirect: "error"`; a redirect is refused and the target is never followed. Map the resulting indistinguishable Fetch failure to a typed `SOURCE_REDIRECT_OR_NETWORK_BLOCKED` category unless the runtime supplies separately qualified evidence; do not tell the customer that a redirect was observed when it was not. Send same-origin credentials by default; send cross-origin credentials only for an origin independently observed/captured for that job and approved by policy; otherwise use `credentials: "omit"`. Reject userinfo URLs, disallowed ports, `.localhost`, and explicit loopback/link-local/private/cloud-metadata IP literals unless same-origin and explicitly approved. Bound decompressed manifest and streamed response bytes. Document DNS-rebinding/private-network-detection limits instead of claiming complete prevention. Do not use `redirect: "manual"` as if ordinary extension Fetch could inspect its opaque redirect response.
11. Treat direct downloads as a separate browser-native capability. In Train B, validate the initial HTTP(S) URL with the static destination policy and never attach captured/DNR headers, but retain and explicitly document that `chrome.downloads.download()` controls subsequent redirects and destination cookies and exposes neither `credentials: "omit"` nor a pre-follow redirect hook. Do not claim hop-by-hop destination enforcement for this path. A stronger contract must route direct files through a D2/D3-qualified bounded fetch/spool/delivery path and pass its own memory, disk, credential, and compatibility gate before replacing native direct downloads.
12. Define a bounded shared `TrackChoice` identity/metadata schema for B5/C2/D1 without eagerly expanding a full media plan. Preserve stable video/audio IDs, media type, codec, bandwidth, language/label/default/role, and compatibility result.

Acceptance:

- A 200,000-sample fixture passes track/codec/duration/full-decode/Chromium-playback oracles within recorded wall-time/peak-memory budgets, and cancellation meets the B3 bound.
- Unsupported/encrypted fixtures make zero media-segment requests, create no Chrome download, and consume no quota.
- Hostile manifests cannot cause unbounded expansion, disallowed-destination or credentialed-unapproved cross-origin extension fetches, or uncontrolled fan-out. The deterministic redirect fixture proves `redirect: "error"` makes no request to the target and maps the failure to the approved redirect/network error category.
- Browser-native direct downloads reject disallowed initial URLs and add no captured headers. Tests and customer/privacy documentation distinguish their Chrome-controlled cookie/redirect semantics from the stronger extension-fetch policy; no acceptance claim implies per-hop inspection of native direct downloads.
- Representation-level audio is never treated as video.
- SegmentList ranges are either honored exactly or rejected; the full resource is never downloaded repeatedly under the appearance of range support.
- Detector fixtures cover generic binary, text/plain manifests, extensionless segment MIME, signed URLs, redirects, and HTML error bodies.

Platform basis: the Fetch Standard defines a manual redirect as an opaque-redirect filtered response, so hop inspection is not a Safety assumption: [Fetch redirect modes and opaque redirects](https://fetch.spec.whatwg.org/#concept-request-redirect-mode).

### B6. Worker correctness and operations

Effort: 3-5 days after A2<br>
Owner: Worker/backend engineer<br>
Audit coverage: H-14, M-04, M-11

Tasks:

1. Expand runtime tests across route/method handling, Stripe signature validation, issuance/email retry, refunds, validation, product isolation, malformed bodies, and D1 errors.
2. Replace activation count-then-insert with one atomic conditional insert/upsert statement. Do not assume that batching a count and insert makes the admission decision atomic.
3. Test concurrent attempts at `maxDevices - 1` and at the limit.
4. Generate `Env` from Wrangler config rather than maintaining a hand-written binding interface.
5. Implement section 3.11: keep production invocation logs/traces disabled, optionally persist approved sampled custom operational events only, assert deployed settings, retention, and access controls, and update disclosures before enablement.
6. Add timeouts and structured error handling for outbound Stripe/Resend calls where the response correctness depends on them. Await required work; use `waitUntil` only for truly post-response operations.
7. Bring the compatibility date forward under tests and verify whether current code needs the documented `nodejs_compat` flag. Config changes follow the current Wrangler schema, not memory.

Acceptance:

- At `maxDevices - 1`, concurrent new-device validations admit exactly one activation.
- Existing-device validation refreshes its timestamp without consuming another slot.
- Worker typecheck and Workers-runtime tests are green.
- Production smoke can identify the deployed version without exposing customer data.
- Alerts distinguish webhook 5xx, validation failure-rate changes, email delivery failures, and D1 errors.

### B7a. Real device deactivation and robust client validation

Effort: 6-10 days across Worker plus ClipHutch client; ComputedKit coordination is additional if done by a separate owner<br>
Owner: backend and extension engineers<br>
Audit coverage: H-14, M-04

Tasks:

1. Preserve old `/validate` behavior for released clients, but add versioned mutation-separated routes for new clients: activation performs the atomic admission, status refreshes only an existing activation and never recreates it, and deactivation deletes only the exact key/installation pair. Product-isolate all routes.
2. Test wrong product, invalid/bounded input, unknown pair, repeated request, last device, immediate explicit replacement activation, and simultaneous status/deactivate. After deactivation completes, status returns inactive and cannot recreate the row; absent and already-deleted pairs receive the same idempotent response.
3. Deploy the endpoint to 100% before client submission. Smoke via a controlled test license.
4. Add a single-flight installation-ID initializer and one client-side license-operation mutex. Abort/settle stale status checks before deactivation; explicit Activate is the only new-client action allowed to create a row.
5. Validate HTTP status, response content type/schema, known reason codes, and timeout. Treat 429/5xx/network failures as transient; definitive license status only may clear entitlement.
6. On Deactivate, keep the local license until the server confirms slot removal. Offer explicit local-only removal as a secondary recovery action with accurate consequences.
7. Show a one-time, actionable explanation when stale revalidation removes a refunded/revoked/not-found license.
8. Update support runbooks and all device-count/deactivation copy.
9. Run the staging buyer journey end to end: checkout event, license issuance/email retry, activation, device limit, deactivation, replacement activation, partial refund, full refund, client revalidation, and support recovery. Then run only reversible/read-only production smoke steps.

Acceptance:

- Deactivation removes only the caller’s exact activation and is harmless when repeated.
- A replacement installation can activate immediately after successful deactivation.
- An offline/5xx deactivation does not falsely say the slot was freed or silently discard the local key.
- Rapid Activate clicks issue one request and use one stable installation ID.
- Old extension clients continue validating throughout the server rollout.

If B7a is not complete for the Safety Release, remove every device-slot recovery claim that implies local removal frees a server slot, document support-assisted recovery, and move B7a to the Workflow Release. This fallback is an explicit release-gate branch, not an accidental deferral.

### B7b. Route-scoped CORS hardening

Effort: 2-4 days plus validation window<br>
Owner: Worker/security engineer<br>
Dependency: B7a staging/old-client matrix; does not block Safety if current behavior is accurately disclosed

Use controlled staging with both products’ stable packed extension IDs rather than collecting production-origin analytics. Return exact allow-origins plus `Vary: Origin` for validation/deactivation, only required origins/methods for checkout, and no CORS on health or Stripe webhook responses. Unknown origins receive no allow-origin header. Treat CORS as defense-in-depth, not endpoint authentication.

Acceptance:

- Route/method/origin/preflight tests cover both stable extension IDs, old clients, controlled checkout origins, unknown origins, health, and Stripe webhook.
- No production origin logging is introduced to justify the allowlist.

### B8. Safety Release candidate and exact-artifact qualification

Effort: 3-5 days<br>
Owner: release owner plus all workstream owners<br>
Dependencies: B0-B6 and either completed B7a or its explicit copy/support fallback; B7b may follow<br>
Audit coverage: all release-blocking findings

Tasks:

1. Run the complete gate in section 11 on Chrome 116 and current stable Chrome.
2. Test the exact clean archive unpacked in Chrome, then hash and preserve it.
3. Create and publish the exact source tag/release before CWS submission.
4. Update listing/privacy declarations if behavior or data lifetime changed.
5. Use deferred publishing so approval and production timing are separate decisions.
6. Record the previous good CWS package and test backward compatibility of stored state so the Web Store rollback is safe.
7. Prepare rollback criteria and a higher-version hotfix path. Current Chrome Web Store documentation supports rollback to the previous published package without another review, but normal browser update propagation and storage compatibility still matter.
8. Run a trusted-tester bake against the exact extracted archive for at least five calendar days across the supported site/media/accessibility matrix. Blocking criteria: duplicate automatic save/quota, stuck job beyond the reconciliation deadline, privacy/header leak, serious/critical accessibility defect, corrupt output on an `ACCEPT` fixture, or unexplained data loss. Every blocker is fixed and the bake restarts; absence of remote telemetry is supplemented by support check-ins and customer-exported redacted diagnostics.
9. Verify anonymously over HTTPS the deployed privacy page and exact source tag/archive; record hashes, test the source-request mailbox, and capture CWS Privacy Practices declarations matching the archive.

### Safety Release gate

Do not submit until every item is true:

- [ ] Exact version/source/tag/artifact consistency.
- [ ] Zero TypeScript errors; test/build/audit/package/browser gates are green.
- [ ] Duplicate commands and quota outcomes are idempotent across restart.
- [ ] Tab lifecycle cannot discard an accepted stream job.
- [ ] A surviving job is globally visible/cancellable, or tab close visibly cancels it under the approved contract.
- [ ] Offscreen dispatch cannot report false success.
- [ ] Cancellation/save races produce at most one automatic save; ambiguous commits are visible and never auto-retried.
- [ ] DNR/header retention matches code, cleanup, and all public disclosures.
- [ ] Aggregate streaming source-byte limits and measured per-path memory budgets pass; current in-memory processing is not described as bounded-memory.
- [ ] Dangerous unsupported media shapes fail early and clearly.
- [ ] Deactivate frees the server slot, or the release removes every claim that it does.
- [ ] Exact packaged artifact passes the scripted keyboard, NVDA, VoiceOver, reflow, lifecycle, and versioned `ACCEPT`/`REFUSE` output matrix.
- [ ] Full browser kill and extension update leave no permanent quota reservation, inaccessible temp data, or misleading resumed state.
- [ ] Trusted-tester bake passes and deployed privacy/source/CWS evidence is archived.

## 8. Train C: Workflow Release

### C1. Shared accessible customer-state components

Effort: 5-9 days<br>
Dependencies: B2 error taxonomy<br>
Audit coverage: H-15, M-04, M-06

Build reusable media-card, tab, status, alert, progress, dialog/disclosure, error-to-action, field/help/error, and save-status primitives. Define focus return, Escape behavior, repeated-control accessible names, and progress-announcement throttling.

Acceptance:

- Popup and options have zero serious/critical automated accessibility violations.
- NVDA on Windows and VoiceOver on macOS announce start, coarse progress, saving, success, cancellation, and failure.
- Tab/Shift+Tab/Enter/Space/Escape behavior is specified and tested.
- Normal text meets 4.5:1 contrast; targets meet WCAG 2.2’s 24x24 CSS-pixel minimum or spacing exception.
- Popup/options reflow at 400%/320 CSS pixels without horizontal document scrolling.
- On the pinned reference profile, a worst-case 50-item shelf is interactive within 500 ms at the 95th percentile; preview work is lazy/bounded to at most four concurrent requests, and preview failure leaves a named fallback rather than removing the item.

### C2. Normalized video/audio choice contract

Effort: 7-12 days<br>
Dependencies: B5 support matrix and shared `TrackChoice`; coordinate with D1 `MediaPlan` identity if Train D has started<br>
Audit coverage: O-03, M-06, H-08, H-09

Preserve audio ID/URL, language, label, default/autoselect, role, codec, channels, bandwidth, embedded/separate status, and compatibility with the chosen video/container. This release selects only among qualified site-labelled tracks with a site-default fallback. If one valid choice exists, select and disclose it. If multiple languages/roles exist, show a labelled Audio choice and mark the site default. Include selected video plus audio bandwidth in approximate size; where a defensible estimate is unavailable, display “Unknown,” not an invented number.

Acceptance:

- Multi-language HLS and DASH fixtures expose correct choices/defaults.
- Selected non-default audio appears in the output, verified by media inspection.
- Reopening the picker preserves customer choice.
- Unsupported combinations are disabled with a reason before download.
- DASH never chooses audio solely because it is `manifest.audio[0]`.
- Controlled CBR fixtures fall within a pre-recorded 20% estimate tolerance; all UI values remain labelled approximate.

### C3. Persistent sequential bulk queue

Effort: 7-12 days<br>
Dependencies: B2-B4, C1 accessible primitives, C2 choice/estimate policy<br>
Audit coverage: H-12, H-13, M-03, M-06

Use B2’s bounded variant lookup as a queue prerequisite. Preflight shows item count, already-running/complete items, remaining free quota, exact videos able to start, explicit quality/audio policy, approximate total size where qualified, and unsupported/cap-blocked items. Reserve quota only as each item starts.

Run one memory-heavy HLS/DASH/WebM job at a time. Direct/still downloads use a separately bounded policy. Persist redacted queue control state and session-only choices so popup closure does not erase current-session intent. Provide Cancel remaining and Retry failed-transient actions; browser exit/update creates interrupted items rather than silently resuming sensitive URLs.

Acceptance:

- Every confirmed supported item reaches a visible terminal/interrupted state; zero silent skips.
- Only one memory-heavy job runs at a time and normal bulk never surfaces `CONCURRENT_LIMIT`.
- Variant preflight times out/aborts within the B0 numeric contract and cannot hang the queue.
- Cancelling one item preserves completed items and does not corrupt later work.
- Retry failed affects only transient failures and preserves available original choices.
- Status announces phases and fixed coarse progress intervals defined before implementation; NVDA/VoiceOver manual approval is recorded.

### C4. Reliable and efficient still-image candidate lifecycle

Effort: 4-7 days<br>
Dependencies: B3 acknowledgement protocol<br>
Audit coverage: H-16, M-08, O-01

Replace URL-only whole-page signatures with candidate acknowledgement/state that can resend relevant source or dimension changes. Handle image load, `currentSrc`/`srcset`, `<picture>`, markup metadata, and `video[poster]`. After the initial scan, process only added/changed nodes. Track and expose truncation/dropped count at the 50-item limit.

Acceptance:

- Fixture recall is 100% for lazy 0x0-to-loaded images, extensionless CDN images, `srcset`/`currentSrc`, `<picture>`, OG/Twitter image, and video poster.
- Each accepted asset appears once despite repeated mutations.
- Only the initial scan walks the full document.
- Before implementation, record the 1,000-image workload, Chrome/device profile, measurement tooling, main-thread budget, recall target, and precision target; the implemented candidate lifecycle passes all of them.
- The popup says results were truncated and how many were dropped.

### C5. Onboarding, empty states, and recovery

Effort: 3-5 days plus customer sessions<br>
Dependencies: stable behavior/copy from C1-C4<br>
Audit coverage: O-02, M-04, M-06, M-09

Put a three-step success path in the first viewport: open and interact with a normal HTTP(S) page, click ClipHutch, choose/download. Explain pinning, reload/interaction, restricted pages, the four-video rolling limit and still exemption, supported versus live/DRM/encrypted content, and what to do when nothing appears. Keep detailed permission/privacy tables below the quick start.

Add timeout/abort behavior to license calls. Access-denied recovery may suggest reload/play where accurate; quota failures show the exact next free-slot time and offer activation/upgrade; unknown errors expose only a redacted diagnostic code. Settings show near-control saving/saved/failed states and retain the prior value after failure. Persistent hide/ignore actions get targeted Undo, and failed previews retain a visible fallback instead of silently disappearing.

Acceptance:

- In exactly 10 predefined summative sessions, at least 9 customers complete the permitted-download task unaided; median time is under two minutes. Recruitment quotas include new/experienced customers plus at least one keyboard-only and one screen-reader or low-vision participant.
- At least 9 of the same 10 meet the published comprehension rubric for rolling quota, still exemption, local processing boundary, and common unsupported cases. Every recruited accessibility participant must complete their critical path without a critical blocker.
- If either 9-of-10 target or the accessibility critical-path gate fails, implement the fixes and run a fresh predefined 10-person summative cohort; a list of planned fixes is not a passing result.
- Empty and error states give a concrete next action without exposing URLs, headers, keys, or stack traces.
- First-run content and options reflow at 400%; tables have captions/scopes and links remain visually identifiable.

### Workflow Release gate

- [ ] Bulk has no silent skips and survives popup/service-worker lifecycle.
- [ ] Audio choice matches output; qualified approximate sizes include selected video/audio and pass the controlled-fixture tolerance.
- [ ] Image recall/cap tests and performance budget pass.
- [ ] Accessibility automation plus NVDA/VoiceOver manual passes are complete.
- [ ] Moderated onboarding and accessibility-segment targets are met after any required implementation and fresh retest.
- [ ] Privacy copy still matches diagnostics and retained state.
- [ ] The exact archive completes a five-day trusted-tester bake with the B8 blocker criteria and redacted support evidence.

## 9. Train D: bounded-memory Media Pipeline v2

### D0. Product-value authorization

Effort: 3-5 days plus interviews/data collection<br>
Owners: product, support, media engineering<br>
Dependencies: Safety/Workflow support evidence

Before authorizing months of architecture work, assemble a redacted failed-job/support corpus, path-specific cap-hit frequency from opt-in diagnostics, trusted-tester interviews, affected media-site/shape coverage, expected success-rate lift, and customer/revenue impact. Rank the smallest media slices that solve the most observed failures. A technically feasible pipeline is not automatically worth building.

Acceptance:

- Each proposed media slice has observed customer evidence, a qualified fixture, expected outcome, cost range, and stop criterion.
- Product owner records GO/NO-GO/DEFER independently for embedded fMP4, TS HLS, separate audio, and DASH.

### D1. Support contract, pure `MediaPlan`, and oracle harness

Effort: 8-12 days<br>
Dependencies: B1, B3-B5, D0 GO for at least one shape

Define supported and explicitly unsupported media shapes. Implement a pure compact plan with range-bearing byte sources, track metadata, initialization IDs, timeline information, discontinuities, encryption, estimates, policy errors, and bounded cursor/range descriptors rather than expanded URL arrays. Persist large integer fields as canonical decimal strings at storage/message boundaries; use `bigint` internally for validation only. Build a deterministic local network server and media oracle harness using pinned MP4 parser/`ffprobe`/`ffmpeg` versions, Chromium playback-to-ended, first/last-frame checks, beep/flash A/V sync, and documented synthetic fixture provenance.

### D2. Per-shape OPFS, mux, and Chrome delivery feasibility gate

Effort: 10-16 days: 5-8 happy-path candidate prototypes plus 5-8 failure/platform/memory/disk qualification<br>
Dependencies: D1<br>
Decision: hard GO/NO-GO independently for each qualified shape

Prove all of the following with browser/process memory measurement, not JS heap alone:

- Append-only per-track spool files plus an offset journal work without creating thousands of segment files.
- The selected shape-specific path (fragment pass-through, fragmented-MP4 writer, seekable OPFS mux, or disk-backed WASM) emits without a whole-output `getBuffer()` copy.
- The file/blob handed to `chrome.downloads.download` does not materialize the entire output in the relevant Chrome process tree.
- Cooperative cancel flushes/closes first; forced termination stops CPU after the deadline; coordinator tombstones retry deletion with backoff when handles release late.
- Incognito, disk quota/full, extension update, abrupt browser exit, and orphan cleanup have defined behavior.
- Peak disk amplification includes input spool, mux output, and Chrome temporary/final copies. `navigator.storage.estimate()` headroom, `QuotaExceededError`, disk-full, repeated-job, and orphan cleanup paths are qualified.

Before the run, pin OS, hardware/RAM, Chrome 116/current stable versions, relevant process-tree selection, measurement tooling, warm-up, baseline, repetitions, and percentile. GO target: across a 1 GiB/16 MiB-segment case, 200,000-sample case, many-tiny-segment case, separate A/V case, no-length responses, and ten repeated jobs, the 95th-percentile total relevant Chrome process-tree private-memory increase remains below 256 MiB; no single JS/WASM `ArrayBuffer` represents the complete source or output; leak, CPU, elapsed-time, progress-cadence, and disk-amplification budgets pass. If a shape fails, keep its conservative cap/refusal and do not block independently passing slices.

### D3. Bounded spooler and network policy

Effort: 8-14 days<br>
Dependencies: B3-B4 and D2 GO for the target shape

Implement bounded fetch concurrency, exact byte-range validation, retry policy, origin/request limits, append-only spool journals, quota headroom, and cleanup. Require 206 plus matching `Content-Range` and exact length. Do not retry 401/403; bound retries for 429/5xx/network reset and honor `Retry-After`. Reapply B5 destination/no-follow/credential policy, including `credentials: "omit"` for unapproved cross-origin requests. A later slice may follow redirects only after a separately reviewed Chrome-runtime prototype proves that it can expose the destination and prevent the next-hop request until policy approval; otherwise redirects remain refused.

### D4. Dedicated cancellable CPU worker and incremental mux

Effort: 8-14 days<br>
Dependencies: B3 and D2-D3

Replace Train B’s terminable whole-memory algorithms with the D2-selected incremental worker/mux path. Bound sample batches, transfer ownership instead of copying where possible, preserve per-track sample descriptions/configuration, and validate timestamps/timescales/edit behavior. Cooperative cancellation precedes forced termination; CPU stops within one second, and temp cleanup completes within five seconds or remains journaled for backoff/startup cleanup.

### D5. HLS delivery

Effort: 8-14 days<br>
Dependencies by slice: D5a fragment pass-through requires D1, a D2 GO for pass-through, and D3. Each D5b-D5d mux-dependent slice requires D1, a D2 GO for that slice's spool/output path, D3, and D4; no HLS slice depends on another unless it reuses that slice's production code.

Ship independently gated vertical slices, not one format big bang: D5a embedded fMP4 fragment pass-through if D2 qualifies it; D5b embedded MPEG-TS H.264/AAC; D5c separate fMP4 A/V; and D5d mixed fMP4 video plus TS AAC audio. A passing D5a does not wait for the incremental mux or other HLS slices. Detect changed maps/discontinuities and continue rejecting them until Train E. Each slice has its own package flag, trusted-test bake, output/memory gate, and rollback decision.

Acceptance includes expected tracks/codecs/duration, full decode, Chromium playback, A/V sync within 50 ms, no unexpected extra download, and bounded memory.

### D6. Static single-period DASH delivery

Effort: 14-23 days<br>
Dependencies by slice: D6a pure planner requires D1; D6b production delivery requires a D2 GO for its output shape, D3, D4, and the corresponding passing D6a planner contract

Build D6a in parallel with D2-D4 where staffing allows; it is a pure parser/planner deliverable and is not advertised until D6b qualifies production delivery. Implement inherited SegmentTemplate fields, MPD/Period duration, representation-local MIME/support state, safe template substitutions, positive and `r="-1"` timelines, site-labelled language/role-aware audio, and SegmentList initialization/media ranges. Store large integers as canonical decimal strings across persistence/messages, use `bigint` internally, and reject values that the selected mux boundary cannot convert safely. Keep dynamic/live MPDs, SegmentBase/SIDX, and multiple periods explicitly unsupported.

Acceptance:

- MPD- and Period-duration fixtures produce expected segment counts.
- `r="-1"` ends at the next timeline start or period end and cannot expand without bound.
- Template inheritance/substitutions are correct at all levels.
- Exact SegmentList ranges, not repeated full-file requests, reach the server.
- One unsupported representation does not block a supported selected one.
- Bare/UUID/init-box CENC is refused before output.

### D7. Qualification and rollout

Effort: 10-18 days<br>
Dependencies per release candidate: D0-D3, D4 only when the target output path requires it, and only the target D5 or D6 slice; no candidate waits for an unrelated format slice

Run deterministic, fuzz, performance, lifecycle, minimum-Chrome, and current-Chrome suites per vertical slice rather than waiting for every format. Capability flags are package-shipped and snapshotted at job start. A disabled capability returns a typed error; it never falls back to a known-corrupt path after downloading bytes.

Roll out first through internal/unpacked and trusted-tester builds with explicit local diagnostic export. ClipHutch’s repo-recorded user count is below the Chrome Web Store threshold for percentage rollout; verify the dashboard at release time. If still ineligible, do not pretend a staged public cohort exists.

### Media Pipeline v2 gate

- [ ] D0 product GO and D2 shape-specific memory/delivery feasibility target pass on minimum and current Chrome.
- [ ] No whole-source/output buffer exists in JS or WASM for each qualified large-job path.
- [ ] Peak disk amplification/headroom and quota/full/orphan cleanup budgets pass.
- [ ] Cancellation stops network and CPU promptly and clears temp/DNR/quota state.
- [ ] Every advertised shape passes all output oracles.
- [ ] Fuzz/property limits prevent hangs, URL-policy violations, and expansion bombs.
- [ ] Each vertical slice’s kill/rollback behavior is store-shipped, privacy-compatible, trusted-tested, and independently reversible.

## 10. Train E: advanced media, separately approved

Do not merge these into Train D estimates or marketing claims.

| Initiative | Scope | Estimate | Entry gate |
| --- | --- | ---: | --- |
| HLS discontinuities | First same-codec timestamp discontinuities and changed init maps; codec changes remain separate | 10-18 days | D5 stable, real customer demand/fixtures |
| DASH multiple periods | First contiguous same-codec periods; gaps, overlaps, changed tracks/codecs separate | 12-22 days | D6 stable and mux timeline model proven |
| SegmentBase/SIDX | Initialization/index ranges, SIDX and possibly nested indexes | 8-15 days | Exact range fetcher and bounded index parser |
| Bounded-memory WebM | 5-10 day architecture spike, then 25-50 day disk-backed FFmpeg WASM or WebCodecs plus streaming MP4 implementation after GO | 30-60 days | Separate shape/platform decision; OPFS alone is insufficient |
| Rich audio policy | Remembered preferences, automatic commentary/descriptive-role policy, advanced channel layouts, and additional mux compatibility beyond C2’s explicit site-labelled selection | 5-10 days | C2 usage evidence and compatible mux paths |

AES-128, SAMPLE-AES, Widevine/FairPlay, live/event streams, MSE-only flows, subtitles/timed metadata, and arbitrary codec changes require separate product/legal/security decisions and are not implied by this roadmap.

## 11. Verification matrix

### 11.1 Required automated commands

The final script names may differ. CI runs install once, then the non-recursive DAG and exact-archive checks:

```text
extension: npm ci
extension: npm run verify:source    # typecheck, tests/coverage, fresh build, prod+dev dependency audits, dist audit
extension: npm run package          # archive that fresh dist once
extension: npm run verify:package   # extract archive, re-audit, run browser tests on extraction
cloudflare: npm ci
cloudflare: npm run typecheck
cloudflare: npm run test
```

### 11.2 Browser lifecycle matrix

For direct, HLS, DASH, and WebM where applicable:

- start twice in the same tick;
- close popup and reopen;
- suspend/restart service worker during planning, fetch, processing, blob-ready, delivery intent, and save;
- hard-kill/restart the browser and update/reload the extension during every phase, expecting session state loss plus a redacted interrupted/cleanup outcome rather than false resumption;
- close tab, navigate cross-document, and same-URL reload;
- cancel during every phase and repeat cancel;
- force offscreen creation rejection and start-ACK loss;
- force terminal-message replay and cleanup-ACK loss;
- update/rollback with legacy local/IndexedDB records and temp-store versions; do not assume `storage.session` survives update;
- ensure one quota disposition, at most one automatic Chrome download, and one terminal or explicit `SAVE_STATE_UNKNOWN` result.

### 11.3 Media/security fixture matrix

HLS fixtures include TS embedded A/V, fMP4 video-only, embedded two-track fMP4, separate fMP4 A/V, fMP4 plus TS AAC, explicit/implicit ranges, changed maps, same/changed-codec discontinuities, encrypted/live/empty/truncated playlists, multi-audio roles, and more than 150,000 audio samples.

DASH fixtures include MPD/Period durations, inheritance levels, Number/Time/formatted templates, escaped dollars, positive/negative repeats, Representation-only MIME, SegmentList ranges, SegmentBase/SIDX, multiple BaseURLs/origins, periods, audio language/roles, CENC variants, dynamic MPDs, unsafe numbers, huge repeats, excess representations, and hostile URL schemes.

Maintain a versioned table that marks every fixture `ACCEPT` or `REFUSE` with the expected code for Safety, each Pipeline v2 slice, and Train E. Every `ACCEPT` passes track/codec/duration/full-decode/Chromium-playback checks on the exact archive; every `REFUSE` makes no unintended media request/download/quota charge. The deterministic network server covers required headers, ambient credentials, parallel-path/cross-origin audio, destination/private-address policy, redirects, no content length, slow/stalled streams, disconnect/retry, 401/403/404/416/429/5xx, correct and malformed ranges, and cancellation mid-transfer.

### 11.4 Fuzz/property gates

- Pull requests: at least 500 deterministic structural/mutation parser cases per format within a pinned time budget and per-case timeout.
- Nightly: at least 10,000 cases or the pinned time budget, whichever comes first, with failing seeds persisted and each case isolated.
- Invariants: no hang, raw internal error, non-finite output, non-HTTP(S) request, configured-limit breach, or unbounded expansion.
- Fuzz malformed MP4 box lengths/sample tables as well as manifests.
- Target at least 90% branch coverage for parser, policy, job-transition, quota, and range modules, plus at least 70% mutation score for parser/policy code. Do not use a weak global coverage number as the only gate.

### 11.5 Customer/accessibility gates

- Mouse, keyboard, touch, NVDA, and VoiceOver paths.
- 400% zoom/320 CSS-pixel reflow.
- Start/cancel/retry/result focus flow.
- Coarse live progress without announcement spam.
- Error/action mapping reviewed for every known code.
- B0 formative protocol and at least 10 C5 summative sessions with the published recruitment/task/comprehension rubric.

### 11.6 Privacy and diagnostics gates

The local diagnostic ring buffer may contain only event enum, media kind, state transition, typed error/category, queue length, size/duration bucket, duplicate-suppressed count, quota outcome, candidate source/rejection reason, and site-default/custom-audio choice. It may not contain URL, host, query string, page title, filename, captured header, license key, email, installation ID, Stripe payload, or raw manifest.

Export is customer initiated, previewable, deletable, and redacted. Retention/count limits are numeric and disclosed. Secret-canary tests prove forbidden fields never persist/export. Production extension analytics are absent. Worker operational logging follows section 3.11, including disabled invocation logs/traces and disclosed custom-event retention if enabled.

## 12. Rollout, rollback, and operations

### Worker

1. Pass mutation/E2E tests against A0 staging bindings, never production data.
2. Save the current production version ID, reconciliation report, and smoke baseline.
3. Create a `100% old / 0% new` production deployment, use a version override, and fail unless version metadata proves the target executed. Run only read-only or explicitly reversible smoke.
4. Promote backward-compatible fixes to 100%. Avoid a traffic split for a correctness fix where an old request can still mutate status incorrectly, or for a new route whose old version returns 404.
5. Monitor approved custom operational outcomes and Stripe delivery without identifiers or invocation logs.
6. Roll back code on signature/webhook regression, validation-success collapse, incorrect status mutation, or D1 error increase; use reconciliation plus row-level compensation for bad mutations.
7. Use additive D1 migrations. Time Travel’s current whole-database seven-day Free/30-day Paid window is disaster recovery only; Worker rollback does not roll back D1, and restoring an old database could erase newer valid purchases.

Current references: [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/), [Workers Logs and invocation-log controls](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [D1 `batch()` semantics](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch), [Workers version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/), and [gradual deployments/version skew](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/).

### Chrome Web Store

1. Use deferred publishing after review and record its current 30-day publish deadline.
2. Test backward-compatible storage migration and the previous package locally.
3. Preserve current and previous exact packages, source tags, checksums, listing/privacy snapshots, and smoke evidence.
4. Verify dashboard eligibility before claiming percentage rollout. Official percentage rollout currently requires more than 10,000 seven-day active users; the repo records roughly 1,000.
5. On a severe regression, use the Chrome Web Store rollback to republish the previous package under the required higher version, then verify propagation and submit the corrected forward version. Record that initiating rollback discards pending submissions.

Current references: [update and percentage rollout](https://developer.chrome.com/docs/webstore/update/), [rollback](https://developer.chrome.com/docs/webstore/rollback).

### Capability rollback

Package-shipped capability flags support conservative defaults and rollback in the next package. They are snapshotted when a job starts. Two semantic modes are allowed: disable new jobs, or explicitly abort all affected jobs. Never silently restart a large job on the old pipeline after media bytes were downloaded.

An instant remote flag would create a new first-party network contact. Do not add it without a signed declarative format, no identifiers/executable code, short caching, fail-closed defaults, updated privacy/CWS disclosures, and explicit approval.

## 13. Risks and mitigations

| Risk | Consequence | Mitigation / gate |
| --- | --- | --- |
| Idempotency blocks intentional re-download | Customer cannot get a second copy | Dedupe command intent, not media ID; explicit “Download again” creates a new ID |
| Restart strands locks/reservations | Stuck job or lost free quota | Persist leases; reconcile jobs, Chrome downloads, quota, DNR, and temp journals at startup |
| Delivery commit is ambiguous across a service-worker crash | Duplicate or missing file | Persist delivery intent, observe/reconcile Chrome downloads, allow at most one automatic call; show `SAVE_STATE_UNKNOWN` for customer choice |
| Tab-close cleanup breaks an active job | Deterministic failure | Adopt one explicit survive-or-cancel contract; align rule lifetime and disclosure |
| Header replay crosses origins | Credential disclosure | Per-origin captured material only; narrow URL rules; bounded TTL and startup reconciliation |
| A configured source limit still allows current mux copies to OOM | Browser/extension instability | Stream-count source bytes, measure process memory, choose lower path-specific limits, describe Safety as fail-safe rather than bounded-memory |
| OPFS hides, rather than fixes, memory copies | Large jobs still OOM | Measure process memory and output path; GO only without full JS/WASM buffers |
| Queue reserves all quota early | Customers lose quota for unstarted work | Reserve per item only when it begins |
| Rich audio UI overwhelms simple cases | Worse usability | Hide picker for one compatible track but disclose default; progressive disclosure |
| Lazy-image fix increases page work/noise | Page slowdown and shelf spam | Acknowledged incremental candidates; full scan once; performance and dedupe budgets |
| Live regions announce every segment | Screen-reader overload | Announce phase and coarse percentage milestones only |
| Activation race exceeds device cap | Revenue/support issue | One conditional D1 statement plus real concurrent runtime test |
| CORS is mistaken for authentication | False security or buyer lockout | Treat as defense-in-depth; test stable packed origins in staging and enforce per route after old-client evidence |
| Automatic stale-device eviction removes valid offline devices | Paid customer lockout | Do not ship automatically; explicit deactivation first; revisit only with policy/data |
| Partial rollout creates Worker version skew | Intermittent route/behavior | Version-override smoke then 100% promotion for contract changes |
| CWS rollback breaks stored state | Data loss/stale jobs | Backward-compatible schemas and local rollback test before release |
| Diagnostics erode privacy positioning | Trust/CWS disclosure failure | Local, redacted, bounded, customer-exported only |
| Marketing outruns passing fixtures | Broken customer expectations | Advertised support matrix is generated/reviewed from qualified fixture results |

## 14. Adversarial review and roadmap adjustments

Three scoped static adversarial reviews attacked the draft from customer/accessibility, extension security/lifecycle, and media/performance/testing perspectives. Current Chrome, Cloudflare, D1, Stripe, and repository behavior was checked against first-party documentation and code. The roadmap above incorporates the accepted changes; D2 explicitly remains an unproven runtime feasibility gate.

| Challenge | Draft weakness exposed | Adjustment made |
| --- | --- | --- |
| Current customers remain exposed while the plan runs | “Immediate containment” originally changed no extension behavior for weeks | Added a 24-hour withdraw/accelerate/accept decision, a B1-lite path, and kept B2 independently releasable before B3 |
| Stop customer harm before refactoring | A long job-model rewrite would leave duplicate quota use and false bulk promises live | Added B2 containment before B3 and disabled impossible bulk until C3 |
| Accessibility cannot wait for the redesign | Deferring a11y would recreate every inaccessible state in the queue/picker | Moved minimum remediation into B2 and made C1 primitives precede C2/C3 |
| “OPFS” is not synonymous with bounded memory | MP4Box and FFmpeg can still create full input/output copies | Made D2 a hard browser/process-memory GO/NO-GO; no implementation commitment if it fails |
| WebM does not become bounded with the HLS/DASH spooler | FFmpeg MEMFS retains JS, WASM input, WASM output, and JS output | Split WebM into a 5-10 day spike plus 25-50 day implementation after GO; retain a conservative cap meanwhile |
| Parser support alone cannot handle HLS discontinuities or DASH periods | Timestamp/config changes are mux/output problems | Moved discontinuities and periods after the common mux foundation and narrowed first support to same-codec cases |
| Chrome download cannot atomically commit with extension storage | A persisted claim can still lose or duplicate a save across a crash | Adopted delivery intent/onCreated reconciliation, at-most-one automatic save, and visible `SAVE_STATE_UNKNOWN` |
| Safety cancel cannot preempt synchronous muxing | Offscreen cannot process Cancel while HLS/DASH CPU work blocks its thread | Moved a minimal terminable per-job CPU worker into B3; D4 later makes it incremental |
| Closing offscreen at blob-ready breaks download URLs | Blob ownership can outlive processing | Close only after Chrome download terminal state and revoke/cleanup ACK in B4 |
| Tab-close privacy and job survival conflict | “Clear everything” plus “finish download” is impossible; survival was invisible | B0 chooses global Active downloads plus session-scoped replay, or visible cancel-on-close |
| Session storage is not update/restart durability | The draft expected old session job records after browser restart/update | Added field-level session/IndexedDB/local/OPFS placement and redacted interruption semantics |
| Manifest URLs can target credentialed/private destinations | Cross-origin Authorization policy did not cover cookies, redirects, or local IPs | Added same-origin credential default, fail-closed redirects for extension fetches, private-target policy, byte/request/origin bounds, and documented limits |
| Redirect controls were overpromised | Fetch manual redirects are opaque, while native Chrome downloads expose no fetch redirect/credential controls | Made extension fetches fail closed with `redirect: "error"`; documented and separately gated Chrome-controlled direct-download semantics |
| `D1.batch()` alone does not fix admission races | A transaction can still execute logically unsafe count-then-insert steps | Required one atomic conditional insert/upsert and a concurrent admission test in B6 |
| `/deactivate` client can race CWS ahead of server | Old Worker versions would return 404 and strand customers | Required server-first 100% deploy and backward-compatible client rollout in B7a |
| Production Worker canaries still mutate production D1 | A version override changes code, not bindings, and rollback cannot undo rows | Added a separate staging Worker/D1 plus mutation journal, reconciliation, and row-level compensation |
| CORS is not authentication and enforcement can lock out purchasers | Early restriction provides limited security and substantial compatibility risk | Split B7b, use stable packed-origin staging tests, and kept CORS defense-in-depth/non-blocking |
| Production telemetry contradicts the trust promise | Success metrics and invocation logs could collect undisclosed metadata | Restricted extension measurement and disabled Worker invocation logs/traces; approved custom operational events require disclosure/retention controls |
| A remote kill switch is itself new data handling | “Safe rollout” would create an undisclosed server contact | Defaulted to package-shipped flags; remote config requires a separate privacy/CWS decision |
| CWS rollback assumptions were stale | Draft assumed only a slow higher-version hotfix | Verified and added the current no-review Web Store rollback path, while retaining storage-compatibility tests |
| Percentage rollout is not available at ClipHutch’s recorded scale | A staged rollout plan would be operationally fictional | Added dashboard eligibility verification and trusted-tester/internal alternatives |
| Queue dependencies were reversed | Bulk required accessible primitives, audio policy, and timeouts that were scheduled later | Reordered C1 accessibility → C2 choices → C3 queue and moved variant timeout into the queue prerequisite |
| Research gate was untestable | Five sessions cannot demonstrate a 90% threshold and occurred after design | Added B0 formative research and a 9-of-10 summative rubric with recruitment segments |
| Estimates understated cross-layer media work | Headline ranges did not equal task sums; D2/WebM were under-scoped | Recomputed bottom-up totals, split feasibility work, and added a 20% planning reserve |
| Media-slice dependencies recreated a format big bang | D5-D7 metadata blocked pass-through and DASH planning on unrelated mux/format work | Split D5/D6 dependencies by slice and made D7 depend only on the candidate actually being qualified |

### Execution red-team adjustments

After implementation, a second adversarial pass attacked the running contracts,
migration history, remote configuration, and failure windows. The accepted
adjustments are part of the candidate and its release gates:

| Adversarial finding | Adjustment |
| --- | --- |
| A preventive refund fix does not repair customers already marked refunded | Recorded both production rows as unresolved and made authoritative Stripe disposition plus journaled compensation a promotion blocker |
| Stripe can deliver a full refund before Checkout issuance | Added a persistent idempotent refund inbox consulted during issuance and covered refund-before-checkout/replay orderings |
| A delayed deactivation can delete a newly reactivated device | Added activation generations, operation IDs, conditional deletion, and delayed-replay tests |
| Module-local activation locks do not coordinate popup and Options realms | Moved license mutation ownership into one trusted background runtime and proved two independent clients create one server activation and one installation ID |
| Concurrent/crash-window email delivery can send duplicate or unusable keys | Added an active-license delivery lease and a deterministic Resend idempotency key; retired the out-of-band resend script |
| Broad account-wide Checkout handling can mint ClipHutch keys for unrelated products | Qualified ClipHutch by the exact Payment Link, qualified ComputedKit separately, and acknowledge known-other genuine events without mutation |
| A final schema bootstrap bypasses Wrangler's migration ledger | Split a base schema from numbered migrations, exercised the migration sequence, and added 0004 rather than rewriting an already-applied 0003 |
| Request-path retention cleanup lets unauthenticated traffic force D1 writes and makes housekeeping a customer dependency | Moved cleanup to a scheduled handler; unmatched refund correlation expires sooner than matched operational evidence |
| A syntactic deploy wrapper and ordinary health fetch do not prove candidate execution | Added current-version checks, 0% candidate staging, Cloudflare version-override smoke, exact metadata evidence, pinned origins, redirect refusal, and explicit promotion commands |
| The previous production version is a refund-unsafe rollback target | Required a small refund-safe hotfix/known-good rollback point before rolling out the broader lifecycle candidate |
| Privacy copy omitted local license state, deactivation correlation, and operational retention | Updated all coordinated repository surfaces and kept hosted publication blocked until the server behavior is live |

### Rejected shortcuts

- Raise offscreen concurrency to make bulk look complete.
- Keep `Continue anyway` above the documented hard cap.
- Add parser features directly to the current all-in-memory pipeline without early rejection and limits.
- Write segments to OPFS and still call MP4Box `getBuffer()` for the full output.
- Automatically fall back to a known-corrupt pipeline after a large failed download.
- Remove a local license before server deactivation succeeds.
- Evict “stale” paid devices automatically without a separately approved policy.
- Replay a master request’s Authorization/custom headers onto a different origin.
- Add remote analytics or configuration under the current “no analytics” disclosure.
- Refresh onboarding/marketing claims before the support contract and behavior are stable.

## 15. Recommended staffing and calendar sequence

Capacity assumption: one extension/media engineer and one Worker/product engineer, with scheduled QA, privacy, accessibility, and research support. A second dedicated media engineer is called out where it materially changes elapsed time; engineer-day totals do not shrink with parallelism.

| Relative time | Primary work | Parallel work | Exit |
| --- | --- | --- | --- |
| First 24 hours | Decide accelerate B2, withdraw, or time-bounded risk acceptance | Start artifact/refund triage | Current extension exposure has an accountable response |
| Weeks 1-2 | A1, B0 contract/research, B1/B1-lite | A0 staging and A2 refund hotfix/remediation | Source/backend containment and build basis |
| Weeks 3-5 | B2 release-capable containment | B6 Worker correctness | Duplicate/bulk/cap/accessibility harm contained; optional early package bake |
| Weeks 5-9 | B3 job/delivery/CPU-worker protocol | B7a deactivation | Lifecycle ownership and server compatibility |
| Weeks 9-14 | B4 privacy/DNR plus B5 fail-safe media, sequential with stated staffing | B7b staging CORS if pursued | Safety behavior complete |
| Weeks 14-17 | B8 exact-artifact trusted bake/submission | Docs/site/CWS evidence | Safety Release submitted |
| Following 7-11 weeks | C1-C5 plus formative remediation/summative research/bake | D0-D2 may start only with a second media engineer | Coherent customer workflows |
| Following 4-7 months | D0-D7 shape-specific slices with one media engineer | Train E demand validation only | Qualified bounded HLS/static DASH increments |
| Later, demand-gated | Train E initiatives | Continued corpus/support analysis | Advanced format increments |

With the stated two roles, the Safety critical path is approximately 14-17 calendar weeks plus CWS review; adding a second dedicated media engineer can bring B5 and early D0-D2 forward and may reduce Safety to roughly 11-14 weeks. A solo engineer should plan 5-8 months through Safety. D0/D1/D2 should start immediately after B3/B5 foundations, in parallel with Train C only when a separate media owner exists, so the largest technical risk is not deferred unnecessarily.

## 16. Definition of done for every implementation ticket

- The ticket links its audit ID, evidence lines, dependency, customer outcome, and rollback behavior.
- Tests fail before the fix and pass after it; critical fixtures are checked in or fetched deterministically with integrity verification.
- Error, cancellation, restart, and privacy-retention behavior are covered, not only the success path.
- UI changes include keyboard, focus, accessible name/status/alert, reflow, and reduced-motion behavior where relevant.
- Storage fields have an area/store, owner, purpose, exposure, numeric lifetime, cleanup trigger, migration behavior, and disclosure decision.
- Network requests have timeout/abort, URL/origin policy, redacted error handling, and bounded retry.
- No new public claim ships without a passing fixture or verified behavior.
- No public/privacy copy is edited in only one of the coordinated surfaces.
- `verify:source`, `package`, `verify:package`, and exact-archive Chrome inspection are green in that order.
- External side effects define crash ambiguity, at-most-once behavior, reconciliation, and customer recovery.
- Operational deploy, smoke, monitoring, and rollback steps are written before merge.

## 17. Traceability to the audit

| Audit finding | Roadmap owner |
| --- | --- |
| H-01 release/source mismatch | A1, B1, B8 |
| H-02 tab lifecycle loses stream completion | B3, B4 |
| H-03 swallowed offscreen dispatch | B3 |
| H-04 DNR cleanup/privacy mismatch | B4 |
| H-05 in-memory copies and unsafe cap | B2, D2-D4 |
| H-06 mux sample spread crash | B5, D4 |
| H-07 HLS multi-track/map handling | B5 early refusal, D5, Train E |
| H-08 DASH periods/duration/timeline | B5 early refusal, D6, Train E |
| H-09 DASH ranges/media type/global unsupported | B5, D6, Train E |
| H-10 bare CENC | B5, D6 |
| H-11 cancellation cannot interrupt/save race | B3, D4 |
| H-12 duplicate/reentrant downloads | B2, B3 |
| H-13 false bulk contract | B2 containment, C3 solution |
| H-14 device activation/deactivation | B6, B7a |
| H-15 accessibility | B2, C1, all UI definitions of done |
| H-16 lazy/extensionless images | C4 |
| M-01 same-URL reload cleanup | B4 |
| M-02 offscreen/job lifetime and data retention | B3, B4 |
| M-03 quota reservation after crash | B3, C3 |
| M-04 license HTTP/revalidation behavior | B7a, C5 |
| M-05 partial refund | A2 |
| M-06 misleading errors/estimate/limit UI | B2, C2, C3 |
| M-07 detector MIME precedence | B5 |
| M-08 silent 50-item cap | C4 |
| M-09 privacy inventory omissions | B4, section 11.6 |
| M-10 typecheck/CI/test debt | B1, section 11 |
| M-11 Worker test/config/observability debt | B1, B6 |
| O-01 repeated full DOM scans | C4 |
| O-02 onboarding and empty-state refinement | C5 |
| O-03 audio language/role choice | C2 |

## 18. Approval checkpoints

The recommended default is already stated; these are explicit points where evidence may change scope:

1. B0 product/privacy/storage/accessibility owners ratify survive-with-global-control or cancel-on-close, numeric lifetimes, and storage placement before B2/B3 code depends on them.
2. B2 benchmarks select and may lower path-specific source-byte limits; Train B may not raise them without new evidence and requalification.
3. The versioned Safety `ACCEPT`/`REFUSE` matrix is approved before listing/onboarding copy is updated.
4. D0 must authorize customer value and D2 must record per-shape GO/NO-GO with measurements before the corresponding D3+ production slice begins.
5. Each Train E initiative needs customer evidence, fixtures, and a separately approved estimate.
6. Remote extension analytics/configuration, Worker invocation logs/traces, automatic stale-device eviction, encrypted media, and live-stream support always require separate privacy/product approval.
