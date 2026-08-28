import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const API_ORIGIN = "https://api.test.invalid";
const WEBHOOK_SECRET = "whsec_worker_fixture";
const ACTIVE_KEY = "CH-ABCD-EFGH-JKMP-QRST";

type JsonRecord = Record<string, unknown>;

function sqlStatements(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function stripeSignature(
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<string> {
  const signature = await hmacHex(WEBHOOK_SECRET, `${timestamp}.${body}`);
  return `t=${timestamp},v1=${signature}`;
}

async function invoke(request: Request): Promise<Response> {
  return worker.fetch(request, env);
}

async function postWebhook(
  event: JsonRecord,
  signatureTransform?: (header: string) => string,
): Promise<Response> {
  const body = JSON.stringify(event);
  const header = await stripeSignature(body);
  return invoke(
    new Request(`${API_ORIGIN}/stripe-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": signatureTransform?.(header) ?? header,
      },
      body,
    }),
  );
}

async function responseJson(response: Response): Promise<JsonRecord> {
  const value: unknown = await response.json();
  expect(value).toBeTypeOf("object");
  return value as JsonRecord;
}

async function seedLicense(
  key = ACTIVE_KEY,
  paymentIntentId = "pi_fixture",
  product = "cliphutch",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO licenses
       (key, email, stripe_session_id, payment_intent_id, product,
        status, created_at, email_sent_at)
     VALUES (?, 'buyer@example.test', ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(
      key,
      `cs_${paymentIntentId}`,
      paymentIntentId,
      product,
      Date.now(),
      Date.now(),
    )
    .run();
}

function refundEvent(options: {
  id: string;
  refunded: boolean;
  amountRefunded: number;
  paymentIntent?: string;
}): JsonRecord {
  return {
    id: options.id,
    type: "charge.refunded",
    data: {
      object: {
        payment_intent: options.paymentIntent ?? "pi_fixture",
        refunded: options.refunded,
        amount: 3500,
        amount_refunded: options.amountRefunded,
      },
    },
  };
}

async function validate(
  installationId: string,
  key = ACTIVE_KEY,
  path = "/validate",
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return invoke(
    new Request(`${API_ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, installationId, ...extra }),
    }),
  );
}

