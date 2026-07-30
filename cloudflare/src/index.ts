import {
  generateLicenseKey,
  isValidKeyFormat,
  normalizeKey,
  type LicenseProduct,
} from "./license-keys";
import { sendLicenseEmail } from "./email";
import { verifyStripeSignature, type StripeEvent } from "./stripe";
import type { ActivationRow, Env, LicenseRow } from "./types";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...(init.headers ?? {}),
    },
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

async function handleHealth(): Promise<Response> {
  return json({ ok: true, service: "cliphutch-api" });
}

type ValidateRequest = { key?: string; installationId?: string };

function maxDevicesFor(product: LicenseProduct, env: Env): number {
  const value =
    product === "computedkit"
      ? env.COMPUTEDKIT_MAX_DEVICES_PER_LICENSE
      : env.MAX_DEVICES_PER_LICENSE;
  return Number.parseInt(value ?? "", 10) || (product === "computedkit" ? 3 : 5);
}

async function handleValidate(
  request: Request,
  env: Env,
  product: LicenseProduct,
): Promise<Response> {
  let body: ValidateRequest;
  try {
    body = (await request.json()) as ValidateRequest;
  } catch {
    return json({ valid: false, reason: "BAD_REQUEST" }, { status: 400 });
  }

  const key = normalizeKey(body.key ?? "");
  const installationId = (body.installationId ?? "").trim();

  if (!isValidKeyFormat(key) || installationId.length === 0 || installationId.length > 64) {
    return json({ valid: false, reason: "BAD_REQUEST" }, { status: 400 });
  }
  if (!isValidKeyFormat(key, product)) {
    return json({ valid: false, reason: "WRONG_PRODUCT" }, { status: 400 });
  }

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE key = ? AND product = ?")
    .bind(key, product)
    .first<LicenseRow>();

  if (!license) return json({ valid: false, reason: "NOT_FOUND" });
  if (license.status === "refunded") return json({ valid: false, reason: "REFUNDED" });
  if (license.status === "revoked") return json({ valid: false, reason: "REVOKED" });

  const maxDevices = maxDevicesFor(product, env);
  const now = Date.now();

  const activation = await env.DB.prepare(
    "SELECT * FROM activations WHERE license_key = ? AND installation_id = ?",
  )
    .bind(key, installationId)
    .first<ActivationRow>();

  if (activation) {
    await env.DB.prepare(
      "UPDATE activations SET last_seen_at = ? WHERE license_key = ? AND installation_id = ?",
    )
      .bind(now, key, installationId)
      .run();
    return json({ valid: true, maxDevices });
  }

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM activations WHERE license_key = ?",
  )
    .bind(key)
    .first<{ count: number }>();

  const count = countRow?.count ?? 0;
  if (count >= maxDevices) {
    return json({ valid: false, reason: "DEVICE_LIMIT", maxDevices });
  }

  await env.DB.prepare(
    "INSERT INTO activations (license_key, installation_id, activated_at, last_seen_at) VALUES (?, ?, ?, ?)",
  )
    .bind(key, installationId, now, now)
    .run();

  return json({ valid: true, maxDevices });
}

type CheckoutSessionResponse = { url?: string; error?: { message?: string } };

function configuredUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function handleComputedKitCheckout(env: Env): Promise<Response> {
  const stripeSecret = env.STRIPE_SECRET_KEY;
  const priceId = env.COMPUTEDKIT_STRIPE_PRICE_ID;
  const successUrl = configuredUrl(env.COMPUTEDKIT_SUCCESS_URL);
  const cancelUrl = configuredUrl(env.COMPUTEDKIT_CANCEL_URL);
  if (!stripeSecret || !priceId || !successUrl || !cancelUrl) {
    console.error("ComputedKit checkout configuration is incomplete", {
      stripeSecretConfigured: Boolean(stripeSecret),
      priceConfigured: Boolean(priceId),
      successUrlConfigured: Boolean(successUrl),
      cancelUrlConfigured: Boolean(cancelUrl)
    });
    return new Response("ComputedKit checkout is not configured yet.", { status: 503 });
  }

  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    "metadata[product]": "computedkit",
    "payment_intent_data[metadata][product]": "computedkit",
  });
  const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const result = (await stripeResponse.json().catch(() => ({}))) as CheckoutSessionResponse;
  if (!stripeResponse.ok || !result.url) {
    console.error("Stripe Checkout session creation failed:", stripeResponse.status, result.error?.message);
    return new Response("Unable to start checkout. Please try again later.", { status: 502 });
  }

  let checkoutUrl: URL;
  try {
    checkoutUrl = new URL(result.url);
  } catch {
    return new Response("Unable to start checkout. Please try again later.", { status: 502 });
  }
  if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") {
    console.error("Stripe returned an unexpected checkout URL host:", checkoutUrl.hostname);
    return new Response("Unable to start checkout. Please try again later.", { status: 502 });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: checkoutUrl.toString() },
  });
}

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("Stripe-Signature");
  const rawBody = await request.text();

  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    return await issueLicenseFromCheckout(event, env);
  }

  if (event.type === "charge.refunded") {
    return await markLicenseRefunded(event, env);
  }

  return json({ ok: true, ignored: event.type });
}

