# ClipHutch Capture Pack implementation roadmap

Status: C1-C7 and O5 implemented, adversarially hardened, and checkpointed at `9b538c1`; not deployed, tagged, release-packaged, or approved for production release<br>
Prepared: 2026-08-15<br>
Last status update: 2026-08-28<br>
Code baseline: `option-c-stage-1-separate-audio` at `9b538c1`, manifest version `0.1.4`<br>
Scope: C1 through C7 plus O5. This document interprets `05` as `O5`, the side-panel workspace.

## Implementation execution tracker

Implementation began on 2026-08-15. This tracker is updated after every implementation slice and adversarial correction pass.

| Slice | Scope | Implementation | Adversarial review | Corrections | Verification |
| --- | --- | --- | --- | --- | --- |
| Baseline | Existing extension before Capture Pack changes | Complete | Not applicable | Not applicable | 6 TypeScript projects passed; 357 tests passed; production build passed |
| 1 | Versioned contracts, session draft storage/reducer, safe paths, pure manifest model | Complete | Complete | Complete | 67 focused tests; 432 full-suite tests; 6 TypeScript projects; production build |
| 2 | Immutable mixed-media executor, batch quota, snapshot delivery | Complete | Complete | Complete | 37 test files / 565 tests; 6 TypeScript projects; production build; diff check |
| 3 | C1/C3/C4 current-page selection, review, folders, buying gate | Complete | Complete | Complete | 52 test files / 732 tests; 6 TypeScript projects; production build; Chrome smoke; independent 90-test release gate |
| 4 | O5 shared UI and side-panel workspace | Complete | Complete | Complete | 54 test files / 777 tests; 6 TypeScript projects; production/development builds; 38-check artifact audit; real-Chrome side-panel, 160/200 px zoom-equivalent, and focus smoke |
| 5 | C2 cross-tab Hutch and bounded header leases | Complete | Complete | Complete | 58 test files / 815 tests; 6 TypeScript projects; development build; 47-check artifact audit; real-Chrome load; independent 93-test frozen gate |
| 6 | C5 terminal manifest delivery | Complete | Complete | Complete | 68 test files / 906 tests; 6 TypeScript projects; development build; 51-check artifact audit; release checks; real-Chrome end-to-end manifest smoke; independent 153-test frozen gate |
| 7 | C7 automatic quality and C6 high-confidence Best Copy | Complete | Complete | Complete | 78 test files / 1,096 tests; 6 TypeScript projects; production build; independent 235-test frozen gate; real-Chrome retained-manifest A/B smoke |
| 8 | Final accessibility, privacy, browser, package, and release hardening | Complete | Complete | Complete | Development candidate passed; clean tagged-source packaging and the manual release matrix remain approval-time gates |

Review protocol for every slice:

1. Implement the smallest end-to-end or pure-foundation increment defined for the slice.
2. Run focused tests, all extension tests, all TypeScript projects, and a production build where relevant.
3. Give the resulting code to an independent adversarial reviewer with explicit race, privacy, corrupt-state, accessibility, and customer-outcome prompts.
4. Classify every finding as release-blocking, required hardening, or deferred scope.
5. Apply all release-blocking and required-hardening corrections before advancing.
6. Record the findings, decisions, corrections, and exact verification results in this document.
7. Continue to the next slice only after its tracker row is complete.

### Execution log

#### Baseline - 2026-08-15

- `npm run typecheck`: all six environment projects passed.
- `npm run test:run`: 21 test files and 357 tests passed.
- `npm run build`: Vite production build passed.
- The worktree already contained substantial customer/release/license/media changes. Capture Pack implementation must preserve those changes and isolate new work until integration points are deliberately reviewed.

#### Slice 1 - contracts, reducer, safe paths, and manifest model - 2026-08-15

Implemented:

- Added runtime-guarded V1 contracts for media snapshots, draft items/preferences, review plans, runs, jobs, and quality policy/choice.
- Added a revisioned, bounded session-draft reducer and background-owned storage adapter. Drafts are limited to 200 items and 1 MiB of serialized metadata.
- Added deterministic `ClipHutch/<pack>/<page>/<filename>` path construction, canonical validation, Unicode normalization, Windows-reserved-name handling, traversal rejection, total/segment bounds, and collision suffixing.
- Added redacted terminal JSON/CSV manifest construction with a 200-item/1 MiB output bound, basename-only final filenames, typed public errors, chronology checks, and spreadsheet-formula neutralization.

Independent adversarial review found release-blocking weaknesses despite the first focused suite passing: module-local locking across extension realms, permissive prebuilt paths, formula-injectable CSV cells, runtime guards that accepted contradictory plans/jobs, stale-write dedupe, undeclared-field retention, and untyped storage failures. A second reviewer independently reproduced the path, manifest, cross-context, state-invariant, and identity issues.

Corrections applied:

- Canonical allowlist clones now discard undeclared fields such as headers, authorization material, and license data; exported guards fail closed on hostile accessors/proxies.
- Media inputs require bounded HTTP(S) URLs and coherent timestamps/provenance. Plan totals are recomputed and checked; IDs and paths are unique; media/quality/resource-class/state/result/error/progress combinations must be coherent.
- Revision validation happens before semantic duplicate handling. Stale writers receive the latest revision, while a genuine already-selected item and an identity collision have distinct results.
- Every reducer result returns an isolated clone, and Chrome storage read/write failures return typed failures.
- File paths and pack roots now have distinct canonical validation. Unsafe prebuilt paths cannot bypass the same constraints used by construction, and collision suffixes remain inside the configured bound.
- Manifest enums, dates, item chronology, pack/item terminal consistency, output bytes, and CSV cells are validated at runtime.

Decisions carried forward:

- The module-local lock is not presented as cross-context coordination. The service worker is the declared sole writer; typed UI-to-background command routing is a release-blocking first step in Slice 2 before any popup or side-panel caller may mutate the draft.
- A redacted source-page path remains in the optional manifest because it is intentional provenance. Credentials, queries, fragments, media paths, signed media URLs, raw errors, and absolute local paths remain excluded and output is bounded.
- Explicit new-pack and preference-update commands are deferred to the review/UI slice; no UI is allowed to bypass the reducer meanwhile.

Verification after corrections:

- Slice 1 focused suites: 4 files and 67 tests passed.
- Combined foundation suites including Slice 2 batch quota: 5 files and 87 tests passed.
- Full extension suite: 25 files and 432 tests passed.
- All six TypeScript environment projects passed.
- Vite production build passed and `git diff --check` was clean.

#### Slice 2 - immutable executor, batch quota, delivery, and recovery - 2026-08-15

Implemented:

- Added strict background-owned draft message parsing and a guarded UI client. The UI sends only bounded tab/media IDs, revisions, names, and command IDs; it cannot inject a URL, captured header, planned path, job, or snapshot.
- Added bounded immutable media snapshots and a mixed-media plan executor. Direct files and stills use a three-start native lane; HLS, DASH, and WebM share one FIFO heavy lane.
- Added one versioned run graph, per-job session records, legal attempt-scoped state transitions, stable SHA-256 job/attempt IDs, and a background scheduler. Capture jobs no longer depend on the source-tab shelf at delivery time.
- Persisted `delivery_pending` before invoking the Downloads API and introduced `save_state_unknown` for the unavoidable external-commit ambiguity. HLS and DASH choices are now discriminated as an HLS variant URL versus a DASH representation ID.
- Added versioned all-or-none free-video batch reservations, per-member `reserved`/`charged`/`released` outcomes, migration from the legacy quota history, and next-wake reconciliation. Stills and licensed runs bypass the video reservation path.
- Added an independent redacted command ledger, atomic initial graph commit with post-failure read-back, command replay, active graph/serialized-byte bounds, terminal retention, and exact plan/draft identity.
- Added exact `jobId + attemptId` offscreen ownership, acknowledged start/cancel/revoke/status messages, bounded tombstones, one-heavy-lane enforcement, and acknowledged/retried Blob delivery.
- Added module-boot recovery for queued, running, processing, delivery-pending, saving, cancelling, and terminal work. Recovery queries exact offscreen attempts and Chrome download states, rejects orphan attempts, and never blindly repeats an ambiguous save.
- Added job-scoped DNR ownership records and startup cleanup. Rules are removed when network processing ends and retried after interruption.

Independent adversarial review found release-blocking race and persistence gaps after the initial suites were green:

- Progress writes could win a compare-and-set immediately before a Blob/error/Chrome-terminal event, leaving the stored job running and holding the lane forever.
- A service-worker restart only drained queued work; it did not reconcile offscreen ownership, Downloads API state, cancellation, or the `delivery_pending` commit window.
- Offscreen terminal messages were fire-and-forget, so a suspended background could lose Blob ownership and strand memory, quota, DNR state, and the heavy lane.
- The first run ledger doubled as the command ledger; pruning ten terminal runs could make a replay start a second run. A failed `storage.session.set()` was also being treated as definitely uncommitted even though Chrome may have committed it.
- Local quota reservations can outlive session run state on extension reload/update, and mixed item outcomes require settlement per reservation rather than at the batch level.
- Generic `fixedVariantId` could confuse an HLS URL with a DASH representation ID.
- Tab-close durability still requires a separately bounded header lease, and a customer-visible enqueue/cancel surface still requires authoritative Slice 3 commands. These are explicit later-slice gates, not claims made by this foundation.

Corrections applied:

- All events for one capture job now pass through a serialized controller; progress is coalesced before terminal work, while state/terminal events cannot be displaced by a fixed retry budget.
- Blob-ready is retried until background gives an attempt-bound durable acknowledgement. Late, duplicated, cancelled, or older-attempt events can only clean up their own resources.
- Recovery planning is pure and exhaustively state-driven; guarded actions stop on revision mismatch. Native delivery ambiguity and an absent/unqueryable Chrome record are different conditions.
- Command records and presentation run history are independent. Initial run/index/job/command persistence uses exact read-back before compensation, pending commands are never pruned, and settled commands are capped separately at 200.
- Quota state is a redacted local per-member ledger. Acceptance is marked only after graph commit; startup reconciliation settles or releases provable orphans without inferring success from missing session metadata.
- Storage validates legal transitions, monotonic progress, graph ownership, aggregate jobs, active runs, manifest IDs, and serialized sizes at every write boundary.
- Capture DNR rules have a separate bounded ownership registry and are swept at boot; executor setup failures compensate state, quota, and rule ownership.
- HLS and DASH execution now consume the explicit discriminated selector, retaining the old field only as a guarded read-only compatibility alias.

Decisions carried forward:

- Slice 3 must add strict `capture-plan-create`, `capture-run-enqueue`, and background-owned cancel commands before the new executor is reachable from a customer surface.
- Slice 5 must copy approved replay material into a 60-minute, session-only header lease at Add time. Ordinary tab headers still clear immediately on navigation/close; Retry after that cleanup is not promised without a valid lease.
- Terminal job snapshots remain session-only and identifiable for Activity. Slice 6 must build the redacted terminal manifest and then scrub raw URL/page metadata on the documented retention boundary.
- Full browser integration tests that kill the service worker at each Chrome/offscreen side-effect boundary remain part of the final real-Chrome gate; unit recovery fixtures do not substitute for that platform proof.

Verification after corrections:

- `npm run test:run`: 37 files and 565 tests passed.
- `npm run typecheck`: all six environment projects passed.
- `npm run build`: Vite production build passed.
- `git diff --check -- extension`: clean.

#### Slice 3 - current-page Capture Pack, review, folders, and buying gate - 2026-08-15

Implemented:

- Replaced URL-only shelf identity with tab-scoped media record IDs, canonical identity merging, dimensions/provenance/first-and-last-seen metadata, stable evidence-based group IDs, and shared grouping used by the customer shelf. Exact media and authoritative image families can group; HLS and DASH remain distinct media objects.
- Added current-page lifecycle handling for full navigation and SPA route changes. DOM still discovery now sends bounded chunks, clears stale page snapshots, preserves retention statistics, and discloses both shelf truncation and optionally hidden stream parts instead of silently presenting a partial result as complete.
- Connected the background-owned revisioned Capture Pack draft to the popup. Customers can explicitly include videos and stills, choose an alternate without changing item identity/order, remove items, remove the current page, rename the pack, and assign a canonical folder label per exact source page.
- Added strict `capture-plan-create`, `capture-run-enqueue`, workspace, cancel, alternate-replacement, and page-label message/client contracts. UI callers send only bounded IDs, revisions, opaque option tokens, allocation IDs, and command IDs; the background resolves media, choices, filenames, and snapshots authoritatively.
- Added bounded stream preflight with response-size and timeout limits, a total option budget, opaque plan-bound choice tokens, and typed unsupported/stale results. Direct and still sources receive bounded availability/MIME revalidation; access-header-dependent native files are blocked rather than falsely labelled ready.
- Added a complete review surface showing every ready/blocked item, quality choice, planned relative path, known/unknown size, warnings, source-tab dependency, quota effect, and an accessible Remove action. The customer can edit pack and page folder labels before submission and refresh the immutable review after any draft change.
- Added a pure buying-gate model. The complete reviewed pack remains visible; free customers explicitly choose up to the currently available ready-video count while all ready stills remain included, and licensed customers receive the complete ready allocation. Unresolved items never consume a selectable slot or leak into the submitted plan.
- Routed mixed still/direct/HLS/DASH/WebM submissions through the Slice 2 immutable executor and FIFO lanes. Capture Activity now reports background-owned progress, typed failures, exact-attempt cancellation, terminal state, and safe retry eligibility.
- Migrated each toolbar one-item download into the same immutable Capture Run path. The filename shown by the card and the frozen output path use the validated customer naming template; stream choice and entitlement are frozen before enqueue; the obsolete ten-times size-cap bypass is not offered by the new path.
- Added a session-scoped Quick Capture acceptance journal and command-only reconciliation contract. A one-item start retains its exact plan, entitlement, run, plan, draft, and item identity across service-worker restart or popup closure. Quick Capture and pack starts mutually block while either outcome is unresolved.

Independent adversarial review found release-blocking issues after the first green implementation:

- Plan journals could be partially written, superseded, or replayed against a different generated plan; terminal history was being used as an idempotency ledger; session graph loss could orphan persistent quota reservations.
- A caller-authored quality object or URL-like option ID could forge HLS/DASH selection, while the shared plan contract could not truthfully represent `needs_choice` items. Three valid manifests could also exceed the aggregate option-storage contract.
- Native/WebM readiness and post-transform totals could disagree, causing an ordinary stale source to collapse into a generic storage error. Quick Capture ignored the configured filename template and its over-cap action did not alter the immutable executor policy.
- The popup treated ambiguous/recovery-needed enqueue results as accepted, watched only legacy job ledgers, could lose its command when closed, and could clear a newer unresolved start from an older null workspace response.
- A background restart could prove Quick job ownership directly while leaving the matching persistent download-command tombstone pending.
- Current-page detection could retain a previous SPA route, truncate a large DOM batch without accounting, and hide legitimate direct files through directory-only manifest coverage.

Corrections applied:

- Added independent bounded command/run-intent journals, exact read-back after ambiguous storage writes, frozen plan digests, deterministic run/job/attempt ownership, active-plan validation, and shared acceptance locking across draft mutation, plan promotion, Quick Capture, and pack enqueue.
- Added a readiness-discriminated plan contract, opaque plan/revision/item-bound choice registry, explicit HLS-URL versus DASH-representation selectors, strict recomputed totals, bounded aggregate options, and repair-safe plan persistence.
- Added MIME-aware native verification and a shared post-transform totals function. Known WebM inputs above the conversion cap are blocked; unknown output size remains unknown; changed specific MIME types become typed stale rows; canonical plans are revalidated before journaling.
- Bound one-item planning to the validated filename template and the exact displayed basename/path. Cards now bind the returned Capture job, show shared progress/cancel/error state, and only offer a new-command retry for a typed retryable terminal attempt.
- Quick Capture reconciliation now stores and sends only the original canonical command ID, passes through `PersistentCommandGate`, proves the exact run and single item-owned job before settlement, and stays pending on any ambiguity. Boot recovery also re-enters that gate, including the crash window where the Quick journal is accepted but the command record is still pending.
- Workspace refreshes serialize with a trailing dirty rerun. An older snapshot cannot clear a newer local intent; only a fresh strict workspace result with `quickCaptureContext: null` unlocks the initiators. Activity renders unresolved Quick work before its empty state and preserves the recovery control across transient workspace errors.
- Navigation/page-context messages, bounded DOM chunks, batch retention accounting, and exact-page filtering now keep This Page truthful. Manifest coverage only suppresses high-confidence stream parts and exposes the hidden count with a Show control.

Decisions carried forward:

- C1 does not claim C2 tab-close durability. Review explicitly warns that queued streams, WebM conversion, and access-dependent sources may need their source tab until work begins. Slice 5 must add bounded selected-item header leases before that promise changes.
- Unknown size remains unknown; the buying gate never treats a partial byte sum as a total or silently bypasses the executor cap.
- Reliability, cancellation, reconciliation, and visibility are not licensed features. The buying moment is the already-reviewed complete pack versus the number of videos that fit the free allowance.
- One-item and pack runs share one Activity and executor, but the product remains Capture Pack rather than expanding into a generic Download Center.

Verification after corrections:

- `npm run test:run`: 52 test files and 732 tests passed.
- `npm run typecheck`: all six environment projects passed.
- `npm run build`: Vite production build passed.
- `npm run test:browser`: packaged extension loaded and Chrome smoke passed.
- `git diff --check -- extension`: clean.
- A separate frozen-tree adversarial review reran eight focused suites (90 tests), all six TypeScript projects, and the diff check and reported no confirmed Slice 3 release blocker.

#### Slice 4 - O5 shared side-panel workspace - 2026-08-15 to 2026-08-16

Implemented:

- Added the `sidePanel` permission, packaged side-panel entrypoint, Vite/audit/release registrations, direct popup launcher under a preserved user gesture, and a shared `WorkspaceShell` used by both popup and side panel.
- Added persistent This Page, Hutch, Review, and Activity routes with ARIA tab behavior, active-window/tab following, generation-guarded media loads, opt-in previews, responsive card grids, exact-page Clear actions, and a development store-capture seam.
- Kept signed media/page query values out of default labels, hover text, and accessibility text. Full URLs remain available only through the existing explicit setting.
- Added permission/first-run/site comparison changes for the side-panel API without deploying or publishing any artifact.

Independent adversarial review found release-blocking issues after the first green build:

- Popup and side panel could submit semantically identical Quick or Pack work under different command IDs.
- Default-redacted cards still leaked complete signed URLs through `title` attributes, and a delayed tab-A statistics read could overwrite tab B.
- DNR replay rules included the `media` resource type, so an opt-in preview could inherit captured Authorization or `X-*` headers from an active download.
- The four-route tablist overflowed at a 200 px CSS viewport, representative of 200% zoom in a narrow panel.
- Keyboard removal of a Hutch row left focus on `<body>`.
- The first Quick ownership comparator included volatile observation metadata, so a refreshed title/time/size/provenance could evade duplicate-start coalescing.

Corrections applied:

- Quick starts now compare a canonical execution identity (stable media ID, exact URL/kind/resource class, executable quality selector/policy, path, and lease context) while ignoring display/observation metadata. Pack starts reject an already-active execution of the reviewed plan; both decisions run under the shared acceptance lock.
- URL titles use the same customer-safe sanitizer as visible source text. Active-tab media/stat reads require the exact generation and tab ID before committing UI state.
- Replay rules now apply only to extension fetch/worker request types (`xmlhttprequest` and `other`), never preview `media` requests.
- The route tablist collapses responsively without horizontal page overflow at 160 px or 200 px. Hutch removal chooses the next row, then previous row, then a programmatically focusable Hutch heading after authoritative state commits.
- Added regression tests for volatile Quick metadata and source/resource/selector/path/lease mismatches, plus pure focus-order and narrow-layout tests.

Verification after corrections:

- Frozen O5 checkpoint: 54 test files and 777 tests passed; all six TypeScript environment projects passed.
- Independent focused re-review: 86 tests passed with no confirmed O5 implementation release blocker.
- Vite production and development builds passed; the development artifact passed all 38 distribution-audit checks.
- Real Chrome loaded the packaged extension, opened the side panel from a direct click, followed tabs, showed no horizontal overflow at 160/200 px, and restored focus after row removal.
- C2 retains the explicit release gate to disclose selected Hutch snapshots and 60-minute selected-header leases before shipment. No deployment or publication occurred.

#### Slice 5 - C2 cross-tab Hutch and bounded header leases - 2026-08-16

Implemented:

- Added a background-only, session-scoped header-lease registry. Add freezes only the approved replay headers for the exact draft/item/media/tab/page/source URL and replay kind; direct rules match one exact URL and stream rules match one exact scheme, host, and directory prefix.
- Bounded each lease to 60 minutes, 32 headers, 32 KiB, the existing approved header allowlist, 200 records, and a 4 MiB registry. Lease list APIs expose metadata only; header names and values never enter UI, local storage, diagnostics, or manifests.
- Draft Add/alternate replacement creates a lease before committing the item, stores only its opaque ID in the immutable snapshot, and compensates a definitely uncommitted mutation. Remove, remove-page, and Clear Hutch release draft ownership without deleting authorization still owned by an accepted attempt.
- Review preflight and enqueue resolve exact lease bindings. Plan options, immutable run intents, execution digests, job snapshots, and coordinator replay all freeze the authoritative per-item lease map; a changed or injected map is rejected before quota or job creation.
- Heavy execution claims the exact attempt owner, installs a job-scoped DNR rule, passes the fixed expiry to offscreen, removes authorization before Chrome save begins, and retires the lease only after exact rule cleanup. A Capture job with no frozen lease never re-reads mutable ordinary tab headers.
- Added one-shot `chrome.alarms` wakes for the earliest lease expiry and a durable aggregate cleanup retry. Expired DNR rules are removed before raw header records are swept. The manifest, audit, first-run, privacy, permissions, hosted policy, Store paste, and contributor guidance now describe seven API permissions and the selected-item retention contract.
- Clear Hutch now removes unreferenced review plans/options while preserving plans still required by queued/running runs or unresolved intents. Workspace reads use the exact active-plan ID, so a protected historical plan cannot reappear as an active Review.

Independent adversarial review found release-blocking lifecycle and privacy races after the initial C2 tests passed:

- Tab cleanup could delete ordinary headers before a queued job copied them; conversely, a Capture job without a frozen lease could later inject newly observed, unreviewed credentials.
- DNR owner persistence and Chrome rule installation/removal were separate side effects. Concurrent alarm, cancel, or start work could produce a rule without an owner or remove authorization from a legitimate Review/start.
- A failed cleanup could still release the heavy lane, and bounded in-worker retries could expire while an offscreen Blob, DNR rule, lease, or long Review remained active.
- Boot recovery did not always advance `cancelling` jobs, verify exact offscreen acknowledgements, retry failed recovery actions, or distinguish a stale attempt generation from the current job.
- Blob-ready could persist `delivery_pending`, then race cancellation/recovery and still call `downloads.download`, producing a file after the UI reported cancellation.
- Opportunistic lease expiry during Add/Remove could delete the lease record before removing a still-header-bearing DNR rule. Partial cleanup paths could also clear the one global retry even while another cleanup domain was unresolved.

Corrections applied:

- Header lease and DNR operations use exact owner/binding checks, batch claim/release, source-origin/path scoping, and per-rule operation serialization. Review rules are retained only while their exact in-memory Review key is active; attempt rules are removed from durable job state, not from a possibly stale offscreen-status sample.
- Recovery is run at module boot and before every queue claim. It replans guarded actions, advances cancellation to terminal state, verifies exact job/attempt control acknowledgements, cleans stale generations, polls Chrome download state, and arms a durable retry whenever any read, transition, revoke, DNR removal, lease sweep, or plan cleanup is incomplete.
- Lease creation consumes any opportunistically swept IDs by synchronously removing their DNR owners before Add can succeed. Expired accepted leases remain until DNR-aware attempt cleanup retires them; draft mutation cleanup failures autonomously arm reconciliation.
- Review, start, cancel, recovery, Chrome terminal events, Blob delivery, and offscreen errors now share one background side-effect lane. The critical `delivery-ready -> authorization cleanup -> downloads.download -> saving` window is indivisible relative to cancellation/recovery, so either cancellation wins before the save or it observes an owned Chrome download afterward.
- Only the aggregate drain can clear cleanup-retry state after proving authorization, offscreen, review-plan, and lease state are all clean. Alarms and partial paths may arm work but cannot falsely declare the system clean.
- Public copy distinguishes ordinary tab headers (cleared on navigation/close) from explicitly selected Hutch leases (session-only, at most 60 minutes, and removed earlier on Clear/terminal cleanup). No deployment or publication occurred.

Verification after corrections:

- `npm run typecheck`: all six TypeScript environment projects passed.
- `npm test -- --run`: 58 test files and 815 tests passed.
- Independent frozen C2 pass: eight focused files and 93 tests, background/offscreen/test TypeScript projects, and diff check passed with no remaining confirmed C2 blocker.
- `npm run build:development`: Vite build passed and the distribution audit reported 47 passes and zero failures.
- `npm run test:browser`: Chrome loaded the packaged extension and its registered pages/service worker.
- Final release hardening still includes a controlled Chrome-fake plus real-Chrome service-worker eviction test at `delivery_pending -> downloads.download -> saving`; this is retained as an explicit platform proof rather than claimed by the pure suites.

#### Slice 6 - C5 terminal source manifest - 2026-08-16

Implemented:

- Added a required, redacted JSON source manifest for every normal Capture Pack and a revisioned, customer-selected CSV companion. Quick Capture deliberately creates neither output.
- Froze a bounded manifest specification and redacted seed into the accepted run graph. The seed includes every reviewed row and its included/excluded outcome, safe relative paths, normalized page provenance, dimensions, and timestamps, but never media URLs, URL queries/fragments, headers, Blob URLs, license/install data, quota/command identifiers, raw errors, or absolute filenames.
- Added a strict per-run manifest delivery record with independent JSON/CSV `pending`, `saving`, `complete`, and typed `failed` states. Stored media-run status remains media-only; Activity derives `finalizing` or `partial` without reopening a terminal run or its enqueue command.
- Finalization waits until every media job is terminal, then performs one guarded, one-way enrichment of known Chrome download basenames and byte sizes before setting `finalizedAt`. JSON and CSV are serialized from that same immutable normalized record, so Chrome `uniquify` results cannot differ between formats or later retries.
- Added deterministic JSON and RFC-compatible CSV serializers, formula neutralization, bounded public error categories, truthful cancelled and save-state-unknown outcomes, Unicode/quote/newline fixtures, and a default provenance policy that removes credentials, queries, and fragments.
- Added an offscreen-owned, attempt-scoped text-Blob protocol with SHA-256 content binding, a 1 MiB UTF-8 ceiling, eight active entries, bounded tombstones, one-hour orphan expiry, exact create/status/revoke acknowledgements, and no use of the media heavy lane or video quota.
- Added terminal manifest delivery and recovery through the Downloads API. CSV is attempted before required JSON when selected; accepted saves are polled through the durable drain/alarm path; explicit retry uses a new canonical attempt while every prior attempt identity remains retired and bound to its original format/run.
- Added a pure manifest recovery planner for pending starts, saving-download observation, terminal mutation before Blob revoke, orphan cleanup, and boot recovery. Terminal runs with unfinished manifest output remain protected from history compaction.
- Added Review disclosure and CSV preference, privacy-safe workspace summaries, Activity `Waiting`/`Saving`/`Saved`/typed failure states, and outcome-unknown-safe **Export again** reconciliation. The UI never receives the manifest seed, raw paths, URLs, errors, or Blob identifiers.
- Added a pre-acceptance combined plan/job/manifest capacity assessment so any pack that cannot fit the bounded execution graph is blocked during Review instead of failing only after Save.
- Updated first-run, permissions, privacy, hosted policy, Store paste, release assertions, and distribution audit copy for terminal local JSON/CSV creation and bounded offscreen Blob handling. No deployment or publication occurred.

Independent adversarial review found release-blocking truth, identity, retention, and recovery defects after the initial C5 suites passed:

- An immediately completed native download could omit Chrome's collision-adjusted basename, and later per-format filename lookup could let CSV and JSON serialize different outcomes.
- A manifest `save_state_unknown` was initially described as a definite save failure, while an ordinary cancelled job could receive a generic unknown-error message.
- Planner, seed, and combined graph byte ceilings were incompatible; a valid 120- or 200-item review could fail only at enqueue. Truncating a maximum-length host plus port could also silently invent a different source host.
- Explicit retries did not always arm a durable observation wake, and the retry command was only bound to the current attempt. A stale surface could reuse an older command after a later attempt replaced it.
- A worker death after Blob creation but before durable `begin` could let recovery tombstone the new attempt and then permanently disable a safe fresh retry.
- Manifest reconciliation scanned all retained runs once per terminal run under the shared side-effect lock, producing quadratic reads and delaying new media work.
- The aggregate drain scheduler could drop a recovery request in the microtask window after its loop observed no work but before its promise cleanup ran.
- A media-terminal run with a pending/saving manifest could be compacted, and explicit retry could race run pruning unless it shared the acceptance/side-effect lock order.

Corrections applied:

- Native completion observations now carry basename and size. Before the sole `finalizedAt` transition, complete jobs accept only missing terminal metadata through a revision-guarded one-way enrichment; later Chrome observations cannot overwrite frozen truth, and both serializers/retries use only that stored graph.
- Manifest item status and public errors distinguish cancellation, definite failure, and save-state ambiguity. Maximum host-plus-port provenance is omitted when it cannot be represented without alteration.
- A shared capacity assessment models the complete initial graph, including required manifest seed, before Review succeeds. Runtime guards retain independent fail-closed byte/item caps.
- Each output keeps a bounded append-only attempt history, with uniqueness across JSON and CSV. Exact command identity is derived from run/format, old attempts remain retired, and `ATTEMPT_RETIRED` before external delivery leaves a new customer command retryable without replaying the retired attempt.
- Accepted unresolved Chrome saves schedule durable reconciliation. Manifest recovery is one bounded global pass per drain/finalization epoch, skips unnecessary active/terminal reads, and coalesces concurrent requests.
- Pending/saving outputs protect their terminal media run and manifest record from pruning. Explicit retry takes the same draft-acceptance then attempt-side-effect lock order as recovery and compaction.
- Replaced the lossy Boolean drain flag with a generation-bound trailing-task scheduler. Every caller's completion promise is tied to its requested generation, requests during active work coalesce into a trailing pass, and requests made during promise settlement cannot be dropped.
- Required JSON remains the completion gate even if optional CSV fails. A successful later retry restores the derived customer status without mutating the immutable media-run terminal state.

Verification after corrections:

- Independent frozen runtime review: 15 focused files and 153 tests passed with no remaining confirmed C5 release blocker.
- `npm test -- --run`: 68 test files and 906 tests passed.
- `npm run typecheck`: all six TypeScript environment projects passed.
- `npm run build:development`: Vite built 204 modules; the distribution audit reported 51 passes and zero failures.
- `npm run test:release`: eight release-foundation checks passed; `git diff --check` was clean.
- Fresh Chrome 151 end-to-end smoke selected a still, reviewed required JSON plus optional CSV, forced a real filename collision, and verified the same `asset (1).svg` basename in the terminal job and both outputs. Secret query/fragment canaries were absent, Activity traversed Waiting/Saving/Saved, the offscreen Blob registry ended empty, and a later Quick Capture created no manifest.
- The existing packaged-extension browser smoke also passed. The final browser matrix still retains explicit Chrome-minimum-version, service-worker-eviction, delayed-alarm, cleared-history, and failed/save-state-unknown probes as coverage gates rather than treating unit recovery fixtures as platform proof.

#### Slice 7 - C7 automatic quality and C6 high-confidence Best Copy - 2026-08-16

Implemented:

- Added one bounded offscreen HLS/DASH inspection protocol with three concurrent Review workers, per-request deadlines, response-byte and review budgets, and at most 100 variants per stream and 200 public options per plan. Native fetch is invoked without an illegal Window receiver.
- Normalized rendition facts into redacted, strictly guarded options. HLS aggregate bandwidth and DASH video plus selected default-audio bandwidth are distinguished; duration, estimated bytes, container, codecs, dimensions, and confidence remain explicit, and missing evidence stays unknown.
- Added the customer-configurable **Best under cap** policy with an exact 10% safety margin, optional maximum height, deterministic ranking, and no bypass surface. Automatic selection occurs only at or below 90% of the frozen cap; the full configured cap remains the hard execution limit. Unknown or contradictory options require Review.
- Replaced persisted HLS child URLs and DASH representation locators in normal packs with opaque selectors plus the frozen policy, reviewed display facts, and hard cap. Quick Capture retains its explicitly guarded legacy compatibility path.
- Added one-use execution snapshots retained by the offscreen inspector. Execution consumes the exact inspected HLS master/child/default-audio or DASH MPD representation set, authorizes only manifest-derived init/segment URLs, and never refetches a changed root manifest before the downloader runs.
- Added exact manual revalidation of dimensions, codecs, bandwidth, duration, estimate, confidence, and default-audio structure. Automatic execution recomputes only within the frozen disclosed policy. Signed HLS query rotation can succeed when structural identity is unchanged; reused DASH IDs or same-path metadata drift require a new Review.
- Added truthful Review copy for exact, estimated, and unknown sizes. A confirmation-required result may mark one supported smallest suggestion without selecting it; hard-cap-ineligible options are never suggested.
- Added conservative Best Copy recommendation inside only exact-media or page-authored responsive-image families. HLS/DASH rendition selection remains visibly separate under C7, and unsupported or merely similar media never becomes an automatic recommendation.
- Froze the selected copy and evidence in the background-owned draft and immutable review plan. Add/replace resolves one authoritative shelf snapshot; the UI cannot supply alternate URLs or forge confidence/reasons.
- Added popup and side-panel Best Copy presentation, explicit override, unavailable-state recovery, Review evidence, and recommendation-specific ARIA. Draft authority wins over local or live metadata; an accepted or outcome-unknown Quick interaction keeps its original selection across surface remounts.

Independent adversarial review found release-blocking correctness and truth gaps after the first C7/C6 suites passed:

- HLS codec/container facts initially allowed unsupported TS and raw-AAC paths to look executable, while permanent worker errors and stale variants could be stored as retryable.
- HLS could silently fall back from an exact reviewed child to a changed root media playlist, and two master entries sharing a video URL could execute the wrong default audio.
- Review and the downloader fetched the root manifest independently. A same-locator/representation mutation between those reads could violate manual metadata or automatic height/cap policy.
- Persistent C7 quality choices passed the plan guard but were rejected by the storage-safe guard, so a real Chrome Review produced `plan_storage_unavailable`.
- Reused DASH representation IDs and same-path HLS duration changes were not part of manual stale identity.
- Retained execution handles were not discarded on every pre-start rejection. Eight stale items could fill the offscreen registry and cause a valid ninth item to fail.
- Review rendered exact and estimated bytes identically, discarded the policy's smallest confirmation suggestion, could suggest an option above the immutable hard cap, and said “below 90%” despite accepting the exact boundary.
- Early Best Copy UI could silently follow a changing recommendation or imply network reachability, while an evicted selected copy lacked a truthful unavailable state.