describe("Stripe refund handling", () => {
  it("keeps an active license active for a partial refund", async () => {
    await seedLicense();

    const response = await postWebhook(
      refundEvent({ id: "evt_partial", refunded: false, amountRefunded: 1000 }),
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      ok: true,
      partialRefund: true,
    });
    expect(
      await env.DB.prepare("SELECT status FROM licenses WHERE key = ?")
        .bind(ACTIVE_KEY)
        .first<string>("status"),
    ).toBe("active");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM license_mutation_journal")
        .first<number>("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM stripe_refund_events WHERE is_full = 0",
      ).first<number>("count"),
    ).toBe(1);
  });

  it("marks a full refund once and journals only redacted correlation", async () => {
    await seedLicense();
    const event = refundEvent({
      id: "evt_full",
      refunded: true,
      amountRefunded: 3500,
    });

    const first = await postWebhook(event);
    const replay = await postWebhook(event);

    expect(first.status).toBe(200);
    expect(await responseJson(first)).toMatchObject({ ok: true, changed: true });
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toMatchObject({
      ok: true,
      alreadyRefunded: true,
    });
    expect(
      await env.DB.prepare(
        `SELECT status, refunded_event_id, refund_amount,
                refund_amount_refunded
         FROM licenses WHERE key = ?`,
      )
        .bind(ACTIVE_KEY)
        .first(),
    ).toMatchObject({
      status: "refunded",
      refunded_event_id: "evt_full",
      refund_amount: 3500,
      refund_amount_refunded: 3500,
    });
    const journal = await env.DB.prepare(
      "SELECT * FROM license_mutation_journal",
    ).first<JsonRecord>();
    expect(journal).toMatchObject({
      source: "stripe",
      external_event_id: "evt_full",
      mutation_type: "license.refunded",
      previous_state: "active",
      next_state: "refunded",
    });
    expect(journal?.license_fingerprint).toMatch(/^[a-f\d]{64}$/);
    expect(JSON.stringify(journal)).not.toContain(ACTIVE_KEY);
    expect(JSON.stringify(journal)).not.toContain("buyer@example.test");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM license_mutation_journal",
      ).first<number>("count"),
    ).toBe(1);
  });

  it("accepts any valid v1 signature during secret rotation", async () => {
    await seedLicense();

    const response = await postWebhook(
      refundEvent({ id: "evt_rotated", refunded: false, amountRefunded: 1 }),
      (header) => header.replace("v1=", `v1=${"0".repeat(64)},v1=`),
    );

    expect(response.status).toBe(200);
  });

  it("rejects invalid signatures without mutation", async () => {
    await seedLicense();

    const response = await postWebhook(
      refundEvent({ id: "evt_bad_sig", refunded: true, amountRefunded: 3500 }),
      (header) => header.replace(/v1=[a-f\d]+/, `v1=${"0".repeat(64)}`),
    );

    expect(response.status).toBe(401);
    expect(
      await env.DB.prepare("SELECT status FROM licenses WHERE key = ?")
        .bind(ACTIVE_KEY)
        .first<string>("status"),
    ).toBe("active");
  });

  it("does not mutate for an unknown payment intent", async () => {
    await seedLicense();
    const response = await postWebhook(
      refundEvent({
        id: "evt_unknown",
        refunded: true,
        amountRefunded: 3500,
        paymentIntent: "pi_unknown",
      }),
    );

    expect(await responseJson(response)).toMatchObject({ ok: true, matched: false });
    expect(
      await env.DB.prepare("SELECT status FROM licenses WHERE key = ?")
        .bind(ACTIVE_KEY)
        .first<string>("status"),
    ).toBe("active");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM stripe_refund_events WHERE payment_intent_id = 'pi_unknown' AND is_full = 1",
      ).first<number>("count"),
    ).toBe(1);
    const unmatchedExpiry = await env.DB.prepare(
      "SELECT expires_at - observed_at AS retention_ms FROM stripe_refund_events WHERE event_id = 'evt_unknown'",
    ).first<number>("retention_ms");
    expect(unmatchedExpiry).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("rejects malformed signed full-refund fields without mutation", async () => {
    await seedLicense();
    const response = await postWebhook({
      id: "evt_malformed_refund",
      type: "charge.refunded",
      data: {
        object: {
          payment_intent: "pi_fixture",
          refunded: true,
          amount: 3500,
          amount_refunded: "3500",
        },
      },
    });

    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare("SELECT status FROM licenses WHERE key = ?")
        .bind(ACTIVE_KEY)
        .first<string>("status"),
    ).toBe("active");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM stripe_refund_events")
        .first<number>("count"),
    ).toBe(0);
  });

  it("records a cumulative partial refund before applying the full refund", async () => {
    await seedLicense();

    await postWebhook(
      refundEvent({ id: "evt_partial_then_full_1", refunded: false, amountRefunded: 1000 }),
    );
    const full = await postWebhook(
      refundEvent({ id: "evt_partial_then_full_2", refunded: true, amountRefunded: 3500 }),
    );

    expect(await responseJson(full)).toMatchObject({ ok: true, changed: true });
    expect(
      await env.DB.prepare("SELECT status FROM licenses WHERE key = ?")
        .bind(ACTIVE_KEY)
        .first<string>("status"),
    ).toBe("refunded");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM stripe_refund_events")
        .first<number>("count"),
    ).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT MIN(expires_at - observed_at) AS retention_ms FROM stripe_refund_events",
      ).first<number>("retention_ms"),
    ).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("rejects oversized webhook bodies before signature verification", async () => {
    const response = await invoke(
      new Request(`${API_ORIGIN}/stripe-webhook`, {
        method: "POST",
        headers: { "Stripe-Signature": "invalid" },
        body: "x".repeat(1024 * 1024 + 1),
      }),
    );

    expect(response.status).toBe(413);
    expect(await responseJson(response)).toMatchObject({
      ok: false,
      reason: "BAD_REQUEST",
    });
  });
});

