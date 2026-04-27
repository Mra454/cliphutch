// Stripe webhook signature verification using Web Crypto.
//
// Stripe sends the signature in the `Stripe-Signature` header as:
//   t=<unix-timestamp>,v1=<hex-hmac-sha256>
//
// To verify: HMAC-SHA256(`${t}.${rawBody}`, webhookSecret) and constant-time
// compare against v1. Also reject if the timestamp is older than 5 minutes
// (replay window).

const REPLAY_WINDOW_SECONDS = 300;

export type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

function parseSignatureHeader(header: string): { t: string; v1: string } | null {
  const parts = header.split(",");
  let t: string | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const [k, v] = part.split("=");
    if (k === "t") t = v;
    else if (k === "v1") v1 = v;
  }
  if (!t || !v1) return null;
  return { t, v1 };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!signatureHeader) return false;
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const ts = Number.parseInt(parsed.t, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) return false;

  const expected = await hmacHex(secret, `${parsed.t}.${rawBody}`);
  return constantTimeEqual(expected, parsed.v1);
}
