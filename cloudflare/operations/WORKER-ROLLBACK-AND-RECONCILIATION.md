# Worker rollback and reconciliation runbook

Status: **production promotion blocked** (2026-08-15).

## Recorded baseline

- Production Worker is 100% on
  `dd889c50-c33d-485e-ae3f-87223457a250`.
- Production D1 has 4 licenses: 2 active and 2 marked refunded, plus 5 active
  activation rows. No duplicate non-null payment-intent groups were found.
- Both refunded rows are unresolved because the old handler treated partial
  and full refunds alike. Do not infer that either customer was correctly
  revoked.
- Production migrations 0003 and 0004 are pending.
- D1 Time Travel accepts bookmarks within the current 30-day retention window.
  It is database-wide disaster recovery, not a row-repair mechanism.
- Separate staging D1 exists and is migrated through 0004. The staging Worker,
  test secrets, and buyer-journey smoke are not yet established.

This document intentionally contains no customer identifiers.

## Required refund disposition

For each of the two refunded rows, an authorized operator must compare the
stored payment-intent correlation with authoritative Stripe Charge state using
the Stripe dashboard or an approved credentialed tool. Record only:

- internal case/change ID;
- `confirmed-full`, `incorrect-partial`, or `unresolved`;
- evidence timestamp and operator;
- intended guarded transition;
- customer-contact owner and deadline.

Do not copy a key, email, payment-intent ID, or Stripe payload into the case.
Keep the identifier mapping only in the approved restricted operator session.

## Repair requirements

A compensating repair is allowed only when all of these are true:

1. It targets one exact current row and asserts its expected state/event before
   mutation.
2. It changes both the entitlement row and a redacted mutation-journal row in
   one D1 transaction.
3. The journal uses a change-ticket event ID and SHA-256 fingerprints, never a
   raw key, email, or installation UUID.
4. It has dry-run output containing counts and fingerprints only.
5. It is rehearsed against an exported/staging copy, followed by the full
   activation/status/deactivation test.
6. A second operator reviews the plan before production execution.

No general-purpose repair executable is checked in yet. That absence is a
release blocker; ad hoc SQL is not an acceptable substitute.

## Staging acceptance

After the staging Worker and test-only secrets exist, complete this sequence
with synthetic customers only:

1. qualified ClipHutch Checkout and one email;
2. replayed Checkout with no duplicate email;
3. activation through device limit;
4. status refresh at the device limit;
5. generation-bound deactivation and replacement activation;
6. delayed old deactivation replay;
7. partial refund leaves entitlement active;
8. full refund disables entitlement;
9. full refund before Checkout never issues a key;
10. client revalidation returns the browser to the free tier with a durable
    notice;
11. scheduled 30/90/365-day cleanup on synthetic expired rows;
12. Time Travel restore/fork rehearsal on staging or a copied database.

Record exact Worker version metadata and the staging D1 bookmark before and
after. Do not promote merely because unit tests pass.

## Rollout and rollback

The broad candidate is not the emergency A2 refund hotfix. Establish a minimal
refund-safe production version first so rollback does not restore the known
partial-refund defect.

For the broader release: migrate first, upload the version, stage it at 0%, use
the exact version-override smoke, then promote directly from 0% to 100% after
approval. Stripe webhook traffic must never be percentage-split between the
old unsafe handler and the new handler.

Rollback criteria include webhook 5xx, D1 errors, email-delivery failures,
license-validation failures, or unexpected entitlement transitions. Stop or
reroute Stripe webhook delivery before reverting to a refund-unsafe version.
Database rollback requires a separately approved D1 recovery decision; Worker
version rollback does not undo mutations.

## Refund disposition, read from Stripe on 2026-09-07

Recorded in the shape this runbook requires (no keys, emails, payment-intent IDs, or Stripe payloads; the identifier mapping stays in the operator's Stripe session).

| Case | Disposition | Evidence | Intended guarded transition | Contact owner and deadline |
| --- | --- | --- | --- | --- |
| REFUND-2026-04-27-A | `confirmed-full` | Stripe dashboard, 2026-09-07, operator: founder's Claude session | None required: the row is already `refunded`; verify no activation for it remains active | Founder; not applicable (the purchase pattern matches the founder's own end-to-end test on the day the link went live) |
| REFUND-2026-04-28-B | `confirmed-full` | Stripe dashboard, 2026-09-07, operator: founder's Claude session | None required: the row is already `refunded`; verify no activation for it remains active | Founder; not applicable (same pattern, one day later) |

Both were full reversals of the $35 purchase within eleven minutes of purchase. Because the old handler's "refunded" outcome is the correct terminal state for a full refund, no compensating row repair is required; what remains is a read-only check that no activation rows for these two licenses are still active. If any are, that becomes a guarded transition under the repair requirements above.

Related facts read the same day: the live ClipHutch Payment Link ID is now set in `wrangler.toml` for production. Stripe test mode has no ClipHutch payment link and no ClipHutch webhook endpoint; the only test-mode objects belong to Recoup Radar. The live webhook endpoint for ClipHutch is `https://cliphutch-api.mra454.workers.dev/stripe-webhook`.