describe("license issuance", () => {
  it("issues and journals a paid Checkout session idempotently", async () => {
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "email_fixture" }), { status: 200 }));
    const event = {
      id: "evt_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_checkout_fixture",
          payment_intent: "pi_checkout_fixture",
          customer_details: { email: "buyer@example.test" },
          metadata: { product: "cliphutch" },
          payment_status: "paid",
          payment_link: "plink_cliphutch_fixture",
        },
      },
    };

    const first = await postWebhook(event);
    const replay = await postWebhook(event);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const firstBody = await responseJson(first);
    const replayBody = await responseJson(replay);
    expect(firstBody).toEqual({ ok: true });
    expect(replayBody).toEqual({ ok: true, alreadyIssued: true });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    const providerInit = providerFetch.mock.calls[0]?.[1];
    expect(new Headers(providerInit?.headers).get("Idempotency-Key")).toMatch(
      /^license-email-[a-f\d]{64}$/,
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM licenses")
        .first<number>("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM license_mutation_journal WHERE mutation_type = 'license.issued'",
      ).first<number>("count"),
    ).toBe(1);
    const rawKey = await env.DB.prepare("SELECT key FROM licenses")
      .first<string>("key");
    expect(JSON.stringify(firstBody)).not.toContain(rawKey);
    expect(JSON.stringify(replayBody)).not.toContain(rawKey);
  });

  it("single-flights concurrent email delivery attempts", async () => {
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const event = {
      id: "evt_checkout_concurrent",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_checkout_concurrent",
          payment_intent: "pi_checkout_concurrent",
          customer_email: "buyer@example.test",
          metadata: { product: "cliphutch" },
          payment_status: "paid",
          payment_link: "plink_cliphutch_fixture",
        },
      },
    };

    const responses = await Promise.all([postWebhook(event), postWebhook(event)]);

    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT email_sent_at FROM licenses WHERE stripe_session_id = 'cs_checkout_concurrent'",
      ).first<number | null>("email_sent_at"),
    ).toBeTypeOf("number");
  });

  it("accepts the configured legacy ClipHutch Payment Link without metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );
    const response = await postWebhook({
      id: "evt_legacy_cliphutch_link",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_legacy_cliphutch_link",
          payment_intent: "pi_legacy_cliphutch_link",
          customer_email: "buyer@example.test",
          payment_status: "paid",
          payment_link: "plink_cliphutch_fixture",
        },
      },
    });

    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT product FROM licenses WHERE stripe_session_id = 'cs_legacy_cliphutch_link'",
      ).first<string>("product"),
    ).toBe("cliphutch");
  });

  it("does not issue when a full refund arrives before Checkout", async () => {
    const providerFetch = vi.spyOn(globalThis, "fetch");
    await postWebhook(
      refundEvent({
        id: "evt_refund_before_checkout",
        refunded: true,
        amountRefunded: 3500,
        paymentIntent: "pi_refund_before_checkout",
      }),
    );
    const checkout = await postWebhook({
      id: "evt_checkout_after_refund",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_checkout_after_refund",
          payment_intent: "pi_refund_before_checkout",
          customer_email: "buyer@example.test",
          metadata: { product: "cliphutch" },
          payment_status: "paid",
          payment_link: "plink_cliphutch_fixture",
        },
      },
    });

    expect(await responseJson(checkout)).toEqual({
      ok: true,
      licenseIssued: false,
      reason: "FULL_REFUND_ALREADY_RECORDED",
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM licenses")
        .first<number>("count"),
    ).toBe(0);
  });

  it.each([
    ["missing payment status", { metadata: { product: "cliphutch" } }],
    [
      "wrong ClipHutch payment link",
      {
        payment_status: "paid",
        payment_link: "plink_unrelated_fixture",
        metadata: { product: "cliphutch" },
      },
    ],
  ])("does not issue an unqualified Checkout session with %s", async (_label, extra) => {
    const providerFetch = vi.spyOn(globalThis, "fetch");
    const response = await postWebhook({
      id: `evt_unqualified_${_label.replaceAll(" ", "_")}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_unqualified_${_label.replaceAll(" ", "_")}`,
          payment_intent: `pi_unqualified_${_label.replaceAll(" ", "_")}`,
          customer_email: "buyer@example.test",
          ...extra,
        },
      },
    });

    expect(response.status).not.toBe(200);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM licenses")
        .first<number>("count"),
    ).toBe(0);
  });

  it.each([
    ["missing product", { payment_status: "paid" }],
    ["unknown product", { payment_status: "paid", metadata: { product: "other" } }],
  ])("acknowledges unrelated Checkout sessions with %s without mutation", async (_label, extra) => {
    const providerFetch = vi.spyOn(globalThis, "fetch");
    const response = await postWebhook({
      id: `evt_unrelated_${_label.replaceAll(" ", "_")}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_unrelated_${_label.replaceAll(" ", "_")}`,
          payment_intent: `pi_unrelated_${_label.replaceAll(" ", "_")}`,
          customer_email: "buyer@example.test",
          ...extra,
        },
      },
    });

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({
      ok: true,
      ignored: "UNRELATED_CHECKOUT_SOURCE",
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM licenses")
        .first<number>("count"),
    ).toBe(0);
  });

  it("requires the configured ComputedKit price marker", async () => {
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const response = await postWebhook({
      id: "evt_computedkit_checkout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_computedkit_checkout",
          payment_intent: "pi_computedkit_checkout",
          customer_email: "buyer@example.test",
          payment_status: "paid",
          payment_link: null,
          metadata: {
            product: "computedkit",
            price_id: "price_computedkit_fixture",
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT product FROM licenses WHERE stripe_session_id = 'cs_computedkit_checkout'",
      ).first<string>("product"),
    ).toBe("computedkit");
  });

  it("keeps email pending for a provider failure and succeeds on replay", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("provider unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const event = {
      id: "evt_email_retry",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_email_retry",
          payment_intent: "pi_email_retry",
          customer_email: "buyer@example.test",
          payment_status: "paid",
          metadata: { product: "cliphutch" },
          payment_link: "plink_cliphutch_fixture",
        },
      },
    };

    const first = await postWebhook(event);
    expect(first.status).toBe(500);
    expect(
      await env.DB.prepare(
        "SELECT email_sent_at FROM licenses WHERE stripe_session_id = 'cs_email_retry'",
      ).first<number | null>("email_sent_at"),
    ).toBeNull();

    const replay = await postWebhook(event);
    expect(replay.status).toBe(200);
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare(
        "SELECT email_sent_at FROM licenses WHERE stripe_session_id = 'cs_email_retry'",
      ).first<number | null>("email_sent_at"),
    ).toBeTypeOf("number");
  });

  it("never emails a pending key after its license is refunded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const providerFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("provider unavailable", { status: 503 }));
    const event = {
      id: "evt_email_then_refund",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_email_then_refund",
          payment_intent: "pi_email_then_refund",
          customer_email: "buyer@example.test",
          payment_status: "paid",
          metadata: { product: "cliphutch" },
          payment_link: "plink_cliphutch_fixture",
        },
      },
    };

    expect((await postWebhook(event)).status).toBe(500);
    expect(
      (
        await postWebhook(
          refundEvent({
            id: "evt_full_before_email_retry",
            refunded: true,
            amountRefunded: 3500,
            paymentIntent: "pi_email_then_refund",
          }),
        )
      ).status,
    ).toBe(200);

    const replay = await postWebhook(event);
    expect(replay.status).toBe(200);
    expect(await responseJson(replay)).toEqual({
      ok: true,
      emailSuppressed: true,
      reason: "LICENSE_INACTIVE",
    });
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled email request and leaves delivery pending", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    );
    const event = {
      id: "evt_email_timeout",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_email_timeout",
          payment_intent: "pi_email_timeout",
          customer_email: "buyer@example.test",
          payment_status: "paid",
          metadata: { product: "cliphutch" },
          payment_link: "plink_cliphutch_fixture",
        },
      },
    };

    const response = await postWebhook(event);

    expect(response.status).toBe(500);
    expect(
      await env.DB.prepare(
        "SELECT email_sent_at FROM licenses WHERE stripe_session_id = 'cs_email_timeout'",
      ).first<number | null>("email_sent_at"),
    ).toBeNull();
  });
});