Corrections applied:

- HLS inspection now classifies declared incompatible codecs and defensible raw-container cases against the actual downloader path. Exact HLS video/default-audio tuples and DASH selectors fail closed on ambiguity, drift, or membership loss, and typed permanent errors require Review instead of blind retry.
- The offscreen execution snapshot is the network authority for the downloader. A strict opaque discard protocol reclaims count and byte capacity on normalization, policy, binding, authorization, concurrency, tombstone, cancellation, rejected-start, and missing-ACK exits; successful start ACK transfers ownership exactly once.
- Storage accepts the new persistent stream contract only for normal packs with matching media/selector kind and rejects legacy raw locators there. Legacy locators remain narrowly accepted only for the one-item compatibility plan.
- Manual quality fact comparison closes reused-ID and duration/estimate drift without binding selectors to signed queries. Automatic mode reselects only from the exact retained snapshot under its frozen cap and height.
- Confirmation suggestions are derived only from publicly/manual-executable entries. Exactly one supported option may be marked, no option is preselected, and copy identifies whether “smallest” is scoped to the automatic height limit.
- Exact/estimated/unknown UI text now comes from explicit confidence rather than inferring from bytes. Contradictory facts fail to unknown.
- Best Copy uses a strict background re-proof and freezes only the selected media ID, bounded evidence, and confidence. Live recommendation changes cannot replace a customer override, accepted Quick choice, or missing authoritative draft member.

Verification after corrections:

- Independent frozen C7 review: 14 focused files and 235 tests passed with no remaining confirmed blocker.
- Full extension suite: 78 test files and 1,096 tests passed.
- All six TypeScript environment projects passed; production build and `git diff --check` passed.
- Real Chrome 151 controlled A/B smoke fetched the HLS master once and consumed only master A, child A, and init A; DASH fetched the MPD once and consumed only MPD A and the selected v1 init. Neither path refetched the changed B manifest.
- C6 focused backend/UI gates covered 151 tests across authoritative freezing, ranking, Quick ownership, missing selection, accessibility presentation, and hostile inputs. The installed-extension popup/side-panel smoke passed.

#### Slice 8 - integrated release-candidate hardening - 2026-08-16

Implemented and reviewed:

- Updated the public site, checked-in Store paste, design brief, first-run page, privacy/permissions disclosures, and contributor guidance to match the implemented Capture Pack, seven permissions, bounded session/header data, terminal manifests, and license-refresh behavior. No site or extension deployment occurred.
- Reworked Store-asset capture to use the real built popup and global side panel. The controlled page now adds three fictional videos plus one still through the real **Select visible** flow, then captures the populated four-item Hutch at its actual 420 px panel viewport. The promo tile now states the specific organized-media-pack outcome.
- Regenerated the 1280 x 800 screenshot and 440 x 280 promo tile from the current product surfaces and inspected both at full resolution for clipping, stale state, and claim mismatch.
- Re-ran the independent C7 frozen review after every metadata-drift, execution-handle, size-confidence, hard-cap, and suggestion correction. No remaining C7 release blocker was confirmed.

Automated development-candidate verification:

- `npm run verify:development` passed all six TypeScript projects, media-fixture integrity, eight release-foundation checks, all 1,096 tests with V8 coverage, both production and development dependency audits with zero vulnerabilities, a 215-module production build, and the 51-check distribution audit with zero failures.
- Coverage was 85.64% statements, 82.30% branches, 95.74% functions, and 90.19% lines across the tested libraries/workers.
- `npm run test:browser` loaded ClipHutch 0.1.4 from the final development artifact with popup, side panel, options, offscreen, background, and content-script registrations intact.
- Store capture itself loaded the current built extension in Chrome, exercised mixed-media selection through the real UI, opened the side panel, and produced the inspected assets.
- Repository and site `git diff --check` passed; public copy no longer contains the rejected stale refresh cadence or “below 90%” boundary mismatch.

Release-only gates intentionally remain outside this checkpointed candidate:

- `verify:source`, `package`, and `verify:package` require a clean, approved, version-tagged source commit. They remain blocked until the backend and manual release gates are cleared; this candidate is not being relabeled as distributable.
- The approval matrix still requires Chrome 116 plus current stable, deliberate MV3 eviction at the external Downloads boundary, delayed-alarm and cleared-history cases, VoiceOver/NVDA passes, and the five-person paid-value task. Existing controlled Chrome 151, unit, fake-API, and component evidence is not relabeled as those manual proofs.
- Hosted site/privacy copy, Store assets, Store listing, and extension package remain local and unpublished until explicit release approval.

## 1. Executive decision

Proceed, but build these features as one product named **Capture Pack**, not as eight unrelated additions and not as a generic Download Center.

The customer promise is:

> Select useful videos and stills from one or more pages, review exactly what ClipHutch will save, then receive an organized local pack with sensible copy and quality choices plus a source manifest.

This is a stronger buying reason than a larger progress/history screen. The queue, immutable snapshots, cancellation, and recovery in this plan are supporting infrastructure. They should appear as a compact Activity area, not become the flagship feature.

The recommended release order is:

1. Build the pack contracts and minimum mixed-media executor.
2. Prove C1, C3, and C4 with a current-page pack.
3. Introduce the O5 side-panel shell.
4. Add C2 cross-tab collection.
5. Add C5 manifests.
6. Add C7 automatic quality.
7. Add the deliberately narrow, high-confidence version of C6 Best Copy.
8. Run the full browser, accessibility, privacy, and exact-package release gate.

The important adversarial adjustment is that O5 now precedes C2. A cross-tab collection is technically possible in session storage without a side panel, but it is not a good product flow inside a popup that disappears when the customer switches tabs.

Estimated total: **35 to 58 senior engineer-days**, or roughly **8 to 12 calendar weeks for one engineer** including hardening. The first customer-testable current-page vertical slice is about **14 to 22 engineer-days**. Stop after that slice if the collection workflow does not create credible preference and $35 buying intent.

## 2. Selected features and their roles

| ID | Feature | Customer outcome | Role in the product |
| --- | --- | --- | --- |
| C1 | Current-page Capture Pack | Select videos and stills together and save them as one explicit batch. | Core value |
| C2 | Cross-tab Hutch | Collect from several tabs/pages during one browsing session. | Main differentiation |
| C3 | Capture Pack review | See every file, choice, warning, path, estimate, and quota effect before saving. | Trust and buying gate |
| C4 | Organized folders | Save under a predictable `ClipHutch/<pack>/<page>/` hierarchy. | Time-saving outcome |
| C5 | Source manifest | Save local JSON and optional CSV provenance for the pack. | Research/archive value |
| C6 | Best Copy | Recommend a copy only when relationship evidence is strong and explain why. | Refinement; ship late |
| C7 | Automatic batch quality | Choose the best supported HLS/DASH quality under the configured cap. | Batch automation |
| O5 | Side-panel workspace | Keep This Page, Hutch, Review, and Activity visible while browsing. | Enables the C2 experience |

## 3. What the pre-implementation code did

The roadmap started from these confirmed baseline facts. The execution log above records how the candidate changed them.

| Area | Current behavior | Consequence for this build |
| --- | --- | --- |
| Media model | `DetectedVideo` contains URL, kind, page context, bytes, and content headers, but no dimensions, duration, bitrate, codecs, provenance, or family identity (`extension/src/types.ts:4-14`). | C6 and C7 need a small metadata/provenance expansion before they can make defensible decisions. |
| Current shelf | The popup loads one active tab at mount (`extension/src/popup/popup.tsx:1530-1549`) and subscribes only to `tab:<tabId>` (`:1593-1606`). | C2 needs a separate session Hutch and O5 needs active-tab tracking. |
| Selection | `selectedByGroup` selects an alternate inside a group, but all groups in the currently visible Videos or Stills shelf become the bulk selection (`popup.tsx:1521`, `:1632-1647`). | C1 needs explicit include/exclude state that persists across both shelves. |
| Grouping | Grouping is private inside the popup and uses kind, page/source directory, and inferred filename; HLS/DASH are forced into unique groups (`popup.tsx:146-188`). | Extract grouping into a tested library. Do not treat existing groups as proven duplicates. |
| Bulk | Bulk operates on only the active Videos or Stills shelf and explicitly skips HLS, DASH, and WebM (`popup.tsx:1639-1647`, `:1718-1726`; `extension/src/lib/download-intent.ts:135-174`). | C1 needs a mixed-media planner and a sequential heavy queue. |
| Jobs | Direct, HLS, DASH, and WebM use four different session ledgers (`extension/src/types.ts:19-111`; `extension/src/background.ts:367-380`, `:911-949`, `:1291-1308`). | Introduce one Capture Run model without building a full persistent Download Center. |
| Heavy concurrency | Offscreen holds one shared active-job map and rejects a second HLS/DASH/WebM job (`extension/src/offscreen/offscreen.ts:17`, `:118-127`, `:181-190`, `:242-251`). | Keep one background-owned FIFO heavy lane. Do not increase stream concurrency. |
| Tab cleanup | Navigation or tab closure clears the detected shelf and ordinary captured headers (`background.ts:283-292`). | C2 requires background-created immutable snapshots and separate, bounded header leases. |
| Stream delivery | HLS/DASH blob-ready handlers re-read the source tab shelf and fail with `VIDEO_MISSING` after it disappears (`background.ts:1096-1120`, `:1381-1404`). | Every submitted job must save from its immutable snapshot and planned path. |
| Variant review | The popup already lists HLS/DASH variants and shows resolution/bitrate (`popup.tsx:790-844`, `:913-993`). | Reuse the picker logic through a normalized, headless variant model. |
| Estimate quality | DASH UI estimates only video bandwidth (`popup.tsx:920-925`), while the downloader includes audio; HLS listing supplies no duration (`offscreen.ts:311-340`). | C7 must return combined audio/video estimates plus confidence. Unknown must remain unknown. |
| Detection metadata | The content script computes image dimensions (`extension/src/content-script.ts:45-80`) but its change signature uses URLs only (`:105-115`) and background discards dimensions. | Preserve dimensions/provenance and resend material metadata changes. |
| Detection cap | Each tab silently stops at 50 items, with video-over-image eviction (`extension/src/lib/storage-session.ts:30-35`; `extension/src/lib/constants.ts:14`). | Show truncation and bound the Hutch separately; never imply the shelf is exhaustive after dropping items. |
| Filenames | `inferFilename()` generates one basename, and downloads pass it directly to Chrome (`background.ts:598-603`, `:1124-1133`, `:1408-1417`). | C4 needs a separate safe relative-path builder. |
| Buying gate | Videos consume a rolling four-per-24-hour free quota; stills do not (`extension/src/lib/rate-limit.ts:1-5`). Licensed users bypass reservation in `background.ts:555-568`. Price is $35 one-time (`extension/src/lib/constants.ts:34`). | Keep the existing volume gate. Make the complete pack visible before asking for payment. |
| O5 release surface | The manifest currently has five API permissions and only a popup (`extension/manifest.json:7-13`, `:29-31`). The release audit hard-codes the five permissions (`extension/scripts/audit-dist.js:197-215`). First-run copy says ClipHutch does not request `sidePanel` (`extension/firstrun.html:243-245`). | O5 is a permission and disclosure change, not just a new React entrypoint. |

## 4. Product and scope contracts

These decisions should be written into tests and customer copy before implementation drifts.

### 4.1 Capture Pack semantics

- A Capture Pack is a logical set of independent Chrome downloads, not a ZIP and not an atomic filesystem transaction.
- Version one supports one global Hutch for the current browser session.
- The Hutch is intentionally stored in `chrome.storage.session`. It survives MV3 service-worker suspension but clears when the extension is reloaded, updated, disabled, or the browser restarts. Chrome documents a 10 MB session limit and default isolation from content scripts. [Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)
- The UI must say “Saved for this browsing session.” It must not imply browser-restart persistence.
- C1-C7 store metadata only. Media bytes remain in the existing fetch/mux pipeline and are never stored in the Hutch.
- A submitted plan is immutable. Editing selection, quality, pack name, or filenames creates a new review plan revision.
- The background service worker remains the authority. UI contexts submit tab/media IDs and policies, never arbitrary source URLs, headers, or filesystem paths.

