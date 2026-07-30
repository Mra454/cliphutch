# cliphutch-api — license validation Worker

Cloudflare Worker that handles product-isolated ClipHutch and ComputedKit license
issuance (via Stripe Checkout/webhooks) and validation (called by each extension).

## Endpoints

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET`  | `/`  | none | Health check, returns `{ ok: true, service: "cliphutch-api" }` |
| `POST` | `/validate` | license key in body | Extension calls this with `{ key, installationId }`. Returns `{ valid: true, maxDevices }` or `{ valid: false, reason }`. Records or refreshes the activation. |
| `POST` | `/computedkit/validate` | license key in body | ComputedKit calls this only after a user enters a `CK-` key and chooses Activate Pro. It accepts only `computedkit` licenses and has a three-browser limit. |
| `POST` | `/computedkit/checkout` | none | Creates a Stripe-hosted one-time Checkout session for the configured ComputedKit Pro Price, then redirects the user to Stripe. It receives no scan or page data. |
| `POST` | `/stripe-webhook` | Stripe signature | Stripe calls this on successful Checkout payment (issues the correctly scoped license + emails it) and `charge.refunded` (marks a license refunded). |

## One-time deploy

```sh
cd cloudflare
npm install
npx wrangler login

# Create the D1 database — copy the printed UUID into wrangler.toml under
# [[d1_databases]].database_id (replacing REPLACE_AFTER_WRANGLER_D1_CREATE).
npx wrangler d1 create cliphutch-licenses

# Apply schema to the remote DB.
npm run db:init:remote

# Set the secrets (you'll be prompted for each value).
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL

# Deploy.
npm run deploy
```

The deploy URL prints as something like `https://cliphutch-api.<your-subdomain>.workers.dev`.

## Wiring Stripe and ComputedKit Pro

After deploying, in the Stripe Dashboard:

1. In **Products**, create **ComputedKit Pro — Baselines & Compare** with a **US$29 one-time** Price. Do not create a subscription.
2. Put its Price ID (for example `price_...`) in the deployed Worker's `COMPUTEDKIT_STRIPE_PRICE_ID` variable. It is a non-secret configuration value; keep the production value out of local development files.
3. Set the Stripe API secret with `npx wrangler secret put STRIPE_SECRET_KEY`. The Worker uses it only to create the Checkout session.
4. In **Developers → Webhooks**, add `https://cliphutch-api.<your-subdomain>.workers.dev/stripe-webhook` and subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `charge.refunded`.
5. Reveal the endpoint signing secret (starts `whsec_`) and set it with `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
6. Configure Stripe's customer-facing business details and support contact. The extension site directs customers to the ComputedKit terms, privacy policy, and 14-day refund process before checkout.

Checkout session metadata is set to `product=computedkit`. The webhook therefore stores
that product and issues only `CK-` keys. Existing `CH-` records default to
`cliphutch`, and cannot validate through `/computedkit/validate`.

## Wiring Resend

1. Create a Resend account, verify your sending domain.
2. Generate an API key.
3. `npx wrangler secret put RESEND_API_KEY` with the key.
4. `npx wrangler secret put RESEND_FROM_EMAIL` with e.g. `licenses@cliphutch.app`.

## Local dev

Copy `.dev.vars.example` to `.dev.vars` and fill in test values:

```sh
cp .dev.vars.example .dev.vars
# edit .dev.vars
npm run db:init:local
npm run dev
```

`wrangler dev` serves at `http://localhost:8787`. Test with:

```sh
curl http://localhost:8787/
# => {"ok":true,"service":"cliphutch-api"}

curl -X POST http://localhost:8787/validate \
  -H "Content-Type: application/json" \
  -d '{"key":"CH-AAAA-BBBB-CCCC-DDDD","installationId":"local-test"}'
# => {"valid":false,"reason":"NOT_FOUND"}  (until you've issued a key locally)

curl -X POST http://localhost:8787/computedkit/validate \
  -H "Content-Type: application/json" \
  -d '{"key":"CK-AAAA-BBBB-CCCC-DDDD","installationId":"local-test"}'
# => {"valid":false,"reason":"NOT_FOUND"}  (until you've issued a key locally)
```

## Operator notes

| Task | How |
| ---- | --- |
| Look up a license by email | `npx wrangler d1 execute cliphutch-licenses --remote --command="SELECT * FROM licenses WHERE email = 'foo@bar.com';"` |
| Manually issue a ClipHutch license | Insert a `CH-` key into `licenses` with `product = 'cliphutch'` and a fake `stripe_session_id`. |
| Manually issue a ComputedKit license | Insert a `CK-` key into `licenses` with `product = 'computedkit'` and a fake `stripe_session_id`. |
| Revoke a license | `UPDATE licenses SET status = 'revoked' WHERE key = 'CH-...';` |
| See activations for a key | `SELECT * FROM activations WHERE license_key = 'CH-...';` |
| Reset device count for a user (e.g., they reinstalled OS) | `DELETE FROM activations WHERE license_key = 'CH-...';` — they can reactivate freely after this. |
| Re-send a license email (Resend was down during purchase, etc.) | `RESEND_API_KEY=re_... RESEND_FROM_EMAIL='ClipHutch <licenses@cliphutch.com>' node scripts/resend-license.mjs <email> <license-key>` |

## Migration

Before deploying the product-isolation Worker change to the existing production D1
database, run:

```sh
npm run db:migrations:list
npm run db:migrations:apply
```

Migration `0001_add_product_to_licenses.sql` gives existing rows the intentionally
safe `cliphutch` product value. Run it once, before deploying the Worker code that
queries the `product` column.