describe("outbound checkout handling", () => {
  it("aborts a stalled Stripe request and returns a retryable gateway error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
    );

    const response = await invoke(
      new Request(`${API_ORIGIN}/computedkit/checkout`, { method: "POST" }),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("try again later");
  });
});

describe("activation admission", () => {
  it("refreshes an existing versioned activation when every device slot is full", async () => {
    await seedLicense();
    for (let index = 0; index < 5; index += 1) {
      await env.DB.prepare(
        `INSERT INTO activations
           (license_key, installation_id, activated_at, last_seen_at, created_event_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          ACTIVE_KEY,
          `existing-${index}`,
          index + 1,
          index + 1,
          `seed-${index}`,
        )
        .run();
    }

    const response = await validate(
      "existing-4",
      ACTIVE_KEY,
      "/v2/status",
    );

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({
      valid: true,
      active: true,
      maxDevices: 5,
      activationId: "seed-4",
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM activations WHERE license_key = ?",
      )
        .bind(ACTIVE_KEY)
        .first<number>("count"),
    ).toBe(5);
  });

  it("admits exactly one new device at maxDevices minus one", async () => {
    await seedLicense();
    for (let index = 0; index < 4; index += 1) {
      await env.DB.prepare(
        `INSERT INTO activations
           (license_key, installation_id, activated_at, last_seen_at, created_event_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(ACTIVE_KEY, `existing-${index}`, index + 1, index + 1, `seed-${index}`)
        .run();
    }

    const responses = await Promise.all([
      validate("new-device-a"),
      validate("new-device-b"),
    ]);
    const bodies = await Promise.all(responses.map(responseJson));

    expect(bodies.filter((body) => body.valid === true)).toHaveLength(1);
    expect(
      bodies.filter((body) => body.reason === "DEVICE_LIMIT"),
    ).toHaveLength(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM activations WHERE license_key = ?",
      )
        .bind(ACTIVE_KEY)
        .first<number>("count"),
    ).toBe(5);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM license_mutation_journal WHERE mutation_type = 'activation.created'",
      ).first<number>("count"),
    ).toBe(1);
  });

  it("treats simultaneous requests for the same new installation as valid replay", async () => {
    await seedLicense();

    const responses = await Promise.all([
      validate("same-device"),
      validate("same-device"),
    ]);
    const bodies = await Promise.all(responses.map(responseJson));

    expect(bodies).toEqual([
      expect.objectContaining({ valid: true }),
      expect.objectContaining({ valid: true }),
    ]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM activations")
        .first<number>("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM license_mutation_journal WHERE mutation_type = 'activation.created'",
      ).first<number>("count"),
    ).toBe(1);
  });

  it("bounds malformed validation request bodies", async () => {
    const response = await invoke(
      new Request(`${API_ORIGIN}/validate`, {
        method: "POST",
        body: "x".repeat(4 * 1024 + 1),
      }),
    );

    expect(response.status).toBe(413);
    expect(await responseJson(response)).toMatchObject({
      valid: false,
      reason: "BAD_REQUEST",
    });
  });
});

