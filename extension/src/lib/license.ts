import { REVALIDATION_INTERVAL_MS, VALIDATE_URL } from "./constants";

const LICENSE_KEY = "license";
const INSTALLATION_ID_KEY = "installation-id";

export const LICENSE_KEY_PATTERN = /^CH-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
export const LICENSE_FORMAT_HINT = "CH-XXXX-XXXX-XXXX-XXXX";

export type LicenseState = {
  key?: string;
  activatedAt?: number;
  lastValidatedAt?: number;
};

export type ActivateResult =
  | { ok: true }
  | { ok: false; error: string };

type ValidateResponse =
  | { valid: true; maxDevices: number }
  | { valid: false; reason: string; maxDevices?: number };

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

export async function getInstallationId(): Promise<string> {
  const result = await chrome.storage.local.get(INSTALLATION_ID_KEY);
  const stored = result[INSTALLATION_ID_KEY];
  if (typeof stored === "string" && stored.length > 0) return stored;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALLATION_ID_KEY]: id });
  return id;
}

function humanizeReason(reason: string | undefined, maxDevices?: number): string {
  switch (reason) {
    case "NOT_FOUND":
      return "License key not found. Check that you copied it correctly from your purchase email.";
    case "REFUNDED":
      return "This license has been refunded.";
    case "REVOKED":
      return "This license has been revoked.";
    case "DEVICE_LIMIT":
      return `This license is already activated on ${maxDevices ?? 5} devices. Deactivate it on one of them or contact support.`;
    case "BAD_REQUEST":
      return "The license server rejected the request.";
    default:
      return reason ? `License invalid (${reason}).` : "License invalid.";
  }
}

async function callValidate(key: string, installationId: string): Promise<ValidateResponse | { networkError: true; message: string }> {
  let response: Response;
  try {
    response = await fetch(VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, installationId }),
    });
  } catch (err) {
    return {
      networkError: true,
      message: err instanceof Error ? err.message : "network error",
    };
  }
  try {
    return (await response.json()) as ValidateResponse;
  } catch {
    return { networkError: true, message: "invalid server response" };
  }
}

export async function activateLicense(key: string): Promise<ActivateResult> {
  const normalized = normalizeKey(key);
  if (!isValidKeyFormat(normalized)) {
    return {
      ok: false,
      error: `Invalid license key format. Expected: ${LICENSE_FORMAT_HINT}`,
    };
  }

  const installationId = await getInstallationId();
  const result = await callValidate(normalized, installationId);

  if ("networkError" in result) {
    return {
      ok: false,
      error: "Could not reach the license server. Check your connection and try again.",
    };
  }

  if (!result.valid) {
    return { ok: false, error: humanizeReason(result.reason, result.maxDevices) };
  }

  const now = Date.now();
  await chrome.storage.local.set({
    [LICENSE_KEY]: {
      key: normalized,
      activatedAt: now,
      lastValidatedAt: now,
    } satisfies LicenseState,
  });
  return { ok: true };
}

export async function deactivateLicense(): Promise<void> {
  await chrome.storage.local.remove(LICENSE_KEY);
}

export type RevalidateResult =
  | { status: "skipped" }
  | { status: "ok" }
  | { status: "deactivated"; reason: string }
  | { status: "transient" };

// Called periodically (e.g., when popup opens) to re-check the license against
// the server. If the server returns a definitive negative (REFUNDED, REVOKED,
// NOT_FOUND), the local license is removed. Network errors are silent and
// leave the cached license in place.
export async function revalidateIfStale(now: number = Date.now()): Promise<RevalidateResult> {
  const license = await getLicense();
  if (!license.key) return { status: "skipped" };
  if (license.lastValidatedAt && now - license.lastValidatedAt < REVALIDATION_INTERVAL_MS) {
    return { status: "skipped" };
  }

  const installationId = await getInstallationId();
  const result = await callValidate(license.key, installationId);

  if ("networkError" in result) return { status: "transient" };

  if (result.valid) {
    await chrome.storage.local.set({
      [LICENSE_KEY]: { ...license, lastValidatedAt: now } satisfies LicenseState,
    });
    return { status: "ok" };
  }

  // Definitive negatives → deactivate. Other reasons (BAD_REQUEST, DEVICE_LIMIT
  // for an already-activated install) leave the license in place.
  if (result.reason === "NOT_FOUND" || result.reason === "REFUNDED" || result.reason === "REVOKED") {
    await deactivateLicense();
    return { status: "deactivated", reason: result.reason };
  }
  return { status: "transient" };
}
