const LICENSE_KEY = "license";

export const LICENSE_KEY_PATTERN = /^VA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const LICENSE_FORMAT_HINT = "VA-XXXX-XXXX-XXXX-XXXX";

export type LicenseState = {
  key?: string;
  activatedAt?: number;
};

export type ActivateResult =
  | { ok: true }
  | { ok: false; error: string };

export function normalizeKey(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidKeyFormat(key: string): boolean {
  return LICENSE_KEY_PATTERN.test(normalizeKey(key));
}

export async function getLicense(): Promise<LicenseState> {
  const result = await chrome.storage.local.get(LICENSE_KEY);
  const stored = result[LICENSE_KEY];
  return stored && typeof stored === "object" ? (stored as LicenseState) : {};
}

export async function isLicensed(): Promise<boolean> {
  const license = await getLicense();
  return Boolean(license.key);
}

export async function activateLicense(key: string): Promise<ActivateResult> {
  const normalized = normalizeKey(key);
  if (!isValidKeyFormat(normalized)) {
    return {
      ok: false,
      error: `Invalid license key format. Expected: ${LICENSE_FORMAT_HINT}`,
    };
  }
  // Phase 1 stub: any well-formed key activates. Phase 3 wires this to the
  // Cloudflare Worker validator.
  await chrome.storage.local.set({
    [LICENSE_KEY]: { key: normalized, activatedAt: Date.now() } satisfies LicenseState,
  });
  return { ok: true };
}

export async function deactivateLicense(): Promise<void> {
  await chrome.storage.local.remove(LICENSE_KEY);
}