### 4.2 What is deliberately out of scope

- ZIP generation.
- Persistent named collections across browser restart.
- A standalone Download Center or historical downloads database.
- Queue priority, drag-to-reorder, or parallel HLS/DASH/WebM processing.
- Universal cross-format deduplication.
- Audio-language, subtitle, or audio-only features.
- Large-file disk spooling or removal of the existing in-memory media limits.
- DRM circumvention, encrypted streams, unsupported live streams, or YouTube policy work.
- Remote analytics or browsing telemetry.
- Changing the $35 price or four-video rolling free allowance.

### 4.3 Buying-gate behavior

Reliability, cancellation, review accuracy, folder safety, and truthful error handling remain available to free customers. Payment buys volume, not correctness.

The gate appears only after the customer has built and reviewed the complete pack. Example:

> 12 videos and 38 stills are ready. You can save all 38 stills and 4 selected videos free today. A $35 one-time license unlocks all 12 videos.

Actions:

1. **Choose 4 videos and save the free pack**. The customer explicitly controls the four videos; no hidden “first four” rule.
2. **Unlock the complete pack**. Open checkout while preserving the session draft and review plan.
3. **Keep reviewing**.

After activation, a storage change recomputes the same plan and enables the full submission. The extension must never silently start a partial pack because the quota changed between review and execution.

For an unlicensed submission, add `reserveDownloads(packId, count)` under the existing serialized local-history lock. Acceptance is all-or-none for the reviewed allocation. A replayed submission returns the original run and does not consume quota again.

## 5. Target architecture

### 5.1 Dependency graph

```text
Versioned media metadata + pack contracts
                 |
                 +--> immutable plan + path planner --> C1 + C3 + C4
                 |                                      |
                 |                                      +--> buying-value gate
                 |
                 +--> snapshot executor + heavy FIFO --> C5 terminal manifest
                 |
                 +--> shared UI/store shell -----------> O5 side panel --> C2 Hutch
                 |
                 +--> provenance/families -------------> C6 Best Copy
                 |
                 +--> normalized variant preflight ----> C7 auto quality
```

C6 and C7 remain separate decisions:

- C6 chooses which detected media object represents the desired asset.
- C7 chooses a rendition inside an HLS/DASH object.

An unexplained global “Best” score must not combine them.

### 5.2 Proposed modules

```text
extension/src/
  lib/
    capture-pack-types.ts
    capture-pack-storage.ts
    capture-plan.ts
    capture-executor.ts
    capture-header-leases.ts
    download-path.ts
    capture-manifest.ts
    media-identity.ts
    best-copy.ts
    variant-options.ts
    quality-policy.ts
  ui/
    store/
      workspace-store.ts
      chrome-media-repository.ts
      capture-pack-repository.ts
      download-job-repository.ts
    hooks/
      use-active-tab.ts
      use-workspace-store.ts
    components/
      MediaShelf.tsx
      MediaGroupCard.tsx
      CaptureSelectionBar.tsx
      HutchView.tsx
      CaptureReview.tsx
      CaptureActivity.tsx
      UpgradeGate.tsx
    styles/
      tokens.css
      workspace.css
  popup/
    PopupApp.tsx
    main.tsx
  sidepanel/
    SidePanelApp.tsx
    main.tsx
```

Names can change during implementation, but the boundaries should not:

- Domain planning, grouping, recommendation, paths, manifests, and quality policies are pure/testable modules.
- Chrome storage and messaging are repositories/adapters.
- Popup and side panel share components and command clients.
- Background owns state transitions and side effects.
- Offscreen executes bounded heavy work and owns Blob URLs.

### 5.3 Versioned records

Create explicit runtime guards for every session record. Do not blind-cast storage.

```ts
type CaptureDraftV1 = {
  schemaVersion: 1;
  draftId: string;
  revision: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  orderedItemIds: string[];
  items: Record<string, CaptureDraftItemV1>;
  preferences: {
    folderMode: "pack_page";
    manifestFormats: Array<"json" | "csv">;
    qualityPolicy: QualityPolicyV1;
  };
};

type CaptureDraftItemV1 = {
  itemId: string;
  addedAt: number;
  sourceTabId?: number;
  media: MediaSnapshotV1;
  family?: MediaFamilyRefV1;
  headerLeaseId?: string;
};

type MediaSnapshotV1 = {
  mediaId: string;
  kind: "direct" | "hls" | "dash" | "image";
  url: string;
  detectedAt: number;
  firstSeenAt?: number;
  lastSeenAt?: number;
  pageUrl?: string;
  pageTitle?: string;
  contentType?: string;
  contentDisposition?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  bitrate?: number;
  codecs?: string;
  provenance: Array<"network" | "rendered-image" | "picture" | "metadata" | "poster">;
  familyId?: string;
};

type CaptureReviewPlanV1 = {
  schemaVersion: 1;
  planId: string;
  draftId: string;
  draftRevision: number;
  generatedAt: number;
  relativeRoot: string;
  items: CapturePlanItemV1[];
  totals: {
    included: number;
    videos: number;
    stills: number;
    estimatedBytes?: number;
    unknownSizeCount: number;
    requiredFreeVideoSlots: number;
  };
};

type CapturePlanItemV1 = {
  itemId: string;
  include: boolean;
  media: MediaSnapshotV1;
  plannedRelativePath: string;
  readiness: "ready" | "needs_choice" | "unsupported" | "stale";
  copyChoice: {
    candidateId: string;
    confidence: "exact" | "high" | "unproven";
    reason: string;
  };
  qualityChoice: QualityChoiceV1;
  warnings: Array<{ code: string; message: string }>;
};

type QualityPolicyV1 =
  | { mode: "manual" }
  | { mode: "best_under_cap"; maxEstimatedBytes: number; maxHeight?: number };

type QualityChoiceV1 =
  | { mode: "direct" }
  | {
      mode: "stream";
      policy: QualityPolicyV1;
      fixedVariantId?: string;
      label?: string;
      width?: number;
      height?: number;
      videoBandwidth?: number;
      audioBandwidth?: number;
      estimatedBytes?: number;
      estimateConfidence: "exact" | "estimated" | "unknown";
    };
```

The execution model is one logical run with independent item attempts:

```ts
type CaptureRunV1 = {
  schemaVersion: 1;
  runId: string;
  planId: string;
  commandId: string;
  createdAt: number;
  status: "queued" | "running" | "complete" | "partial" | "cancelled";
  orderedJobIds: string[];
  manifestDownloadIds?: number[];
};

type CaptureJobV1 = {
  schemaVersion: 1;
  jobId: string;
  runId: string;
  itemId: string;
  attemptId: string;
  attemptNo: number;
  revision: number;
  resourceClass: "native" | "heavy";
  state:
    | "prepared"
    | "queued"
    | "starting"
    | "running"
    | "processing"
    | "delivery_pending"
    | "saving"
    | "complete"
    | "failed"
    | "cancelling"
    | "cancelled"
    | "save_state_unknown";
  snapshot: {
    media: MediaSnapshotV1;
    plannedRelativePath: string;
    quality: QualityChoiceV1;
    headerLeaseId?: string;
  };
  progress?: {
    phase: "queued" | "fetching" | "processing" | "saving";
    completed?: number;
    total?: number;
    bytes?: number;
    ratio?: number;
  };
  quotaReservationId?: string;
  downloadId?: number;
  result?: { actualBasename?: string; sizeBytes?: number };
  error?: { code: string; customerMessage: string; retryable: boolean };
};
```

Every offscreen progress, ready, error, cancel, and cleanup message includes both `jobId` and `attemptId`. Late messages from an earlier retry may clean up their own Blob/rule, but may not mutate the current attempt.

### 5.4 Session storage keys and bounds

| Key | Contents | Bound |
| --- | --- | --- |
| `capture-draft-v1` | One active Hutch and immutable item snapshots | 200 items and a measured serialized-byte ceiling |
| `capture-header-leases-v1` | Separate `leaseId -> scoped headers` records | Only referenced leases; bounded values and expiry |
| `capture-plans-v1` | Active plan plus recent plans | Active plus latest five |
| `capture-runs-v1` | Active run controls plus terminal summaries | Never prune active; latest ten terminal runs |
| `capture-job-v1:<jobId>` | Per-job snapshot, state, and progress | Removed after terminal summary retention expires |
| `capture-batch-command-records-v1` | Pending and settled idempotency records | Never prune pending; cap settled at 200 |
| `sidepanel-intent:<windowId>` | One-shot route/open intent | Consume once; short expiry |

Use per-job keys so segment progress does not rewrite a large global history object. Keep a small control/index record for ordered IDs and pack state. Throttle/coalesce progress writes and UI announcements.

The tab shelf cap must also become visible. Replace the raw array contract with an adapter that can expose `detectedCount`, `retainedCount`, and `droppedCount`; keep backward reading while converting callers.

### 5.5 Header lease contract

C2 cannot be implemented by retaining only tab/media IDs. Ordinary header records are deleted on navigation/close (`extension/src/lib/captured-headers.ts:37-48`), and they can include Referer, Origin, User-Agent, Authorization, and `X-*` values (`extension/src/lib/header-capture.ts:5-11`, `:101-115`).

When background accepts **Add to Hutch** for a stream or WebM item:

1. Resolve the item from the authoritative tab shelf.
2. Copy only already-approved replay headers into a separate lease.
3. Bind the lease to `draftId`, `itemId`, source origin/path scope, and an expiry.
4. Store only the lease ID in ordinary pack metadata.
5. Keep general tab cleanup unchanged.
6. Delete the lease when the item is removed, its job reaches terminal state, the Hutch is cleared, or the lease expires.

Initial policy: **60-minute lease TTL**, with an explicit `Source authorization expired; reopen the page to refresh` review state. Do not renew it merely because the side panel remains open. Re-evaluate the TTL in customer testing before release.

DNR rules remain job-scoped and exist only while the executor uses the lease. They must be removed on complete, failure, cancellation, timeout, startup reconciliation, and pack removal.

Neither headers nor signed media URLs may appear in C5 output, diagnostics, local storage, or UI error strings.

### 5.6 Minimum executor, not a Download Center

All single-item and pack downloads should eventually call the same planned execution functions. A single-card download can construct a one-item plan. This avoids preserving the current divergent direct/HLS/DASH/WebM side-effect paths.

#### Pack enqueue saga

1. UI sends `{type: "capture-run-enqueue", commandId, planId, expectedDraftRevision, freeAllocation}`.
2. Background validates command syntax and looks up the plan. It never accepts UI-provided URLs, headers, or final paths.
3. Background checks plan/draft revision and verifies all included entries are `ready`.
4. Background checks license state. For free video items, it reserves the complete explicit allocation under one local-history lock.
5. Background writes immutable jobs in `prepared` state.
6. Background commits the run/index record and transitions prepared jobs to `queued`.
7. The command gate stores the accepted run response.
8. Background drains native and heavy lanes.

Recovery removes unindexed prepared jobs and releases their uncommitted reservations. A replay returns the same `runId`.

#### Native lane

- Direct videos and still images use the frozen URL and planned relative path.
- Persist `delivery_pending` before calling `chrome.downloads.download()`.
- Use a small bounded start lane, initially three, to avoid a burst of dozens of browser actions.
- Do not wait for one native file to complete before starting the next, but track every `downloadId` to terminal state.
- Retain `conflictAction: "uniquify"` and reconcile the final basename for C5.

#### Heavy lane

