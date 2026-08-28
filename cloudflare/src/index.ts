import {
  generateLicenseKey,
  isValidKeyFormat,
  normalizeKey,
  type LicenseProduct,
} from "./license-keys";
import { LicenseEmailDeliveryError, sendLicenseEmail } from "./email";
import { verifyStripeSignature, type StripeEvent } from "./stripe";
import {
  InvalidRequestBodyError,
  readBoundedText,
  RequestBodyTooLargeError,
} from "./request-body";
import type { LicenseRow } from "./types";

const MAX_VALIDATE_BODY_BYTES = 4 * 1024;
const MAX_STRIPE_WEBHOOK_BODY_BYTES = 1024 * 1024;
const EMAIL_DELIVERY_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MUTATION_JOURNAL_RETENTION_DAYS = 90;
const DEFAULT_REFUND_EVENT_RETENTION_DAYS = 365;
const UNMATCHED_REFUND_EVENT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type LicenseIdentity = {
  key: string;
  installationId: string;
  activationId?: string;
  operationId?: string;
};

type LicenseIdentityResult =
  | { identity: LicenseIdentity; error?: never }
  | { identity?: never; error: Response };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

type CorsPolicy = "cliphutch" | "computedkit" | "checkout";

function corsPolicy(pathname: string): CorsPolicy | null {
  if (
    pathname === "/validate" ||
    pathname === "/v2/activate" ||
    pathname === "/v2/status" ||
    pathname === "/v2/deactivate"
  ) {
    return "cliphutch";
  }
  if (
    pathname === "/computedkit/validate" ||
    pathname === "/computedkit/v2/activate" ||
    pathname === "/computedkit/v2/status" ||
    pathname === "/computedkit/v2/deactivate"
  ) {
    return "computedkit";
  }
  if (pathname === "/computedkit/checkout") return "checkout";
  return null;
}

function allowedOrigins(policy: CorsPolicy, env: Env): ReadonlySet<string> {
  const configured =
    policy === "cliphutch"
      ? env.CLIPHUTCH_ALLOWED_ORIGINS
      : policy === "computedkit"
        ? env.COMPUTEDKIT_ALLOWED_ORIGINS
        : env.CHECKOUT_ALLOWED_ORIGINS;
  return new Set(
    configured
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function withRouteCors(
  response: Response,
  request: Request,
  env: Env,
  policy: CorsPolicy,
): Response {
  const headers = new Headers(response.headers);
  headers.set("Vary", "Origin");
  const origin = request.headers.get("Origin");
  if (origin !== null && allowedOrigins(policy, env).has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsPreflight(
  request: Request,
  env: Env,
  policy: CorsPolicy,
): Response {
  const response = new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
  return withRouteCors(response, request, env, policy);
}

async function handleHealth(env: Env): Promise<Response> {
  return json({
    ok: true,
    service: "cliphutch-api",
    environment: env.ENVIRONMENT,
    version: {
      id: env.WORKER_VERSION.id,
      tag: env.WORKER_VERSION.tag,
    },
  });
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function bodyErrorResponse(error: unknown, body: unknown): Response | null {
  if (error instanceof RequestBodyTooLargeError) {
    return json(body, { status: 413 });
  }
  if (error instanceof InvalidRequestBodyError) {
    return json(body, { status: 400 });
  }
  return null;
}

function maxDevicesFor(product: LicenseProduct, env: Env): number {
  const value =
    product === "computedkit"
      ? env.COMPUTEDKIT_MAX_DEVICES_PER_LICENSE
      : env.MAX_DEVICES_PER_LICENSE;
  return Number.parseInt(value ?? "", 10) || (product === "computedkit" ? 3 : 5);
}

function outboundTimeoutMs(env: Env): number {
  const parsed = Number.parseInt(env.OUTBOUND_TIMEOUT_MS ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 10 && parsed <= 30_000
    ? parsed
    : 10_000;
}

function mutationJournalRetentionMs(env: Env): number {
  const parsed = Number.parseInt(
    env.MUTATION_JOURNAL_RETENTION_DAYS ?? "",
    10,
  );
  const days =
    Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 365
      ? parsed
      : DEFAULT_MUTATION_JOURNAL_RETENTION_DAYS;
  return days * DAY_MS;
}

function mutationJournalExpiresAt(env: Env, occurredAt: number): number {
  return occurredAt + mutationJournalRetentionMs(env);
}

function refundEventRetentionMs(env: Env): number {
  const parsed = Number.parseInt(env.REFUND_EVENT_RETENTION_DAYS ?? "", 10);
  const days =
    Number.isSafeInteger(parsed) && parsed >= 30 && parsed <= 730
      ? parsed
      : DEFAULT_REFUND_EVENT_RETENTION_DAYS;
  return days * DAY_MS;
}

async function cleanupExpiredOperationalData(env: Env, now: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM license_mutation_journal WHERE expires_at <= ?",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM stripe_refund_events WHERE expires_at <= ?",
    ).bind(now),
    env.DB.prepare(
      `DELETE FROM activation_tombstones
       WHERE reactivated_at IS NOT NULL AND reactivated_at <= ?`,
    ).bind(now - mutationJournalRetentionMs(env)),
  ]);
}

async function readLicenseIdentity(
  request: Request,
  product: LicenseProduct,
  requireDeactivationIdentity = false,
): Promise<LicenseIdentityResult> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      await readBoundedText(request, MAX_VALIDATE_BODY_BYTES),
    );
    const record = recordValue(parsed);
    if (record === null) throw new InvalidRequestBodyError("Expected object");
    body = record;
  } catch (error) {
    const bounded = bodyErrorResponse(error, {
      valid: false,
      reason: "BAD_REQUEST",
    });
    return {
      error:
        bounded ??
        json({ valid: false, reason: "BAD_REQUEST" }, { status: 400 }),
    };
  }

  const key = normalizeKey(typeof body.key === "string" ? body.key : "");
  const installationId =
    typeof body.installationId === "string" ? body.installationId.trim() : "";

  if (
    !isValidKeyFormat(key) ||
    installationId.length === 0 ||
    installationId.length > 64
  ) {
    return {
      error: json(
        { valid: false, reason: "BAD_REQUEST" },
        { status: 400 },
      ),
    };
  }
  if (!isValidKeyFormat(key, product)) {
    return {
      error: json(
        { valid: false, reason: "WRONG_PRODUCT" },
        { status: 400 },
      ),
    };
  }

  const activationId =
    typeof body.activationId === "string" ? body.activationId.trim() : "";
  const operationId =
    typeof body.operationId === "string" ? body.operationId.trim() : "";
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    requireDeactivationIdentity &&
    (!uuidPattern.test(activationId) || !uuidPattern.test(operationId))
  ) {
    return {
      error: json(
        { ok: false, reason: "BAD_REQUEST", retryable: false },
        { status: 400 },
      ),
    };
  }

  return {
    identity: {
      key,
      installationId,
      ...(activationId ? { activationId } : {}),
      ...(operationId ? { operationId } : {}),
    },
  };
}

