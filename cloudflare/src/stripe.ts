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

function parseSignatureHeader(
  header: string,
): { t: string; v1: readonly string[] } | null {
  const parts = header.split(",");
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && value) t = value;
    else if (key === "v1" && value) v1.push(value);
  }
  if (!t || v1.length === 0) return null;
  return { t, v1 };
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^[a-f\d]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function hmacBytes(key: string, message: string): Promise<Uint8Array> {
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
  return new Uint8Array(sig);
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

  const expected = await hmacBytes(secret, `${parsed.t}.${rawBody}`);
  let valid = false;
  for (const candidate of parsed.v1) {
    const bytes = hexBytes(candidate);
    if (bytes !== null && crypto.subtle.timingSafeEqual(expected, bytes)) {
      valid = true;
    }
  }
  return valid;
}