describe("versioned license lifecycle", () => {
  it("deactivates the exact installation and never recreates it during status", async () => {
    await seedLicense();
    const activation = await responseJson(
      await validate("device-a", ACTIVE_KEY, "/v2/activate"),
    );
    expect(activation).toMatchObject({
      valid: true,
      activationId: expect.any(String),
    });
    expect(
      await responseJson(await validate("device-a", ACTIVE_KEY, "/v2/status")),
    ).toMatchObject({ valid: true, active: true });

    const deactivation = {
      activationId: activation.activationId,
      operationId: "00000000-0000-0000-0000-000000000001",
    };
    const first = await validate(
      "device-a",
      ACTIVE_KEY,
      "/v2/deactivate",
      deactivation,
    );
    const replay = await validate(
      "device-a",
      ACTIVE_KEY,
      "/v2/deactivate",
      deactivation,
    );
    expect(await responseJson(first)).toEqual({ ok: true, active: false });
    expect(await responseJson(replay)).toEqual({ ok: true, active: false });
    expect(
      await responseJson(await validate("device-a", ACTIVE_KEY, "/v2/status")),
    ).toMatchObject({ valid: false, active: false, reason: "NOT_ACTIVATED" });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM activations")
        .first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM license_mutation_journal WHERE mutation_type = 'activation.deactivated'",
      ).first<number>("count"),
    ).toBe(1);
    const tombstone = await env.DB.prepare(
      "SELECT * FROM activation_tombstones",
    ).first<JsonRecord>();
    expect(tombstone?.license_fingerprint).toMatch(/^[a-f\d]{64}$/);
    expect(tombstone?.installation_fingerprint).toMatch(/^[a-f\d]{64}$/);
    expect(JSON.stringify(tombstone)).not.toContain(ACTIVE_KEY);
    expect(JSON.stringify(tombstone)).not.toContain("device-a");
  });

  it("returns the same idempotent result for absent and already-deleted pairs", async () => {
    await seedLicense();

    const absent = await responseJson(
      await validate("never-active", ACTIVE_KEY, "/v2/deactivate", {
        activationId: "00000000-0000-0000-0000-000000000010",
        operationId: "00000000-0000-0000-0000-000000000011",
      }),
    );
    const activation = await responseJson(
      await validate("later-deleted", ACTIVE_KEY, "/v2/activate"),
    );
    const deactivation = {
      activationId: activation.activationId,
      operationId: "00000000-0000-0000-0000-000000000012",
    };
    const deleted = await responseJson(
      await validate(
        "later-deleted",
        ACTIVE_KEY,
        "/v2/deactivate",
        deactivation,
      ),
    );
    const alreadyDeleted = await responseJson(
      await validate(
        "later-deleted",
        ACTIVE_KEY,
        "/v2/deactivate",
        deactivation,
      ),
    );

    expect(absent).toEqual({ ok: true, active: false });
    expect(deleted).toEqual(absent);
    expect(alreadyDeleted).toEqual(absent);
  });

  it("keeps every versioned route product-isolated", async () => {
    const computedKey = "CK-ABCD-EFGH-JKMP-QRST";
    await seedLicense(computedKey, "pi_computed", "computedkit");

    const wrongClipHutchRoute = await validate(
      "computed-device",
      computedKey,
      "/v2/activate",
    );
    expect(wrongClipHutchRoute.status).toBe(400);
    expect(await responseJson(wrongClipHutchRoute)).toMatchObject({
      valid: false,
      reason: "WRONG_PRODUCT",
    });

    expect(
      await responseJson(
        await validate(
          "computed-device",
          computedKey,
          "/computedkit/v2/activate",
        ),
      ),
    ).toMatchObject({ valid: true });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM activations WHERE license_key = ?",
      )
        .bind(computedKey)
        .first<number>("count"),
    ).toBe(1);
  });

  it("finishes a simultaneous status/deactivate race in the inactive state", async () => {
    await seedLicense();
    const activation = await responseJson(
      await validate("racing-device", ACTIVE_KEY, "/v2/activate"),
    );

    await Promise.all([
      validate("racing-device", ACTIVE_KEY, "/v2/status"),
      validate("racing-device", ACTIVE_KEY, "/v2/deactivate", {
        activationId: activation.activationId,
        operationId: "00000000-0000-0000-0000-000000000020",
      }),
    ]);

    expect(
      await responseJson(
        await validate("racing-device", ACTIVE_KEY, "/v2/status"),
      ),
    ).toMatchObject({ valid: false, active: false, reason: "NOT_ACTIVATED" });
  });

  it("does not let a delayed deactivation replay delete a replacement activation", async () => {
    await seedLicense();
    const firstActivation = await responseJson(
      await validate("replacement-device", ACTIVE_KEY, "/v2/activate"),
    );
    const oldDeactivation = {
      activationId: firstActivation.activationId,
      operationId: "00000000-0000-0000-0000-000000000030",
    };
    await validate(
      "replacement-device",
      ACTIVE_KEY,
      "/v2/deactivate",
      oldDeactivation,
    );

    const replacement = await responseJson(
      await validate("replacement-device", ACTIVE_KEY, "/v2/activate"),
    );
    expect(replacement.activationId).not.toBe(firstActivation.activationId);
    await validate(
      "replacement-device",
      ACTIVE_KEY,
      "/v2/deactivate",
      oldDeactivation,
    );

    expect(
      await responseJson(
        await validate("replacement-device", ACTIVE_KEY, "/v2/status"),
      ),
    ).toMatchObject({
      valid: true,
      active: true,
      activationId: replacement.activationId,
    });
  });

  it("blocks delayed legacy validation until an explicit v2 activation", async () => {
    await seedLicense();
    const activation = await responseJson(
      await validate("legacy-race", ACTIVE_KEY, "/v2/activate"),
    );
    await validate("legacy-race", ACTIVE_KEY, "/v2/deactivate", {
      activationId: activation.activationId,
      operationId: "00000000-0000-0000-0000-000000000040",
    });

    expect(
      await responseJson(await validate("legacy-race", ACTIVE_KEY, "/validate")),
    ).toMatchObject({ valid: false, reason: "NOT_ACTIVATED" });
    expect(
      await responseJson(
        await validate("legacy-race", ACTIVE_KEY, "/v2/activate"),
      ),
    ).toMatchObject({ valid: true, activationId: expect.any(String) });
  });
});

