// Alphabet excludes I, L, O, 0, 1 to avoid lookalikes.
// 31 chars: 23 letters + 8 digits. Each 4-char group → ~19.8 bits.
// Total entropy across 4 groups: ~79 bits — fine for licensing.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const LICENSE_PRODUCTS = ["cliphutch", "computedkit"] as const;
export type LicenseProduct = (typeof LICENSE_PRODUCTS)[number];

const PREFIX_BY_PRODUCT: Record<LicenseProduct, string> = {
  cliphutch: "CH",
  computedkit: "CK",
};

export const LICENSE_KEY_PATTERN = /^(?:CH|CK)-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function randomGroup(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let group = "";
  for (let i = 0; i < 4; i++) {
    group += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return group;
}

export function generateLicenseKey(product: LicenseProduct = "cliphutch"): string {
  return `${PREFIX_BY_PRODUCT[product]}-${randomGroup()}-${randomGroup()}-${randomGroup()}-${randomGroup()}`;
}

export function normalizeKey(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidKeyFormat(key: string, product?: LicenseProduct): boolean {
  const normalized = normalizeKey(key);
  if (!LICENSE_KEY_PATTERN.test(normalized)) return false;
  return product ? normalized.startsWith(`${PREFIX_BY_PRODUCT[product]}-`) : true;
}