async function issueLicenseFromCheckout(event: StripeEvent, env: Env): Promise<Response> {
  const session = event.data.object as {
    id?: string;
    payment_intent?: string | null;
    customer_email?: string | null;
    customer_details?: { email?: string | null };
    metadata?: { product?: string | null };
    payment_status?: string | null;
  };

  const sessionId = session.id;
  if (!sessionId) return new Response("Missing session id", { status: 400 });

  // A completed Checkout session can precede confirmation for asynchronous
  // payment methods. The later async_payment_succeeded event will issue it.
  if (session.payment_status && session.payment_status !== "paid") {
    return json({ ok: true, awaitingPayment: true });
  }

  const email = session.customer_details?.email ?? session.customer_email ?? null;
  if (!email) return new Response("Missing customer email", { status: 400 });

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : null;

  // Idempotency: Stripe may retry webhooks. If we already issued a license
  // for this session, re-attempt email delivery only if it never went out.
  const existing = await env.DB.prepare(
    "SELECT key, email, product, email_sent_at FROM licenses WHERE stripe_session_id = ?",
  )
    .bind(sessionId)
    .first<{ key: string; email: string; product: LicenseProduct; email_sent_at: number | null }>();

  if (existing) {
    if (existing.email_sent_at === null) {
      return await deliverLicenseEmail(existing.key, existing.email, existing.product, env);
    }
    return json({ ok: true, key: existing.key, alreadyIssued: true });
  }

  const product: LicenseProduct = session.metadata?.product === "computedkit" ? "computedkit" : "cliphutch";
  const key = generateLicenseKey(product);
  await env.DB.prepare(
    "INSERT INTO licenses (key, email, stripe_session_id, payment_intent_id, product, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
  )
    .bind(key, email, sessionId, paymentIntentId, product, Date.now())
    .run();

  return await deliverLicenseEmail(key, email, product, env);
}

// On failure this returns 500 so Stripe redelivers the webhook; the
// idempotent branch in issueLicenseFromCheckout re-attempts delivery for an
// issued license whose email never went out. Retry exhaustion surfaces as a
// failing webhook endpoint in the Stripe dashboard.
async function deliverLicenseEmail(
  key: string,
  email: string,
  product: LicenseProduct,
  env: Env,
): Promise<Response> {
  try {
    await sendLicenseEmail(email, key, env.RESEND_API_KEY, env.RESEND_FROM_EMAIL, product);
  } catch (err) {
    console.error("Resend send failed; returning 500 for Stripe retry:", err);
    return new Response("License issued, email delivery pending", { status: 500 });
  }
  await env.DB.prepare("UPDATE licenses SET email_sent_at = ? WHERE key = ?")
    .bind(Date.now(), key)
    .run();
  return json({ ok: true, key });
}

async function markLicenseRefunded(event: StripeEvent, env: Env): Promise<Response> {
  const charge = event.data.object as { payment_intent?: string | null };
  const paymentIntentId =
    typeof charge.payment_intent === "string" ? charge.payment_intent : null;
  if (!paymentIntentId) return json({ ok: true, message: "No payment_intent on charge" });

  await env.DB.prepare(
    "UPDATE licenses SET status = 'refunded', refunded_at = ? WHERE payment_intent_id = ?",
  )
    .bind(Date.now(), paymentIntentId)
    .run();

  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") return corsPreflight();

    if (method === "GET" && url.pathname === "/") return handleHealth();
    if (method === "POST" && url.pathname === "/validate")
      return handleValidate(request, env, "cliphutch");
    if (method === "POST" && url.pathname === "/computedkit/validate")
      return handleValidate(request, env, "computedkit");
    if (method === "POST" && url.pathname === "/computedkit/checkout")
      return handleComputedKitCheckout(env);
    if (method === "POST" && url.pathname === "/stripe-webhook")
      return handleStripeWebhook(request, env);

    return new Response("Not Found", { status: 404 });
  },
};