describe("version smoke metadata", () => {
  it("identifies the executing environment and Worker version", async () => {
    const response = await invoke(new Request(`${API_ORIGIN}/`));
    const body = await responseJson(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, service: "cliphutch-api", environment: "test" });
    expect(body.version).toEqual(
      expect.objectContaining({ id: expect.any(String), tag: expect.any(String) }),
    );
  });
});

describe("route-scoped CORS and methods", () => {
  const clipHutchOrigin =
    "chrome-extension://pdpcameeghhppjbhecolnhdepceeldhl";
  const computedKitOrigin =
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("echoes only the configured extension origin on license routes", async () => {
    const allowed = await invoke(
      new Request(`${API_ORIGIN}/v2/status`, {
        method: "POST",
        headers: {
          Origin: clipHutchOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: ACTIVE_KEY, installationId: "device" }),
      }),
    );
    const unknown = await invoke(
      new Request(`${API_ORIGIN}/v2/status`, {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: ACTIVE_KEY, installationId: "device" }),
      }),
    );
    const computed = await invoke(
      new Request(`${API_ORIGIN}/computedkit/v2/status`, {
        method: "POST",
        headers: {
          Origin: computedKitOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          key: "CK-ABCD-EFGH-JKMP-QRST",
          installationId: "device",
        }),
      }),
    );

    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(
      clipHutchOrigin,
    );
    expect(allowed.headers.get("Vary")).toBe("Origin");
    expect(unknown.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(unknown.headers.get("Vary")).toBe("Origin");
    expect(computed.headers.get("Access-Control-Allow-Origin")).toBe(
      computedKitOrigin,
    );
  });

  it("limits preflight to the route method and approved checkout origin", async () => {
    const response = await invoke(
      new Request(`${API_ORIGIN}/computedkit/checkout`, {
        method: "OPTIONS",
        headers: { Origin: "https://cliphutch.com" },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://cliphutch.com",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "POST, OPTIONS",
    );
  });

  it("returns 405 for a known route without widening its CORS policy", async () => {
    const response = await invoke(
      new Request(`${API_ORIGIN}/validate`, {
        method: "GET",
        headers: { Origin: "https://attacker.example" },
      }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });

  it("emits no CORS headers on health or Stripe webhook responses", async () => {
    const health = await invoke(
      new Request(`${API_ORIGIN}/`, {
        headers: { Origin: clipHutchOrigin },
      }),
    );
    const webhook = await invoke(
      new Request(`${API_ORIGIN}/stripe-webhook`, {
        method: "POST",
        headers: { Origin: clipHutchOrigin },
        body: "{}",
      }),
    );

    expect(health.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(health.headers.has("Vary")).toBe(false);
    expect(webhook.status).toBe(401);
    expect(webhook.headers.has("Access-Control-Allow-Origin")).toBe(false);
  });
});

describe("database failure handling", () => {
  it("returns a structured transient validation failure without logging identifiers", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await env.DB.prepare("DROP TABLE activations").run();

    const response = await validate("sensitive-installation", ACTIVE_KEY, "/v2/status");

    expect(response.status).toBe(503);
    expect(await responseJson(response)).toEqual({
      valid: false,
      reason: "SERVICE_UNAVAILABLE",
    });
    const emitted = JSON.stringify(log.mock.calls);
    expect(emitted).not.toContain(ACTIVE_KEY);
    expect(emitted).not.toContain("sensitive-installation");
  });

  it("returns 500 for a signed webhook D1 failure so Stripe retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await env.DB.prepare("DROP TABLE licenses").run();

    const response = await postWebhook(
      refundEvent({ id: "evt_d1_failure", refunded: true, amountRefunded: 3500 }),
    );

    expect(response.status).toBe(500);
  });
});

describe("operational data retention", () => {
  it("removes expired journal rows while retaining current entries", async () => {
    await seedLicense();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO license_mutation_journal
           (source, external_event_id, license_fingerprint,
            installation_fingerprint, mutation_type, previous_state,
            next_state, occurred_at, expires_at, metadata_json)
         VALUES ('test', 'evt_expired', ?, NULL, 'test.expired', NULL,
                 NULL, ?, ?, '{}')`,
      ).bind("a".repeat(64), now - 2, now - 1),
      env.DB.prepare(
        `INSERT INTO license_mutation_journal
           (source, external_event_id, license_fingerprint,
            installation_fingerprint, mutation_type, previous_state,
            next_state, occurred_at, expires_at, metadata_json)
         VALUES ('test', 'evt_current', ?, NULL, 'test.current', NULL,
                 NULL, ?, ?, '{}')`,
      ).bind("b".repeat(64), now, now + 10_000),
      env.DB.prepare(
        `INSERT INTO stripe_refund_events
           (event_id, payment_intent_id, is_full, amount, amount_refunded,
            observed_at, applied_at, expires_at)
         VALUES ('refund_expired', 'pi_expired', 0, 3500, 1, ?, ?, ?)`,
      ).bind(now - 2, now - 2, now - 1),
      env.DB.prepare(
        `INSERT INTO stripe_refund_events
           (event_id, payment_intent_id, is_full, amount, amount_refunded,
            observed_at, applied_at, expires_at)
         VALUES ('refund_current', 'pi_current', 0, 3500, 1, ?, ?, ?)`,
      ).bind(now, now, now + 10_000),
    ]);

    const response = await validate("retention-device", ACTIVE_KEY, "/v2/status");

    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM license_mutation_journal",
      ).first<number>("count"),
    ).toBe(2);

    await worker.scheduled(
      { scheduledTime: now, cron: "17 3 * * *", noRetry() {} },
      env,
    );

    expect(
      await env.DB.prepare(
        "SELECT external_event_id FROM license_mutation_journal ORDER BY external_event_id",
      ).all<{ external_event_id: string }>(),
    ).toMatchObject({ results: [{ external_event_id: "evt_current" }] });
    expect(
      await env.DB.prepare(
        "SELECT event_id FROM stripe_refund_events ORDER BY event_id",
      ).all<{ event_id: string }>(),
    ).toMatchObject({ results: [{ event_id: "refund_current" }] });
  });
});

describe("production migration compatibility", () => {
  it("builds a populated database from the baseline through migrations 0001-0004", async () => {
    await env.DB.batch([
      env.DB.prepare("DROP TABLE IF EXISTS license_mutation_journal"),
      env.DB.prepare("DROP TABLE IF EXISTS stripe_refund_events"),
      env.DB.prepare("DROP TABLE IF EXISTS activation_tombstones"),
      env.DB.prepare("DROP TABLE IF EXISTS activations"),
      env.DB.prepare("DROP TABLE IF EXISTS licenses"),
    ]);
    await env.DB.batch(
      sqlStatements(env.TEST_SCHEMA_BASE).map((statement) =>
        env.DB.prepare(statement),
      ),
    );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO licenses
           (key, email, stripe_session_id, payment_intent_id,
            status, created_at)
         VALUES (?, 'buyer@example.test', 'cs_before_0001', 'pi_before_0001',
                 'active', 1)`,
      ).bind(ACTIVE_KEY),
      env.DB.prepare(
        `INSERT INTO activations
           (license_key, installation_id, activated_at, last_seen_at)
         VALUES (?, 'existing-device', 1, 1)`,
      ).bind(ACTIVE_KEY),
    ]);

    for (const migration of [
      env.TEST_MIGRATION_0001,
      env.TEST_MIGRATION_0002,
      env.TEST_MIGRATION_0003,
      env.TEST_MIGRATION_0004,
    ]) {
      await env.DB.batch(
        sqlStatements(migration).map((statement) => env.DB.prepare(statement)),
      );
    }

    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM licenses")
        .first<number>("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM activations")
        .first<number>("count"),
    ).toBe(1);
    const licenseColumns = await env.DB.prepare("PRAGMA table_info(licenses)")
      .all<{ name: string }>();
    const activationColumns = await env.DB.prepare("PRAGMA table_info(activations)")
      .all<{ name: string }>();
    expect(licenseColumns.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "refunded_event_id",
        "refund_amount",
        "refund_amount_refunded",
        "email_sent_at",
        "email_delivery_key",
        "email_delivery_claimed_at",
      ]),
    );
    expect(activationColumns.results.map(({ name }) => name)).toContain(
      "created_event_id",
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM license_mutation_journal",
      ).first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT email_sent_at FROM licenses WHERE key = ?",
      )
        .bind(ACTIVE_KEY)
        .first<number>("email_sent_at"),
    ).toBe(1);
    for (const table of [
      "license_mutation_journal",
      "stripe_refund_events",
      "activation_tombstones",
    ]) {
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
          .bind(table)
          .first<number>("count"),
      ).toBe(1);
    }
    const refundEventColumns = await env.DB.prepare(
      "PRAGMA table_info(stripe_refund_events)",
    ).all<{ name: string }>();
    expect(refundEventColumns.results.map(({ name }) => name)).toContain(
      "expires_at",
    );
  });
});