function inactiveLicenseResponse(
  license: Pick<LicenseRow, "status"> | null,
): Response {
  if (!license) {
    return json({ valid: false, active: false, reason: "NOT_FOUND" });
  }
  if (license.status === "refunded") {
    return json({ valid: false, active: false, reason: "REFUNDED" });
  }
  if (license.status === "revoked") {
    return json({ valid: false, active: false, reason: "REVOKED" });
  }
  return json({ valid: false, active: false, reason: "NOT_ACTIVATED" });
}

async function handleValidate(
  request: Request,
  env: Env,
  product: LicenseProduct,
  includeActivationId = false,
): Promise<Response> {
  const parsed = await readLicenseIdentity(request, product);
  if (parsed.error) return parsed.error;
  const { key, installationId } = parsed.identity;
  const maxDevices = maxDevicesFor(product, env);
  const now = Date.now();
  const journalExpiresAt = mutationJournalExpiresAt(env, now);
  const activationEventId = crypto.randomUUID();
  const [licenseFingerprint, installationFingerprint] = await Promise.all([
    fingerprint(key),
    fingerprint(installationId),
  ]);

  // Refresh only while the product-scoped license is still active. Assigning
  // a generation to a legacy row is safe: it does not create an activation.
  const refreshed = await env.DB.prepare(
    `UPDATE activations
     SET last_seen_at = ?, created_event_id = COALESCE(created_event_id, ?)
     WHERE license_key = ? AND installation_id = ?
       AND EXISTS (
         SELECT 1 FROM licenses
         WHERE key = ? AND product = ? AND status = 'active'
       )
     RETURNING created_event_id`,
  )
    .bind(now, activationEventId, key, installationId, key, product)
    .first<{ created_event_id: string }>();
  if (refreshed) {
    if (includeActivationId) {
      await env.DB.prepare(
        `UPDATE activation_tombstones SET reactivated_at = ?
         WHERE license_fingerprint = ? AND installation_fingerprint = ?
           AND reactivated_at IS NULL`,
      )
        .bind(now, licenseFingerprint, installationFingerprint)
        .run();
    }
    return json({
      valid: true,
      maxDevices,
      ...(includeActivationId
        ? { activationId: refreshed.created_event_id }
        : {}),
    });
  }

  const license = await env.DB.prepare(
    "SELECT * FROM licenses WHERE key = ? AND product = ?",
  )
    .bind(key, product)
    .first<LicenseRow>();
  if (!license) return json({ valid: false, reason: "NOT_FOUND" });
  if (license.status === "refunded") {
    return json({ valid: false, reason: "REFUNDED" });
  }
  if (license.status === "revoked") {
    return json({ valid: false, reason: "REVOKED" });
  }

  // A completed v2 deactivation is durable against delayed legacy /validate
  // calls. Only an explicit v2 activation can supersede its tombstone.
  if (!includeActivationId) {
    const tombstone = await env.DB.prepare(
      `SELECT operation_id FROM activation_tombstones
       WHERE license_fingerprint = ? AND installation_fingerprint = ?
         AND reactivated_at IS NULL
       LIMIT 1`,
    )
      .bind(licenseFingerprint, installationFingerprint)
      .first<{ operation_id: string }>();
    if (tombstone) {
      return json({ valid: false, reason: "NOT_ACTIVATED" });
    }
  }

  const [insertResult] = await env.DB.batch<{ created_event_id: string }>([
    env.DB.prepare(
      `INSERT INTO activations
         (license_key, installation_id, activated_at, last_seen_at, created_event_id)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM licenses
         WHERE key = ? AND product = ? AND status = 'active'
       )
       AND (
         SELECT COUNT(*) FROM activations WHERE license_key = ?
       ) < ?
       ON CONFLICT (license_key, installation_id)
       DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         created_event_id = COALESCE(activations.created_event_id, excluded.created_event_id)
       RETURNING created_event_id`,
    ).bind(
      key,
      installationId,
      now,
      now,
      activationEventId,
      key,
      product,
      key,
      maxDevices,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO license_mutation_journal
         (source, external_event_id, license_fingerprint,
          installation_fingerprint, mutation_type, previous_state,
          next_state, occurred_at, expires_at, metadata_json)
       SELECT 'runtime', ?, ?, ?, 'activation.created', NULL, 'active', ?, ?, '{}'
       FROM activations
       WHERE license_key = ? AND installation_id = ? AND created_event_id = ?`,
    ).bind(
      activationEventId,
      licenseFingerprint,
      installationFingerprint,
      now,
      journalExpiresAt,
      key,
      installationId,
      activationEventId,
    ),
  ]);

  const acceptedActivationId = insertResult.results[0]?.created_event_id;
  if (typeof acceptedActivationId === "string") {
    if (includeActivationId) {
      await env.DB.prepare(
        `UPDATE activation_tombstones SET reactivated_at = ?
         WHERE license_fingerprint = ? AND installation_fingerprint = ?
           AND reactivated_at IS NULL`,
      )
        .bind(now, licenseFingerprint, installationFingerprint)
        .run();
    }
    return json({
      valid: true,
      maxDevices,
      ...(includeActivationId ? { activationId: acceptedActivationId } : {}),
    });
  }

  // A simultaneous request for the same new installation may have inserted it
  // after the first lookup. Treat that replay as a refresh, not a device-limit
  // failure.
  const racedActivation = await env.DB.prepare(
    `UPDATE activations
     SET last_seen_at = ?, created_event_id = COALESCE(created_event_id, ?)
     WHERE license_key = ? AND installation_id = ?
       AND EXISTS (
         SELECT 1 FROM licenses
         WHERE key = ? AND product = ? AND status = 'active'
       )
     RETURNING created_event_id`,
  )
    .bind(now, activationEventId, key, installationId, key, product)
    .first<{ created_event_id: string }>();
  if (racedActivation) {
    if (includeActivationId) {
      await env.DB.prepare(
        `UPDATE activation_tombstones SET reactivated_at = ?
         WHERE license_fingerprint = ? AND installation_fingerprint = ?
           AND reactivated_at IS NULL`,
      )
        .bind(now, licenseFingerprint, installationFingerprint)
        .run();
    }
    return json({
      valid: true,
      maxDevices,
      ...(includeActivationId
        ? { activationId: racedActivation.created_event_id }
        : {}),
    });
  }

  const currentLicense = await env.DB.prepare(
    "SELECT * FROM licenses WHERE key = ? AND product = ?",
  )
    .bind(key, product)
    .first<LicenseRow>();
  if (!currentLicense) return json({ valid: false, reason: "NOT_FOUND" });
  if (currentLicense.status === "refunded") {
    return json({ valid: false, reason: "REFUNDED" });
  }
  if (currentLicense.status === "revoked") {
    return json({ valid: false, reason: "REVOKED" });
  }
  return json({ valid: false, reason: "DEVICE_LIMIT", maxDevices });
}

async function handleLicenseStatus(
  request: Request,
  env: Env,
  product: LicenseProduct,
): Promise<Response> {
  const parsed = await readLicenseIdentity(request, product);
  if (parsed.error) return parsed.error;
  const { key, installationId } = parsed.identity;
  const maxDevices = maxDevicesFor(product, env);
  const activationId = crypto.randomUUID();

  const active = await env.DB.prepare(
    `UPDATE activations
     SET last_seen_at = ?, created_event_id = COALESCE(created_event_id, ?)
     WHERE license_key = ? AND installation_id = ?
       AND EXISTS (
         SELECT 1 FROM licenses
         WHERE key = ? AND product = ? AND status = 'active'
       )
     RETURNING created_event_id`,
  )
    .bind(Date.now(), activationId, key, installationId, key, product)
    .first<{ created_event_id: string }>();
  if (active) {
    return json({
      valid: true,
      active: true,
      maxDevices,
      activationId: active.created_event_id,
    });
  }

  const license = await env.DB.prepare(
    "SELECT status FROM licenses WHERE key = ? AND product = ?",
  )
    .bind(key, product)
    .first<Pick<LicenseRow, "status">>();
  return inactiveLicenseResponse(license);
}

async function handleDeactivate(
  request: Request,
  env: Env,
  product: LicenseProduct,
): Promise<Response> {
  const parsed = await readLicenseIdentity(request, product, true);
  if (parsed.error) return parsed.error;
  const { key, installationId, activationId, operationId } = parsed.identity;
  if (!activationId || !operationId) {
    return json(
      { ok: false, reason: "BAD_REQUEST", retryable: false },
      { status: 400 },
    );
  }
  const now = Date.now();
  const journalExpiresAt = mutationJournalExpiresAt(env, now);
  const [licenseFingerprint, installationFingerprint] = await Promise.all([
    fingerprint(key),
    fingerprint(installationId),
  ]);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO activation_tombstones
         (operation_id, license_fingerprint, installation_fingerprint, activation_id,
          deactivated_at, reactivated_at)
       SELECT ?, ?, ?, a.created_event_id, ?, NULL
       FROM activations AS a
       JOIN licenses AS l ON l.key = a.license_key
       WHERE a.license_key = ? AND a.installation_id = ?
         AND a.created_event_id = ? AND l.product = ?`,
    ).bind(
      operationId,
      licenseFingerprint,
      installationFingerprint,
      now,
      key,
      installationId,
      activationId,
      product,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO license_mutation_journal
         (source, external_event_id, license_fingerprint,
          installation_fingerprint, mutation_type, previous_state,
          next_state, occurred_at, expires_at, metadata_json)
       SELECT 'runtime', ?, ?, ?, 'activation.deactivated',
              'active', 'inactive', ?, ?, '{}'
       FROM activations AS a
       JOIN licenses AS l ON l.key = a.license_key
       WHERE a.license_key = ? AND a.installation_id = ?
         AND a.created_event_id = ? AND l.product = ?
         AND EXISTS (
           SELECT 1 FROM activation_tombstones
           WHERE operation_id = ? AND activation_id = ?
         )`,
    ).bind(
      operationId,
      licenseFingerprint,
      installationFingerprint,
      now,
      journalExpiresAt,
      key,
      installationId,
      activationId,
      product,
      operationId,
      activationId,
    ),
    env.DB.prepare(
      `DELETE FROM activations
       WHERE license_key = ? AND installation_id = ? AND created_event_id = ?
         AND EXISTS (
           SELECT 1 FROM licenses WHERE key = ? AND product = ?
         )
         AND EXISTS (
           SELECT 1 FROM activation_tombstones
           WHERE operation_id = ? AND activation_id = ?
         )`,
    ).bind(
      key,
      installationId,
      activationId,
      key,
      product,
      operationId,
      activationId,
    ),
  ]);

  // Deliberately do not reveal whether the pair existed. Repeated and unknown
  // exact-pair requests have the same idempotent result.
  return json({ ok: true, active: false });
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
    "metadata[price_id]": priceId,
    "payment_intent_data[metadata][product]": "computedkit",
  });
  let stripeResponse: Response;
  try {
    stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecret}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(outboundTimeoutMs(env)),
    });
  } catch {
    console.error(
      JSON.stringify({ event: "checkout.session_create_transport_failed" }),
    );
    return new Response("Unable to start checkout. Please try again later.", {
      status: 502,
    });
  }
  const result = (await stripeResponse.json().catch(() => ({}))) as CheckoutSessionResponse;
  if (!stripeResponse.ok || !result.url) {
    console.error(
      JSON.stringify({
        event: "checkout.session_create_failed",
        status: stripeResponse.status,
      }),
    );
    return new Response("Unable to start checkout. Please try again later.", { status: 502 });
  }

  let checkoutUrl: URL;
  try {
    checkoutUrl = new URL(result.url);
  } catch {
    return new Response("Unable to start checkout. Please try again later.", { status: 502 });
  }
  if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") {
    console.error(
      JSON.stringify({ event: "checkout.unexpected_redirect_target" }),
    );
    return new Response("Unable to start checkout. Please try again later.", { status: 502 });
  }
  return new Response(null, {
    status: 303,
    headers: { Location: checkoutUrl.toString() },
  });
}

async function handleStripeWebhook(request: Request, env: Env): Promise<Response> {
  const signature = request.headers.get("Stripe-Signature");
  let rawBody: string;
  try {
    rawBody = await readBoundedText(request, MAX_STRIPE_WEBHOOK_BODY_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error, { ok: false, reason: "BAD_REQUEST" });
    if (bounded) return bounded;
    throw error;
  }

  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  let event: StripeEvent;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const record = recordValue(parsed);
    const data = recordValue(record?.data);
    const object = recordValue(data?.object);
    if (
      record === null ||
      typeof record.id !== "string" ||
      record.id.length === 0 ||
      record.id.length > 255 ||
      typeof record.type !== "string" ||
      record.type.length === 0 ||
      record.type.length > 128 ||
      data === null ||
      object === null
    ) {
      throw new InvalidRequestBodyError("Invalid Stripe event envelope");
    }
    event = {
      id: record.id,
      type: record.type,
      data: { object },
    };
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
    metadata?: { product?: string | null; price_id?: string | null };
    payment_status?: string | null;
    payment_link?: string | null;
  };

  const sessionId = session.id;
  if (!sessionId) return new Response("Missing session id", { status: 400 });

  // Idempotency: Stripe may retry webhooks. If we already issued a license
  // for this session, re-attempt email delivery only if it never went out.
  const existing = await env.DB.prepare(
    `SELECT key, email, product, status, email_sent_at, stripe_session_id
     FROM licenses WHERE stripe_session_id = ?`,
  )
    .bind(sessionId)
    .first<{
      key: string;
      email: string;
      product: LicenseProduct;
      status: LicenseRow["status"];
      email_sent_at: number | null;
      stripe_session_id: string;
    }>();

  if (existing) {
    if (existing.email_sent_at === null && existing.status === "active") {
      return await deliverLicenseEmail(
        existing.key,
        existing.email,
        existing.product,
        existing.stripe_session_id,
        env,
      );
    }
    if (existing.status !== "active") {
      return json({
        ok: true,
        emailSuppressed: true,
        reason: "LICENSE_INACTIVE",
      });
    }
    return json({ ok: true, alreadyIssued: true });
  }

  // Qualify the entitlement source before validating its fulfillment fields.
  // Genuine unrelated Checkout events share this account-wide webhook and are
  // acknowledged without mutation so Stripe does not retry them forever.
  const expectedPaymentLink = env.CLIPHUTCH_STRIPE_PAYMENT_LINK_ID?.trim();
  let product: LicenseProduct | null = null;
  if (
    expectedPaymentLink &&
    session.payment_link === expectedPaymentLink &&
    (session.metadata?.product == null ||
      session.metadata.product === "cliphutch")
  ) {
    // The exact configured Payment Link is the ClipHutch entitlement source.
    // Metadata is optional for compatibility with the existing link.
    product = "cliphutch";
  } else if (
    session.payment_link == null &&
    session.metadata?.product === "computedkit" &&
    session.metadata?.price_id === env.COMPUTEDKIT_STRIPE_PRICE_ID
  ) {
    product = "computedkit";
  } else if (
    session.metadata?.product === "cliphutch" ||
    session.metadata?.product === "computedkit"
  ) {
    return json(
      { ok: false, reason: "UNQUALIFIED_CHECKOUT_SOURCE" },
      { status: 400 },
    );
  } else {
    return json({ ok: true, ignored: "UNRELATED_CHECKOUT_SOURCE" });
  }
  if (typeof session.payment_status !== "string") {
    return json(
      { ok: false, reason: "MISSING_PAYMENT_STATUS" },
      { status: 400 },
    );
  }
  if (session.payment_status !== "paid") {
    return json({ ok: true, awaitingPayment: true });
  }
  const email = session.customer_details?.email ?? session.customer_email ?? null;
  if (!email) return new Response("Missing customer email", { status: 400 });
  const paymentIntentId =
    typeof session.payment_intent === "string" && session.payment_intent.length > 0
      ? session.payment_intent
      : null;
  if (!paymentIntentId) {
    return json(
      { ok: false, reason: "MISSING_PAYMENT_INTENT" },
      { status: 400 },
    );
  }

  const key = generateLicenseKey(product);
  const now = Date.now();
  const journalExpiresAt = mutationJournalExpiresAt(env, now);
  const licenseFingerprint = await fingerprint(key);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO licenses
         (key, email, stripe_session_id, payment_intent_id, product, status, created_at)
       SELECT ?, ?, ?, ?, ?, 'active', ?
       WHERE NOT EXISTS (
         SELECT 1 FROM stripe_refund_events
         WHERE payment_intent_id = ? AND is_full = 1
       )`,
    ).bind(
      key,
      email,
      sessionId,
      paymentIntentId,
      product,
      now,
      paymentIntentId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO license_mutation_journal
         (source, external_event_id, license_fingerprint,
          installation_fingerprint, mutation_type, previous_state,
          next_state, occurred_at, expires_at, metadata_json)
       SELECT 'stripe', ?, ?, NULL, 'license.issued', NULL, 'active', ?, ?, ?
       FROM licenses WHERE stripe_session_id = ? AND key = ?`,
    ).bind(
      event.id,
      licenseFingerprint,
      now,
      journalExpiresAt,
      JSON.stringify({ product }),
      sessionId,
      key,
    ),
  ]);

  // Another delivery of the same Checkout event can win the unique-session
  // insert. Always use the stored row rather than assuming our generated key
  // was the winner.
  const issued = await env.DB.prepare(
    `SELECT key, email, product, status, email_sent_at, stripe_session_id
     FROM licenses WHERE stripe_session_id = ?`,
  )
    .bind(sessionId)
    .first<{
      key: string;
      email: string;
      product: LicenseProduct;
      status: LicenseRow["status"];
      email_sent_at: number | null;
      stripe_session_id: string;
    }>();
  if (!issued) {
    const pendingFullRefund = await env.DB.prepare(
      `UPDATE stripe_refund_events
       SET applied_at = COALESCE(applied_at, ?), expires_at = ?
       WHERE payment_intent_id = ? AND is_full = 1
       RETURNING event_id`,
    )
      .bind(now, now + refundEventRetentionMs(env), paymentIntentId)
      .first<{ event_id: string }>();
    if (pendingFullRefund) {
      return json({
        ok: true,
        licenseIssued: false,
        reason: "FULL_REFUND_ALREADY_RECORDED",
      });
    }
    return new Response("License issuance failed", { status: 500 });
  }
  if (issued.status !== "active") {
    return json({
      ok: true,
      emailSuppressed: true,
      reason: "LICENSE_INACTIVE",
    });
  }
  if (issued.email_sent_at !== null) {
    return json({ ok: true, alreadyIssued: true });
  }
  return await deliverLicenseEmail(
    issued.key,
    issued.email,
    issued.product,
    issued.stripe_session_id,
    env,
  );
}

// On failure this returns 500 so Stripe redelivers the webhook; the
// idempotent branch in issueLicenseFromCheckout re-attempts delivery for an
// issued license whose email never went out. Retry exhaustion surfaces as a
// failing webhook endpoint in the Stripe dashboard.
async function deliverLicenseEmail(
  key: string,
  email: string,
  product: LicenseProduct,
  stripeSessionId: string,
  env: Env,
): Promise<Response> {
  const now = Date.now();
  const proposedDeliveryKey = `license-email-${await fingerprint(stripeSessionId)}`;
  const claim = await env.DB.prepare(
    `UPDATE licenses
     SET email_delivery_key = COALESCE(email_delivery_key, ?),
         email_delivery_claimed_at = ?
     WHERE key = ? AND email_sent_at IS NULL
       AND status = 'active'
       AND (
         email_delivery_claimed_at IS NULL OR email_delivery_claimed_at < ?
       )
     RETURNING email_delivery_key`,
  )
    .bind(
      proposedDeliveryKey,
      now,
      key,
      now - EMAIL_DELIVERY_LEASE_MS,
    )
    .first<{ email_delivery_key: string }>();
  if (!claim) {
    const current = await env.DB.prepare(
      "SELECT email_sent_at, status FROM licenses WHERE key = ?",
    )
      .bind(key)
      .first<{
        email_sent_at: number | null;
        status: LicenseRow["status"];
      }>();
    if (current && current.status !== "active") {
      return json({
        ok: true,
        emailSuppressed: true,
        reason: "LICENSE_INACTIVE",
      });
    }
    if (current?.email_sent_at !== null && current?.email_sent_at !== undefined) {
      return json({ ok: true, alreadyIssued: true });
    }
    return new Response("License email delivery already in progress", {
      status: 500,
    });
  }

  try {
    await sendLicenseEmail(
      email,
      key,
      env.RESEND_API_KEY,
      env.RESEND_FROM_EMAIL,
      product,
      outboundTimeoutMs(env),
      claim.email_delivery_key,
    );
  } catch (err) {
    await env.DB.prepare(
      `UPDATE licenses SET email_delivery_claimed_at = NULL
       WHERE key = ? AND email_delivery_key = ? AND email_sent_at IS NULL`,
    )
      .bind(key, claim.email_delivery_key)
      .run();
    console.error(
      JSON.stringify({
        event: "license.email_delivery_failed",
        providerStatus:
          err instanceof LicenseEmailDeliveryError ? err.status : null,
        failureKind:
          err instanceof LicenseEmailDeliveryError ? err.kind : "unexpected",
      }),
    );
    return new Response("License issued, email delivery pending", { status: 500 });
  }
  const update = await env.DB.prepare(
    `UPDATE licenses
     SET email_sent_at = ?, email_delivery_claimed_at = NULL
     WHERE key = ? AND email_delivery_key = ? AND email_sent_at IS NULL`,
  )
    .bind(Date.now(), key, claim.email_delivery_key)
    .run();
  if (update.meta.changes !== 1) {
    throw new Error("Email delivery state did not commit");
  }
  return json({ ok: true });
}

async function markLicenseRefunded(event: StripeEvent, env: Env): Promise<Response> {
  const charge = event.data.object as {
    payment_intent?: unknown;
    refunded?: unknown;
    amount?: unknown;
    amount_refunded?: unknown;
  };
  const paymentIntentId =
    typeof charge.payment_intent === "string" &&
    charge.payment_intent.length > 0 &&
    charge.payment_intent.length <= 255
      ? charge.payment_intent
      : null;
  const amount = charge.amount;
  const amountRefunded = charge.amount_refunded;
  if (
    !paymentIntentId ||
    typeof charge.refunded !== "boolean" ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    typeof amountRefunded !== "number" ||
    !Number.isSafeInteger(amountRefunded) ||
    amountRefunded < 0 ||
    amountRefunded > amount ||
    (charge.refunded && amountRefunded !== amount) ||
    (!charge.refunded && amountRefunded >= amount)
  ) {
    return json(
      { ok: false, reason: "MALFORMED_REFUND_EVENT" },
      { status: 400 },
    );
  }

  const now = Date.now();
  const journalExpiresAt = mutationJournalExpiresAt(env, now);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO stripe_refund_events
       (event_id, payment_intent_id, is_full, amount, amount_refunded,
        observed_at, applied_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
  )
    .bind(
      event.id,
      paymentIntentId,
      charge.refunded ? 1 : 0,
      amount,
      amountRefunded,
      now,
      now + UNMATCHED_REFUND_EVENT_RETENTION_DAYS * DAY_MS,
    )
    .run();

  const matchingLicense = await env.DB.prepare(
    `SELECT key, status, refunded_event_id
     FROM licenses WHERE payment_intent_id = ?`,
  )
    .bind(paymentIntentId)
    .first<Pick<LicenseRow, "key" | "status" | "refunded_event_id">>();
  if (!matchingLicense) {
    return json({
      ok: true,
      matched: false,
      ...(charge.refunded ? { pendingFullRefund: true } : { partialRefund: true }),
    });
  }
  const licenseFingerprint = await fingerprint(matchingLicense.key);
  const metadata = JSON.stringify({ amount, amountRefunded });

  if (!charge.refunded) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE stripe_refund_events
         SET applied_at = COALESCE(applied_at, ?), expires_at = ?
         WHERE event_id = ?`,
      ).bind(now, now + refundEventRetentionMs(env), event.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO license_mutation_journal
           (source, external_event_id, license_fingerprint,
            installation_fingerprint, mutation_type, previous_state,
            next_state, occurred_at, expires_at, metadata_json)
         VALUES ('stripe', ?, ?, NULL, 'license.partial_refund_observed',
                 ?, ?, ?, ?, ?)`,
      ).bind(
        event.id,
        licenseFingerprint,
        matchingLicense.status,
        matchingLicense.status,
        now,
        journalExpiresAt,
        metadata,
      ),
    ]);
    return json({ ok: true, partialRefund: true });
  }

  if (matchingLicense.status === "refunded") {
    if (matchingLicense.refunded_event_id === event.id) {
      await env.DB.prepare(
        `UPDATE stripe_refund_events
         SET applied_at = COALESCE(applied_at, ?), expires_at = ?
         WHERE event_id = ?`,
      )
        .bind(now, now + refundEventRetentionMs(env), event.id)
        .run();
      return json({ ok: true, changed: false, alreadyRefunded: true });
    }
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE licenses
         SET refunded_event_id = COALESCE(refunded_event_id, ?),
             refund_amount = COALESCE(refund_amount, ?),
             refund_amount_refunded = COALESCE(refund_amount_refunded, ?)
         WHERE key = ? AND payment_intent_id = ? AND status = 'refunded'`,
      ).bind(
        event.id,
        amount,
        amountRefunded,
        matchingLicense.key,
        paymentIntentId,
      ),
      env.DB.prepare(
        `UPDATE stripe_refund_events
         SET applied_at = COALESCE(applied_at, ?), expires_at = ?
         WHERE event_id = ?`,
      ).bind(now, now + refundEventRetentionMs(env), event.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO license_mutation_journal
           (source, external_event_id, license_fingerprint,
            installation_fingerprint, mutation_type, previous_state,
            next_state, occurred_at, expires_at, metadata_json)
         VALUES ('stripe', ?, ?, NULL, 'license.full_refund_confirmed',
                 'refunded', 'refunded', ?, ?, ?)`,
      ).bind(event.id, licenseFingerprint, now, journalExpiresAt, metadata),
    ]);
    return json({ ok: true, changed: false, alreadyRefunded: true });
  }

  const [updateResult] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE licenses
       SET status = 'refunded', refunded_at = ?, refunded_event_id = ?,
           refund_amount = ?, refund_amount_refunded = ?
       WHERE key = ? AND payment_intent_id = ? AND status = ?`,
    ).bind(
      now,
      event.id,
      amount,
      amountRefunded,
      matchingLicense.key,
      paymentIntentId,
      matchingLicense.status,
    ),
    env.DB.prepare(
      `UPDATE stripe_refund_events
       SET applied_at = COALESCE(applied_at, ?), expires_at = ?
       WHERE event_id = ?`,
    ).bind(now, now + refundEventRetentionMs(env), event.id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO license_mutation_journal
         (source, external_event_id, license_fingerprint,
          installation_fingerprint, mutation_type, previous_state,
          next_state, occurred_at, expires_at, metadata_json)
       SELECT 'stripe', ?, ?, NULL, 'license.refunded', ?, 'refunded', ?, ?, ?
       FROM licenses
       WHERE key = ? AND payment_intent_id = ? AND refunded_event_id = ?`,
    ).bind(
      event.id,
      licenseFingerprint,
      matchingLicense.status,
      now,
      journalExpiresAt,
      metadata,
      matchingLicense.key,
      paymentIntentId,
      event.id,
    ),
  ]);

  return json({
    ok: true,
    changed: updateResult.meta.changes > 0,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const policy = corsPolicy(url.pathname);

    if (method === "OPTIONS") {
      return policy
        ? corsPreflight(request, env, policy)
        : new Response("Not Found", { status: 404 });
    }

    try {
      let response: Response;
      if (method === "GET" && url.pathname === "/") {
        response = await handleHealth(env);
      } else if (method === "POST" && url.pathname === "/validate") {
        response = await handleValidate(request, env, "cliphutch");
      } else if (method === "POST" && url.pathname === "/v2/activate") {
        response = await handleValidate(request, env, "cliphutch", true);
      } else if (method === "POST" && url.pathname === "/v2/status") {
        response = await handleLicenseStatus(request, env, "cliphutch");
      } else if (method === "POST" && url.pathname === "/v2/deactivate") {
        response = await handleDeactivate(request, env, "cliphutch");
      } else if (
        method === "POST" &&
        url.pathname === "/computedkit/validate"
      ) {
        response = await handleValidate(request, env, "computedkit");
      } else if (
        method === "POST" &&
        url.pathname === "/computedkit/v2/activate"
      ) {
        response = await handleValidate(request, env, "computedkit", true);
      } else if (
        method === "POST" &&
        url.pathname === "/computedkit/v2/status"
      ) {
        response = await handleLicenseStatus(request, env, "computedkit");
      } else if (
        method === "POST" &&
        url.pathname === "/computedkit/v2/deactivate"
      ) {
        response = await handleDeactivate(request, env, "computedkit");
      } else if (
        method === "POST" &&
        url.pathname === "/computedkit/checkout"
      ) {
        response = await handleComputedKitCheckout(env);
      } else if (method === "POST" && url.pathname === "/stripe-webhook") {
        response = await handleStripeWebhook(request, env);
      } else if (
        (url.pathname === "/" && method !== "GET") ||
        (policy !== null && method !== "POST") ||
        (url.pathname === "/stripe-webhook" && method !== "POST")
      ) {
        response = new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: url.pathname === "/" ? "GET" : "POST" },
        });
      } else {
        response = new Response("Not Found", { status: 404 });
      }

      return policy ? withRouteCors(response, request, env, policy) : response;
    } catch {
      console.error(
        JSON.stringify({
          event: "request.failed",
          method,
          route: url.pathname,
        }),
      );
      let response: Response;
      if (url.pathname === "/stripe-webhook") {
        response = new Response("Temporary webhook failure", { status: 500 });
      } else if (url.pathname.endsWith("/v2/deactivate")) {
        response = json(
          { ok: false, reason: "SERVICE_UNAVAILABLE", retryable: true },
          { status: 503 },
        );
      } else if (policy === "cliphutch" || policy === "computedkit") {
        response = json(
          { valid: false, reason: "SERVICE_UNAVAILABLE" },
          { status: 503 },
        );
      } else {
        response = new Response("Service unavailable", { status: 503 });
      }
      return policy ? withRouteCors(response, request, env, policy) : response;
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    try {
      await cleanupExpiredOperationalData(env, Date.now());
    } catch {
      console.error(JSON.stringify({ event: "operational_cleanup.failed" }));
      throw new Error("Operational cleanup failed");
    }
  },
} satisfies ExportedHandler<Env>;