- HLS, DASH, and WebM share one FIFO because current offscreen execution and FFmpeg state support one heavy item.
- Atomically claim the oldest queued heavy job as `starting` before any side effect.
- Use a single-flight `ensureOffscreenDocument()`.
- Install a rule from the job's lease, then send `{jobId, attemptId, ...}`.
- Offscreen acknowledges only after it owns the exact attempt. The current immediate `ok` response before async ownership (`offscreen.ts:346-365`) is insufficient.
- On blob-ready, background must atomically claim `delivery_pending` before calling Chrome. A late ready for a cancelled/stale attempt only triggers cleanup.
- Use the job snapshot path. Never call `findVideo(tabId, videoId)` at delivery.
- Release the lane only after Chrome reaches terminal state and the Blob/rule cleanup is acknowledged.

#### Boot reconciliation

Run at background module initialization as well as startup events:

- `queued`: drain.
- `starting/running/processing`: query a new offscreen `executor-status`; reattach an exact attempt or mark it interrupted.
- `delivery_pending` without a known `downloadId`: reconcile if possible, otherwise use `save_state_unknown` and do not blindly retry.
- `saving`: query `chrome.downloads.search({id})` and apply its state.
- `cancelling`: repeat idempotent abort/cancel and cleanup.
- terminal with cleanup outstanding: retry DNR removal and Blob revoke.

The initial product does not promise recovery across a full browser restart because its session records intentionally clear. Chrome downloads already accepted by the browser may continue; the next session starts a new Hutch.

## 6. Detailed feature roadmap

### C1 - Current-page Capture Pack

#### Goal

Let the customer explicitly choose videos and stills together, add them to one pack, and submit supported direct and stream items without silent skips.

#### Implementation

1. Extract `groupMedia`, group keys, display-name inputs, and selection reducers from `popup.tsx` into testable libraries.
2. Give groups stable IDs that do not change when a different alternate becomes primary.
3. Add an explicit include checkbox to each group. Keep alternate selection separate from inclusion.
4. Persist inclusion across the Videos/Stills views. Replace `bulkSelection = activeGroups.map(...)` with the draft selection repository.
5. Add `Select visible`, `Clear page selection`, and a summary such as `12 selected: 4 videos, 8 stills`.
6. Add targeted detection support needed for a credible pack:
   - retain dimensions and provenance already computed by the content script;
   - include dimensions/provenance in the change signature so late metadata is merged;
   - collect `video[poster]`, which the observer already watches but `collectImages()` does not read;
   - expose retained/dropped discovery counts.
7. Replace immediate `downloadAll()` looping with **Review pack** and the background enqueue command.
8. Queue HLS, DASH, and WebM rather than skipping them. Items that need a choice appear as `needs_choice` before submission.
9. Keep single-item Download as a fast path, implemented through a one-item plan after the executor migration.

#### Customer acceptance

- A page with direct video, HLS, DASH, WebM, and stills can create one mixed selection.
- Switching Videos/Stills does not lose inclusion or alternate choice.
- A rapid repeated Add or Save produces one draft entry/run and one quota effect.
- Every selected item is `ready`, explicitly excluded, or shows a specific blocking reason. Nothing is silently skipped.
- The shelf states when detections were dropped because a bound was reached.

#### Primary files

- Modify `extension/src/popup/popup.tsx`.
- Modify `extension/src/content-script.ts`.
- Modify `extension/src/background.ts` and `extension/src/lib/storage-session.ts`.
- Add `extension/src/lib/media-identity.ts` and pack selection/repository modules.

#### Estimate

3 to 5 engineer-days after the pack contracts exist.

### C3 - Capture Pack review

#### Goal

Freeze a truthful plan before any download begins and put the buying gate where the customer can see the complete value.

#### Implementation

1. Add a background `capture-plan-create` command using `draftId`, `expectedRevision`, and preferences.
2. Preflight only selected entries, with bounded concurrency. Do not fetch every detected stream merely because the panel is open.
3. Classify each entry as `ready`, `needs_choice`, `unsupported`, or `stale`.
4. Show:
   - pack and page grouping;
   - chosen copy and explanation;
   - stream quality, resolution, bitrate, and estimate confidence;
   - planned Downloads-relative path;
   - item and pack size where known;
   - free-video quota requirement;
   - typed blocked/warning messages.
5. Allow removal, alternate choice, manual stream quality, pack rename, and page/folder label edits. Any edit creates a new plan revision.
6. Disable submission until every included entry is ready. Unsupported items may be explicitly excluded.
7. Reject a stale plan/draft revision and return the latest draft rather than submitting different content from what the customer reviewed.
8. Render the gate described in section 4.3 without destroying the draft or plan.

#### Customer acceptance

- Opening review starts no downloads.
- The visible pack count, quota count, planned paths, and submitted jobs agree exactly.
- A changed detection/draft cannot be submitted under an older review without a visible refresh.
- Keyboard users can reach, change, exclude, and confirm every entry.
- Returning from successful license activation reuses the same pack.

#### Primary files

- Add `extension/src/lib/capture-plan.ts` and tests.
- Add shared `CaptureReview`, `CaptureReviewItem`, and `UpgradeGate` components.
- Modify `extension/src/background.ts`, `extension/src/lib/rate-limit.ts`, and license/storage subscriptions in the UI.

#### Estimate

4 to 6 engineer-days.

### C4 - Organized folders

#### Goal

Produce a predictable local hierarchy without allowing malformed or unsafe paths.

Recommended default:

```text
ClipHutch/
  <pack-name>/
    <site-host> - <page-title>/
      <filename>
```

For a one-page pack, the UI may offer a compact `ClipHutch/<pack-name>/` layout, but the review must show the exact choice.

Chrome's Downloads API accepts a Downloads-relative filename containing subdirectories. It rejects absolute, empty, and `..` paths, so C4 needs no additional runtime permission but does need strict path construction. [Chrome Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)

#### Implementation

1. Add pure functions:
   - `sanitizePathSegment()`;
   - `buildPackRoot()`;
   - `buildPageFolder()`;
   - `buildRelativeDownloadPath()`;
   - `dedupePlannedPaths()`.
2. Keep `inferFilename()` responsible only for a basename.
3. Reject or deterministically sanitize empty segments, absolute paths, drive prefixes, `/`, `\`, `..`, controls, bidi controls, Windows reserved names, trailing dots/spaces, and excessive lengths.
4. Normalize Unicode consistently and cap both segment and total relative-path length.
5. Resolve same-pack collisions before execution with stable suffixes. Retain Chrome's `uniquify` for files that already exist on disk.
6. Persist only the planned relative path and final basename. `chrome.downloads` exposes an absolute final filename; never store or export that absolute path.
7. Use the planned relative path for native and stream blob downloads.

#### Customer acceptance

- Every requested output remains under the intended `ClipHutch/` root.
- Path traversal and cross-platform reserved-name fixtures are safe and deterministic.
- Two same-name entries receive stable distinct paths before Chrome starts.
- All direct/HLS/DASH/WebM/still paths shown in review equal the paths passed to Chrome, subject only to Chrome's external collision suffix.

#### Primary files

- Add `extension/src/lib/download-path.ts` and tests.
- Modify all `chrome.downloads.download()` calls in `extension/src/background.ts` through the planned executor.
- Extend settings only if customer testing justifies a folder-mode preference.

#### Estimate

2 to 3 engineer-days.

### O5 - Side-panel workspace

#### Goal

Provide a persistent workspace for collection while preserving the popup as the fast toolbar surface.

Target information architecture:

```text
ClipHutch                                      Settings

This Page | Hutch 12 | Review | Activity

[active route]

