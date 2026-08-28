# ClipHutch license Worker

Cloudflare Worker for product-isolated ClipHutch and ComputedKit entitlement
issuance, email delivery, activation status, and server-confirmed device
deactivation.

## Routes

| Method | Route | Behavior |
| --- | --- | --- |
| `GET` | `/` | Health response with exact environment and Worker version metadata. |
| `POST` | `/validate` | Legacy activate-or-refresh endpoint retained for old clients. |
| `POST` | `/v2/activate` | Explicit activation; returns an activation generation. |
| `POST` | `/v2/status` | Refreshes an existing activation only; never creates one. |
| `POST` | `/v2/deactivate` | Deletes only the supplied activation generation and records an idempotent tombstone. |
| `POST` | `/computedkit/validate` and `/computedkit/v2/*` | Product-isolated ComputedKit equivalents. |
| `POST` | `/computedkit/checkout` | Creates a Stripe-hosted Checkout Session for the configured ComputedKit price. |
| `POST` | `/stripe-webhook` | Verifies Stripe signatures, issues qualified licenses, delivers email, and records partial/full refunds. |

## Environment boundaries

- The unnamed Wrangler default is `cliphutch-api-local` and uses staging D1;
  a bare command cannot target the production Worker or production database.
- `staging` uses Worker `cliphutch-api-staging` and D1
  `cliphutch-licenses-staging` (`8a3ccbca-205a-4e92-bd25-8203fa07000a`).
- `production` uses Worker `cliphutch-api` and D1
  `cliphutch-licenses` (`dc85e41b-4f1b-487d-b46e-5789e6fd0ca1`).
- Test Stripe and Resend credentials belong only in staging secrets. Never copy
  production credentials into staging.
- New ClipHutch issuance is fail-closed until the exact live/test Payment Link
  ID is configured as `CLIPHUTCH_STRIPE_PAYMENT_LINK_ID` in that environment.

Set each secret explicitly per environment:

```sh
npx wrangler secret put STRIPE_SECRET_KEY --env staging
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env staging
npx wrangler secret put RESEND_API_KEY --env staging
npx wrangler secret put RESEND_FROM_EMAIL --env staging
```

Repeat with `--env production` only under an approved production change.

## Local quality gate

```sh
npm ci
npm run check
```

`check` generates/verifies Worker types, runs TypeScript and Workers-runtime
tests, and produces a staging-bound dry-run bundle. The test suite exercises a
fresh `schema.base.sql` database through numbered migrations 0001-0004.

## Database bootstrap and migrations

New local or staging databases start from the baseline, then use Wrangler's
migration ledger:

```sh
npm run db:local:bootstrap
npm run db:staging:bootstrap
npm run db:staging:migrations:list
```

Never initialize a database from `schema.sql`; that file is only the current
schema snapshot. Never use a bare remote database command. Production exposes
only explicit migration-list/apply commands, and apply refuses to run without
an exact current version, change ticket, and confirmation:

```sh
npm run db:production:migrations:list
npm run db:production:migrations:apply -- \
  --confirm-production \
  --change-ticket=<approved-id> \
  --expected-current-version=<100-percent-version-uuid>
```

Migration 0003 and 0004 must be applied before any Worker version that queries
their columns. Production migrations remain blocked until the reconciliation
runbook is complete.

## Staging and production rollout

Deploy and test staging first:

```sh
npm run deploy:staging
npm run smoke:version -- \
  https://cliphutch-api-staging.mra454.workers.dev/ \
  staging <staging-version-uuid>
```

Production uses versions and deployments, not `wrangler deploy`:

1. Record the current 100% version and D1 reconciliation report.
2. Upload a candidate without traffic.
3. Add it to a deployment at 0% while the old version remains at 100%.
4. Send a read-only health request with Cloudflare's version-override header;
   the smoke script verifies returned version metadata and writes evidence.
5. Promote directly to 100% only after staging mutation tests, production
   read-only smoke, and explicit approval. Do not split Stripe webhook traffic
   between safe and unsafe refund handlers.

```sh
npm run versions:production:upload -- \
  --confirm-production --change-ticket=<id> \
  --expected-current-version=<old-version-uuid>

npm run versions:production:stage -- \
  --confirm-production --change-ticket=<id> \
  --expected-current-version=<old-version-uuid> \
  --candidate-version=<candidate-version-uuid>

npm run smoke:version -- \
  https://cliphutch-api.mra454.workers.dev/ \
  production <candidate-version-uuid> <evidence.json> cliphutch-api

npm run versions:production:promote -- \
  --confirm-production --change-ticket=<id> \
  --expected-current-version=<old-version-uuid> \
  --candidate-version=<candidate-version-uuid> \
  --smoke-evidence=<evidence.json>
```

The current production version
`dd889c50-c33d-485e-ae3f-87223457a250` is rollback evidence, but it is not a
safe steady-state rollback target for refund traffic because it contains the
historical partial-refund defect. Establish a minimal A2 hotfix/known-good
rollback target before the broader B6/B7 rollout.

## Operator safety

Do not put license keys, customer emails, installation IDs, or Stripe payloads
in shell arguments, logs, tickets, or ad hoc SQL. Do not manually update
license state, delete activations, or send a license email outside the Worker's
leased/idempotent delivery path. Retry the original signed webhook through the
provider workflow or use the reviewed, journaled repair procedure in
[`operations/WORKER-ROLLBACK-AND-RECONCILIATION.md`](operations/WORKER-ROLLBACK-AND-RECONCILIATION.md).

Production invocation logs and traces remain disabled. Operational alerting
and the full staging buyer journey are release gates, not optional follow-up.
