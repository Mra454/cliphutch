import { generateLicenseKey, isValidKeyFormat, normalizeKey } from "./license-keys";
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

async function handleValidate(request: Request, env: Env): Promise<Response> {
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

  const license = await env.DB.prepare("SELECT * FROM licenses WHERE key = ?")
    .bind(key)
    .first<LicenseRow>();

  if (!license) return json({ valid: false, reason: "NOT_FOUND" });
  if (license.status === "refunded") return json({ valid: false, reason: "REFUNDED" });
  if (license.status === "revoked") return json({ valid: false, reason: "REVOKED" });

  const maxDevices = Number.parseInt(env.MAX_DEVICES_PER_LICENSE, 10) || 5;
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

  if (event.type === "checkout.session.completed") {
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
  };

  const sessionId = session.id;
  if (!sessionId) return new Response("Missing session id", { status: 400 });

  const email = session.customer_details?.email ?? session.customer_email ?? null;
  if (!email) return new Response("Missing customer email", { status: 400 });

  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : null;

  // Idempotency: Stripe may retry webhooks. If we already issued a license
  // for this session, return the existing key (don't double-send email).
  const existing = await env.DB.prepare(
    "SELECT key FROM licenses WHERE stripe_session_id = ?",
  )
    .bind(sessionId)
    .first<{ key: string }>();

  if (existing) {
    return json({ ok: true, key: existing.key, alreadyIssued: true });
  }

  const key = generateLicenseKey();
  await env.DB.prepare(
    "INSERT INTO licenses (key, email, stripe_session_id, payment_intent_id, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
  )
    .bind(key, email, sessionId, paymentIntentId, Date.now())
    .run();

  try {
    await sendLicenseEmail(email, key, env.RESEND_API_KEY, env.RESEND_FROM_EMAIL);
  } catch (err) {
    // License is in DB; email can be retried by the operator. Surface in logs.
    console.error("Resend send failed:", err);
  }

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
    if (method === "POST" && url.pathname === "/validate") return handleValidate(request, env);
    if (method === "POST" && url.pathname === "/stripe-webhook")
      return handleStripeWebhook(request, env);

    return new Response("Not Found", { status: 404 });
  },
};
