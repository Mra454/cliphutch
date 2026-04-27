# cliphutch-api — license validation Worker

Cloudflare Worker that handles ClipHutch license issuance (via Stripe webhook) and validation (called by the extension).

## Endpoints

| Method | Path | Auth | Purpose |
| ------ | ---- | ---- | ------- |
| `GET`  | `/`  | none | Health check, returns `{ ok: true, service: "cliphutch-api" }` |
| `POST` | `/validate` | license key in body | Extension calls this with `{ key, installationId }`. Returns `{ valid: true, maxDevices }` or `{ valid: false, reason }`. Records or refreshes the activation. |
| `POST` | `/stripe-webhook` | Stripe signature | Stripe calls this on `checkout.session.completed` (issues a license + emails it) and `charge.refunded` (marks license refunded). |

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
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL

# Deploy.
npm run deploy
```

The deploy URL prints as something like `https://cliphutch-api.<your-subdomain>.workers.dev`.

## Wiring Stripe

After deploying, in the Stripe Dashboard:

1. **Products** → create "ClipHutch License", price `$35` USD, **One-time** (not subscription).
2. Open the product → enable **Stripe Checkout** → copy the public payment link.
3. **Developers → Webhooks** → **Add endpoint** → URL: `https://cliphutch-api.<your-subdomain>.workers.dev/stripe-webhook`
4. Subscribe to events: `checkout.session.completed`, `charge.refunded`.
5. Reveal the **Signing secret** (starts with `whsec_`) and run `npx wrangler secret put STRIPE_WEBHOOK_SECRET` with that value (re-run if you'd already set a placeholder).

The Checkout URL goes into `extension/src/lib/constants.ts` as `CHECKOUT_URL` (replaces `TODO_CHECKOUT_URL`).

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
```

## Operator notes

| Task | How |
| ---- | --- |
| Look up a license by email | `npx wrangler d1 execute cliphutch-licenses --remote --command="SELECT * FROM licenses WHERE email = 'foo@bar.com';"` |
| Manually issue a license | Insert into `licenses` table with a fake `stripe_session_id`. |
| Revoke a license | `UPDATE licenses SET status = 'revoked' WHERE key = 'CH-...';` |
| See activations for a key | `SELECT * FROM activations WHERE license_key = 'CH-...';` |
| Reset device count for a user (e.g., they reinstalled OS) | `DELETE FROM activations WHERE license_key = 'CH-...';` — they can reactivate freely after this. |
| Re-send a license email (Resend was down during purchase, etc.) | `RESEND_API_KEY=re_... RESEND_FROM_EMAIL='ClipHutch <licenses@cliphutch.com>' node scripts/resend-license.mjs <email> <license-key>` |

## Phase 3 (next)

Wire the extension to call this Worker:
- `extension/src/lib/license.ts` `activateLicense()` POSTs to `/validate` (currently a stub that accepts any well-formed key)
- Add a periodic re-validation (weekly) with a 7-day offline grace period
- Add `installationId` generation (random UUID, persisted in `chrome.storage.local`)

After Phase 3, set `CHECKOUT_URL` in `extension/src/lib/constants.ts` to the Stripe Checkout URL from the dashboard.