12 items from 4 pages                 [Review Capture Pack]
```

#### Why it lands before C2

The existing popup queries one active tab at mount and naturally closes when the customer changes tabs. A useful C2 flow requires a workspace that remains open while `This Page` follows the browser and `Hutch` does not.

Chrome's Side Panel API is available for MV3 from Chrome 114, the `open()` method is available from Chrome 116, and opening programmatically requires a user action. ClipHutch already requires Chrome 116. [Chrome Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)

#### Manifest/build implementation

1. Add `"sidePanel"` to `extension/manifest.json.permissions`.
2. Add:

   ```json
   "side_panel": { "default_path": "sidepanel.html" }
   ```

3. Keep `action.default_popup` for at least one release.
4. Add `extension/sidepanel.html` and `extension/src/sidepanel/main.tsx`.
5. Add a `sidepanel` Rollup input in `extension/vite.config.ts:69-76`.
6. Include side-panel sources in `extension/tsconfig.ui.json` and packaged-page checks.
7. Add an **Open Hutch** button to the popup. Cache the current `windowId` during the popup's existing active-tab query. In the direct click handler, initiate an optional one-shot `sidepanel-intent:<windowId>` write without awaiting it and immediately call `chrome.sidePanel.open({windowId})`, preserving Chrome's user-gesture requirement. The panel can open on its default route and consume a late intent through its storage subscription.
8. Do not use tab-specific `sidePanel.setOptions({tabId})`; it can create separate panel instances and fragment a global Hutch.
9. Do not initially call `setPanelBehavior({openPanelOnActionClick:true})`, which would replace established toolbar behavior before adoption is known.
10. Do not add `tabs`, another host permission, a CSP relaxation, or a higher minimum Chrome version.

#### Shared UI implementation

1. Extract repositories, selectors, hooks, and reusable cards before adding a second surface.
2. Use one root storage subscription, ideally through `useSyncExternalStore`; do not preserve four per-card ledger listeners and 750 ms polling per card from `popup.tsx:639-723`.
3. Track the panel's window and active tab through `tabs.onActivated` and relevant `tabs.onUpdated` events.
4. `This Page` resubscribes when the active tab changes. `Hutch` renders only pack snapshots and never clears with the page shelf.
5. Render collapsed media rows. Current cards attach direct video URLs with `preload="metadata"` (`popup.tsx:321-350`); a persistent panel must load a remote preview only after an explicit Preview action or visible expansion.
6. Support 320 to at least 720 CSS pixels. Use one column at narrow widths and an optional media/details split when space allows.
7. Keep compact Activity inside the workspace; do not create a separate Download Center route/product.

#### Accessibility

- Replace click-only ARIA tabs with roving `tabIndex`, Arrow Left/Right, Home/End, and focus movement. The current `ShelfTab` is click-driven (`popup.tsx:501-539`).
- Use labelled checkboxes containing filename and media kind.
- Restore focus after item removal and review/error dismissal.
- Use one throttled live-region summary, not one announcement per progress event.
- Support 200% zoom without horizontal page scrolling.
- Respect reduced motion and work with either left- or right-positioned Chrome side panels.

#### Customer acceptance

- A direct popup click opens the global panel in Chrome 116 and current stable.
- Switching among three tabs changes This Page without changing Hutch.
- Popup and panel concurrently show the same pack/review/job counts.
- Merely leaving the panel open creates no preview or manifest-fetch storm.
- Narrow, wide, keyboard-only, 200% zoom, VoiceOver, and NVDA flows remain usable.

#### Release/disclosure gate

Adding O5 increases the API permission count from five to six and invalidates current comparison copy. In the same release:

- update `extension/scripts/audit-dist.js:197-215`;
- extend `extension/scripts/browser-smoke.mjs` to load and open the panel;
- update `extension/firstrun.html:106` and `:243-245`;
- update `PERMISSIONS.md` and `PRIVACY.md`;
- update the hosted privacy/permission copy in `cliphutch-site`;
- update Chrome Web Store permission declarations, listing copy, and screenshots.

O5 does not ship while any exact-package audit or public surface still claims five permissions or says ClipHutch does not request `sidePanel`.

#### Estimate

5 to 8 incremental engineer-days after shared contracts/components exist.

### C2 - Cross-tab Hutch

#### Goal

Collect media from several tabs/pages into one browser-session pack, including after a source tab is closed or navigated.

#### Implementation

1. Add background-owned commands:

   ```text
   capture-draft-get
   capture-draft-add
   capture-draft-remove
   capture-draft-remove-page
   capture-draft-clear
   capture-draft-rename
   ```

2. Every mutation includes `expectedRevision`. A stale mutation returns the latest draft instead of overwriting another panel/window.
3. On Add, background resolves each `tabId + mediaId`, creates the bounded immutable snapshot, and creates any needed header lease. The panel cannot invent the URL/header/path.
4. Dedupe an exact page/media addition idempotently, while allowing genuinely distinct pages/assets.
5. Group Hutch entries by originating page with page title, sanitized host, count, and remove-page action.
6. Keep entries when ordinary `clearTab()` and `clearCapturedHeadersForTab()` run.
7. At review, classify expired signed URLs/leases as stale. Do not silently fetch a changed source.
8. `Clear Hutch` removes draft items, unneeded plans, and all unconsumed leases. Active runs require a separate cancel-confirm action.
9. Show the session-only lifetime in empty/onboarding states.

#### Customer acceptance

- Add selected media from three tabs, then navigate or close all three.
- The panel still shows the exact snapshots, source grouping, and selected alternatives.
- Items with a valid lease can be submitted without `VIDEO_MISSING`.
- Expired authorization is a visible refresh requirement, not a generic download failure.
- Two Chrome windows adding concurrently do not lose or duplicate entries.
- Clearing the Hutch leaves no header lease or unreferenced plan behind.

#### Privacy gate

Current privacy copy says captured headers clear on navigation/close. C2 creates a narrowly different retention rule for media the customer explicitly adds to the Hutch. Before release, disclose:

- what selected media/page metadata is kept in session;
- that selected job-scoped headers may survive source-tab closure;
- the 60-minute expiry and earlier removal conditions;
- that they remain memory-only and never enter the manifest;
- how Clear Hutch removes them.

#### Primary files

- Add `extension/src/lib/capture-pack-storage.ts` and `capture-header-leases.ts` with tests.
- Modify `extension/src/background.ts`, `captured-headers.ts`, and shared workspace repositories.
- Modify `PRIVACY.md`, `PERMISSIONS.md`, first-run, hosted policy, and store disclosures at release time.

#### Estimate

4 to 6 engineer-days.

### C5 - Source manifest

#### Goal

Create a local, shareable record of what the pack contains and where each item came from without exporting credentials or signed media links.

#### Canonical JSON schema

Generate `_cliphutch-manifest.json` only after all media jobs are terminal so Chrome collision suffixes and failures can be represented truthfully.

```json
{
  "schemaVersion": 1,
  "generator": { "name": "ClipHutch", "version": "0.1.x" },
  "pack": {
    "name": "Campaign Research",
    "createdAt": "2026-08-15T00:00:00.000Z",
    "completedAt": "2026-08-15T00:03:20.000Z",
    "status": "partial"
  },
  "items": [
    {
      "plannedPath": "ClipHutch/Campaign Research/example.com - Product/image-01.jpg",
      "actualBasename": "image-01 (1).jpg",
      "kind": "image",
      "pageUrl": "https://example.com/product",
      "sourceHost": "cdn.example.com",
      "width": 1600,
      "height": 900,
      "capturedAt": "2026-08-15T00:00:10.000Z",
      "status": "complete"
    }
  ]
}
```

#### Implementation

1. Build one normalized manifest record model and deterministic serializer.
2. Default URL policy strips userinfo, query, and fragment. Export source host rather than the media URL.
3. Never export media URLs, signed query strings, headers, Blob URLs, license/install data, quota/command IDs, absolute filesystem paths, or unbounded raw errors.
4. Convert typed internal errors into bounded public categories and messages.
5. After all jobs are terminal, query known Chrome download IDs for final basenames. Do not persist the absolute `DownloadItem.filename`.
6. Ask offscreen to create a bounded text Blob, since offscreen already owns Blob URL lifecycle. Download it as the final pack item and revoke after Chrome reaches terminal state.
7. If manifest save fails, mark the pack `partial` and retain an **Export manifest again** action for the current session.
8. JSON is required. CSV is a second serializer over the same normalized records, with RFC-compatible quoting/newline tests. It may ship in the following point release if the product gate does not show demand, but it remains part of C5's completion plan.

#### Customer acceptance

- Completed, failed, cancelled, and explicitly quota-excluded entries are represented accurately.
- External filename collisions are reflected without exposing an absolute path.
- JSON and CSV fixtures round-trip Unicode, quotes, commas, and newlines.
- Secret canaries in headers, URL queries, media URLs, license state, and absolute paths never appear in either format.
- The manifest is attempted only after media entries are terminal.

#### Privacy/release gate

The customer is intentionally writing source page metadata to disk, which the current privacy policy does not describe. Update privacy, first-run, hosted copy, and store disclosures before C5 ships. Make the default redaction visible in the review.

#### Primary files

- Add `extension/src/lib/capture-manifest.ts` and tests.
- Add a bounded text-Blob message path to `extension/src/offscreen/offscreen.ts`.
- Modify run finalization and Blob cleanup in `extension/src/background.ts`.

#### Estimate

2 to 3 days for JSON, plus 1 day for CSV and escaping/browser tests.

### C7 - Automatic batch quality

#### Goal

Resolve each selected HLS/DASH item to the best supported rendition under an explicit size/resolution policy, with no silent over-cap or unsupported choice.

#### Normalized variant model

```ts
type NormalizedVariantV1 = {
  stableId: string;
  sourceId: string;
  width?: number;
  height?: number;
  codecs?: string;
  container?: string;
  videoBandwidth?: number;
  audioBandwidth?: number;
  combinedBandwidth?: number;
  durationSec?: number;
  estimatedBytes?: number;
  estimateConfidence: "exact" | "estimated" | "unknown";
  supported: boolean;
  disabledReason?: string;
};
```

#### Policy

For `best_under_cap`:

1. Exclude DRM, live, unsupported codec/container/manifest shapes, and variants with typed permanent failures.
2. Estimate combined video plus selected-default-audio bytes.
3. Apply a 10% safety margin below the customer's configured maximum.
4. Apply an optional maximum height such as 1080p or 720p.
5. Choose greatest pixel area within both constraints.
6. Break ties by combined bitrate, then stable ID.
7. If all estimates are unknown, return `needs_choice`; never classify unknown as under cap.
8. If no supported variant fits, show the smallest supported option and require explicit customer confirmation.
9. Automatic batch mode never uses the current 10x size-cap bypass (`background.ts:963-966`).

#### Implementation

1. Extract variant normalization and policy selection from popup/offscreen into pure libraries.
2. Return `supported` and a typed disabled reason for every listed option.
3. Include selected/default audio bandwidth in DASH and HLS estimates.
4. For HLS, inspect selected variant playlists during explicit Review with bounded concurrency and reuse segment-duration helpers already used by the downloader.
5. Preflight no more than three manifests concurrently and cache only for the current review plan.
6. Persist a policy plus stable selector, not a blindly trusted signed variant URL.
7. At execution, re-fetch the master/MPD and validate membership/support:
   - an automatic policy may recompute according to the exact disclosed rule;
   - an exact manual selection that is stale must return `VARIANT_STALE` and require review;
   - neither mode silently falls back outside its contract.
8. Keep C7 separate from audio-language choice. It uses the currently supported default audio behavior, but includes that audio in estimates.

#### Customer acceptance

- Automatic quality never chooses a known unsupported, DRM, live, or known-over-cap option.
- DASH estimates include the selected audio representation.
- HLS without defensible duration/size displays Unknown and requires a choice.
- A 512 MiB cap never triggers the 10x bypass automatically.
- The exact reviewed automatic policy deterministically chooses the same fixture variant at execution.
- A stale fixed choice fails visibly; an automatic choice re-resolves only within its stated constraints.

#### Primary files

- Add `extension/src/lib/variant-options.ts`, `quality-policy.ts`, and tests.
- Modify `extension/src/offscreen/offscreen.ts`, HLS/DASH parser/downloader response contracts, `background.ts`, and review UI.
- Extend `extension/src/lib/storage-local.ts` only for a customer-visible quality policy preference.

#### Estimate

4 to 7 engineer-days.

### C6 - High-confidence Best Copy

#### Goal

Recommend a likely best copy when ClipHutch has strong relationship evidence, while keeping uncertain candidates visible and customer-controlled.

This feature ships after C7 because the current schema cannot support a truthful universal Best Copy claim.

#### Relationship policy

Auto-recommend only inside these families:

1. **Exact identity**: same normalized URL and compatible kind.
2. **Authoritative responsive-image family**: candidates emitted from one `img`/`picture`/`srcset` element with a shared content-script family ID.
3. **Authoritative manifest family**: renditions described by one validated HLS master or DASH manifest. C7 chooses the rendition after C6 chooses the manifest media object.

Do not auto-collapse based only on page title, inferred filename, directory, temporal proximity, or broadly stripped query strings. Those may be shown as “Possible related copy” but remain independent.

#### Metadata/provenance work

1. Preserve image dimensions from `content-script.ts:45-52` through background and session merge.
2. Emit all relevant responsive candidates with descriptors and a shared family ID, rather than only the single current best `srcset` URL.
3. Add `video[poster]` as a poster family, not as an unexplained still.
4. Track `firstSeenAt`, `lastSeenAt`, provenance, width/height, and supported media facts.
5. Update session merging on material metadata changes rather than URL-only identity.
6. Give every family a stable ID so a new preferred primary does not reset the customer's selection.

#### Ranking policy

Within a proven family:

1. supported/downloadable beats unsupported;
2. pixel area when dimensions are known;
3. declared rendition resolution and bitrate for streams;
4. known original byte size as supporting evidence, not the only quality signal;
5. direct/original delivery as a tie-breaker over reconstruction where otherwise equal;
6. stable identity as the final tie-breaker.

Return an explanation:

```ts
{
  candidateId: "...",
  confidence: "high",
  reason: "Recommended because it is the largest responsive image: 2400 x 1600."
}
```

Review displays the recommendation, reason, and expandable alternatives. The customer may always override it.

#### Customer acceptance

- High-confidence fixture families have zero false merges.
- Low/unproven candidates are never hidden automatically.
- A selection does not reset when new metadata changes which copy is recommended.
- Each recommendation has a short evidence-based reason.
- HLS/DASH rendition choice remains visibly controlled by C7, not an opaque combined score.

#### Primary files

- Add `extension/src/lib/media-identity.ts`, `best-copy.ts`, and fixture tests.
- Modify `extension/src/content-script.ts`, `background.ts`, `types.ts`, `storage-session.ts`, and shared media cards.
- Remove private grouping/ranking logic from `popup.tsx` after feature parity is proven.

#### Estimate

4 to 7 engineer-days for the narrow version. Universal cross-format deduplication is not included.

## 7. Phased delivery plan

| Phase | Deliverable | Features | Estimate | Exit gate |
| --- | --- | --- | ---: | --- |
| 0 | Product contract and clickable review prototype | Scope/gate | 2-3 days | Five target users can explain the pack and gate before code investment. |
| 1 | Versioned pack/plan/run types, repositories, path library, command contracts, minimum executor | Foundation | 5-8 days | Reducer, idempotency, quota, snapshot, and one-heavy-lane tests pass. |
| 2 | Current-page mixed selection, review, organized save, compact activity | C1, C3, C4 | 5-8 days | Customer-value gate passes before continuing. |
| 3 | Shared UI extraction and persistent panel shell | O5 | 5-8 days | Panel follows tabs, Hutch state is independent, permission package is internally consistent. |
| 4 | Revision-safe multi-page collection and bounded header leases | C2 | 4-6 days | Three-tab close/navigate/save scenario passes. |
| 5 | Terminal JSON manifest and optional CSV | C5 | 2-4 days | Redaction and final-filename fixtures pass. |
| 6 | Normalized preflight and best-under-cap policy | C7 | 4-7 days | Supported/audio-inclusive/stale/cap fixtures pass. |
| 7 | Provenance metadata and high-confidence recommendations | C6 | 4-7 days | Zero false merge in the agreed fixture corpus. |
| 8 | Accessibility, recovery, privacy, upgrade, exact-package hardening | All | 4-7 days | All release gates in section 10 pass. |

Total: **35 to 58 engineer-days**. Some UI and test work can overlap after Phase 1, but Phase 2's product gate must not be bypassed by parallel implementation of later features.

## 8. Recommended PR sequence

Keep PRs independently reviewable and avoid mixing public permission changes into early hidden foundations.

1. **PR 1: domain contracts and pure reducers**
   - Add schemas/guards for draft, plan, run, job, quality, and messages.
   - Add revisioned pack reducer and storage adapter tests.
2. **PR 2: metadata preservation and grouping extraction**
   - Preserve dimensions/provenance; stable group IDs; poster collection; drop counts.
   - Match existing UI behavior before enabling recommendations.
3. **PR 3: planned paths and immutable executor**
   - Safe path builder; job snapshots; attempt IDs; one heavy FIFO; single-flight offscreen; blob-ready snapshot use.
4. **PR 4: batch idempotency and quota allocation**
   - Atomic explicit batch reservation; command replay; orphan/boot reconciliation.
5. **PR 5: current-page vertical slice**
   - Mixed selection, review, gate, C4 output, compact activity.
   - Run the customer product gate here.
6. **PR 6: shared UI and O5 shell**
   - Extract components/store; add panel entry and popup launcher behind a development/release flag.
7. **PR 7: C2 Hutch and header leases**
   - Cross-tab adds, revision conflicts, source grouping, expiry and cleanup.
8. **PR 8: C5 manifest**
   - JSON, terminal generation, offscreen Blob; CSV follow-up if selected for the same release.
9. **PR 9: C7 quality policy**
   - Normalized support/estimate responses and execution-time revalidation.
10. **PR 10: C6 Best Copy**
    - Authoritative families, scoring, reasons, override UI.
11. **PR 11: public release package**
    - Enable O5; update manifest/audits/privacy/first-run/site/store assets together; full browser matrix.

## 9. Test strategy

### 9.1 Unit tests

- `capture-pack-storage.test.ts`
  - add/remove/clear;
  - exact dedupe;
  - stale revision;
  - corrupt/future schema;
  - 200-item and serialized-byte bounds.
- `capture-plan.test.ts`
  - readiness classification;
  - stale draft rejection;
  - explicit free allocation;
  - deterministic totals.
- `download-path.test.ts`
  - absolute and `..` traversal;
  - slash/backslash/drive prefixes;
  - controls and bidi controls;
  - reserved names;
  - Unicode and total length;
  - deterministic collisions.
- `capture-manifest.test.ts`
  - terminal outcomes;
  - Chrome uniquify result;
  - JSON determinism;
  - CSV quoting/newlines/Unicode;
  - secret/query/header/path redaction.
- `media-identity.test.ts` and `best-copy.test.ts`
  - authoritative family fixtures;
  - false-merge corpus;
  - supported-first ranking;
  - stable group/selection behavior;
  - readable explanations.
- `quality-policy.test.ts`
  - boundary and 10% margin;
  - combined audio/video estimate;
  - unknown duration;
  - unsupported/DRM/live;
  - stale fixed vs automatic re-resolution;
  - deterministic ties.
- `capture-executor.test.ts`
  - one heavy item at a time;
  - bounded native starts;
  - duplicate enqueue;
  - attempt-scoped late messages;
  - delivery intent races;
  - terminal advancement and partial run;
  - startup reconciliation.
- `capture-header-leases.test.ts`
  - ordinary tab cleanup leaves explicit leases;
  - scope/expiry;
  - terminal/remove/clear cleanup;
  - no header values in ordinary pack records.

### 9.2 UI/accessibility tests

Add a jsdom React test configuration if one is not already available. Suggested development-only packages are `@testing-library/react`, `@testing-library/user-event`, `jest-axe` or equivalent, and `jsdom`.

Test:

- explicit video/still inclusion across shelf changes;
- select visible and clear selection;
- plan changes and stale review refresh;
- quota gate language/actions;
- popup/panel synchronized counts;
- active tab changes without Hutch mutation;
- two-surface idempotent submission;
- side-panel open failure fallback;
- keyboard-complete workspace tabs;
- focus restoration after remove/dialog;
- 320, 400, 600, and 720 px layouts;
- 200% zoom and no horizontal document scroll;
- empty, populated, review, gate, progress, partial, and error axe checks;
- throttled live-region behavior.

### 9.3 Background/offscreen integration tests

The current repository has pure worker/parser tests but lacks a complete background/offscreen/popup lifecycle harness. Add controlled Chrome API fakes for:

- pack acceptance and all-or-none quota reservation;
- popup closing immediately after submission;
- source tab navigation/closure before fetch, processing, blob-ready, and save;
- offscreen creation races and start ownership ACK;
- dropped/duplicate/reordered progress, ready, error, and terminal messages;
- service-worker eviction and boot reconciliation;
- cancellation while queued, fetching, processing boundary, and saving;
- DNR/header lease/Blob cleanup on every terminal path;
- direct `downloads.onChanged` before/after job persistence;
- manifest generated once and last.

### 9.4 Real Chrome scenarios

Run against Chrome 116 and current stable with controlled fixtures:

1. Select direct video, HLS, DASH, WebM, poster, and stills from one page.
2. Review without any download side effect.
3. Save nested paths and inspect actual Downloads output.
4. Add media from three tabs, close/navigate all sources, then save.
5. Queue several heavy items and observe no `CONCURRENT_LIMIT`.
6. Close/reopen popup while a run continues.
7. Open popup and panel together and attempt the same action.
8. Evict/restart the service worker between each durable transition.
9. Exercise signed/stale variant and header lease expiry fixtures.
10. Inspect JSON/CSV for secret canaries.
11. Position the panel left and right; test narrow/wide and 200% zoom.
12. Perform VoiceOver and NVDA keyboard passes.
13. Update from the last popup-only build and perform a clean install.

### 9.5 Performance limits

- One heavy executor.
- Native start concurrency initially three.
- Preflight concurrency initially three manifests.
- Hutch cap initially 200 items plus a serialized-byte guard.
- No automatic preview for collapsed persistent-panel rows.
- Coalesce segment progress storage updates to a measured maximum rate.
- Avoid recomputing all groups/runs for one item's progress change.
- Measure panel interaction with 200 Hutch items and ten terminal summaries.

## 10. Release gates

### 10.1 Product gate after Phase 2

Use the same three-page collection task with five target creators, researchers, archivists, or social-content operators. Compare the outcome with their existing downloader workflow.

Continue only if:

- at least 4 of 5 complete the current-page pack without help;
- at least 3 of 5 prefer the organized pack workflow;
- the pack removes meaningful manual downloading/renaming/filing work;
- at least 3 of 5 correctly explain the free allocation and $35 full-pack option;
- there is credible willingness to pay for repeated larger packs.

If this fails, improve selection/review/organization before adding broad C6 heuristics or shipping a new permission.

### 10.2 Correctness gate

- Same command means one run, one job per included item, and one quota effect.
- Accepted reviewed allocation creates every planned job; rejected allocation creates none.
- Individual failures produce a truthful `partial` result and manifest.
- Source-tab closure after snapshot cannot produce `VIDEO_MISSING`.
- Heavy jobs execute FIFO and never hit customer-facing `CONCURRENT_LIMIT`.
- Late prior-attempt messages cannot save or overwrite a current attempt.
- No blind retry occurs from `save_state_unknown`.
- Cancel remaining clears queued work and all owned quota reservations/rules/leases/blobs.

### 10.3 Privacy/security gate

- Background validates all IDs, policies, URLs, variants, and paths.
- Only HTTP(S) source and manifest-resolved URLs are accepted.
- Variant membership is revalidated before execution.
- Header leases are session-only, scoped, bounded, expiring, and removed on every required path.
- DNR rules never outlive their job ownership.
- Secret canaries do not appear in local storage, manifest output, public errors, or diagnostics.
- Content scripts cannot read session pack/job/header state.
- C5 does not contain media URLs, queries/fragments, headers, license data, or absolute paths by default.

### 10.4 Accessibility gate

- All C1-C7/O5 tasks can be completed by keyboard.
- Workspace tabs implement the full keyboard pattern.
- Focus never disappears after dynamic removal/dialog close.
- Status is understandable without color and without progress-announcement flooding.
- The side panel works at 200% zoom at narrow width.
- VoiceOver and NVDA manual passes have no critical blocker.

### 10.5 Permission/public-copy gate

O5 originally changed ClipHutch's permission story from five API permissions to six. C2 expiry/cleanup recovery added `alarms`, so the implemented Capture Pack candidate has exactly seven API permissions. Before a package is submitted:

- packaged `manifest.json` contains exactly the reviewed permissions;
- `audit-dist.js`, browser smoke, first-run, `PERMISSIONS.md`, `PRIVACY.md`, hosted copy, CWS questionnaire/listing, and screenshots agree;
- the explicit “no sidePanel” comparison row is removed or corrected;
- C2 selected-header retention and C5 local manifest writing are disclosed;
- no `tabs`, new host, or unrelated permission has been introduced.

### 10.6 Verification commands

From `extension/`:

```text
npm run typecheck
npm run test:run
npm run test:release
npm run build
npm run test:browser
npm run audit:dist
npm run package
npm run verify:package
```

Run fixture integrity checks when media fixtures change:

```text
npm run verify:fixtures
```

The extracted final archive, not only `dist/`, must load popup, side panel, options, first-run, background, content script, and offscreen without console or CSP errors.

## 11. Adversarial review adjustments incorporated

The initial concept was changed in these ways after red-team review:

1. **O5 moved before C2.** A persistent cross-tab workflow is not credible in a disappearing popup.
2. **C6 moved last and narrowed.** Current filename/directory grouping is not proof of duplicate identity. Only exact and authoritative families may drive automatic recommendations.
3. **C6 and C7 were separated.** Best media object and best rendition are different choices.
4. **The queue was reduced to infrastructure.** One heavy FIFO, bounded native starts, current run Activity, no persistent history/priorities/reordering.
5. **The background remains authoritative.** The side panel cannot send arbitrary URLs, headers, or paths.
6. **C2 gained bounded header leases.** Retaining only media IDs would fail after current tab cleanup.
7. **C5 moved to terminal finalization.** Chrome `uniquify` can change names, so a pre-download manifest would be wrong.
8. **C5 defaults to redaction.** Page/media query strings and captured headers are too sensitive for automatic disk export.
9. **C7 treats unknown as unknown.** It cannot claim an HLS/DASH option fits when duration/audio estimates are absent.
10. **O5 is a release-contract change.** It cannot silently break the existing five-permission trust comparison.
11. **A paid-value stop gate was added after C1+C3+C4.** Later engineering does not proceed merely because the architecture is interesting.

## 12. Definition of done

C1-C7 and O5 are complete only when a customer can:

1. Open ClipHutch on a page and explicitly select videos and stills together.
2. Open the Hutch workspace and continue browsing across tabs without losing the selection.
3. Review every planned file, path, copy recommendation, quality choice, estimate, warning, and free-quota effect.
4. Choose a free allocation or unlock the full pack without losing the plan.
5. Save the reviewed items into safe organized folders.
6. See compact, truthful activity with no silent skips or duplicate starts.
7. Receive a final local manifest with actual outcomes and safe provenance.
8. Understand why a copy or quality was recommended and override it.
9. Complete the workflow by keyboard and at narrow side-panel widths.
10. Trust that selected source metadata and temporary headers remain local, bounded, disclosed, and cleaned up.

The product claim should then be specific:

> ClipHutch collects the useful media from a page or browsing session, helps you choose the right copies, and saves an organized local Capture Pack.

Do not claim that ClipHutch is universally better than every video downloader. Claim and prove that it is better for the mixed-media collection workflow this roadmap implements.
