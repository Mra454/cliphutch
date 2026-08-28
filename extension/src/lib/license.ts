import {
  LICENSE_ACTIVATE_URL,
  LICENSE_DEACTIVATE_URL,
  LICENSE_STATUS_URL,
  REVALIDATION_INTERVAL_MS,
} from "./constants";

const LICENSE_KEY = "license";
const LICENSE_NOTICE_KEY = "license-notice";
const INSTALLATION_ID_KEY = "installation-id";
const LICENSE_REQUEST_TIMEOUT_MS = 10_000;
const MAX_LICENSE_RESPONSE_BYTES = 4 * 1024;
const LICENSE_RETRY_INTERVAL_MS = 60 * 60 * 1000;

export const LICENSE_KEY_PATTERN =
  /^CH-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const LICENSE_FORMAT_HINT = "CH-XXXX-XXXX-XXXX-XXXX";

export type LicenseState = {
  key?: string;
  activatedAt?: number;
  lastValidatedAt?: number;
  lastValidationAttemptAt?: number;
  activationId?: string;
  pendingDeactivationId?: string;
};

export type LicenseNotice = {
  reason: "NOT_FOUND" | "REFUNDED" | "REVOKED" | "NOT_ACTIVATED";
  message: string;
  createdAt: number;
};

export type ActivateResult =
  | { ok: true }
  | { ok: false; error: string };

export type DeactivateResult =
  | { ok: true }
  | { ok: false; error: string; canRemoveLocally: true };

type KnownReason =
  | "NOT_FOUND"
  | "REFUNDED"
  | "REVOKED"
  | "DEVICE_LIMIT"
  | "BAD_REQUEST"
  | "WRONG_PRODUCT"
  | "NOT_ACTIVATED"
  | "SERVICE_UNAVAILABLE";

type ValidationResponse =
  | { valid: true; active?: true; maxDevices: number; activationId?: string }
  | { valid: false; active?: false; reason: KnownReason; maxDevices?: number };

type EndpointResult =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; message: string };

const KNOWN_REASONS: ReadonlySet<string> = new Set<KnownReason>([
  "NOT_FOUND",
  "REFUNDED",
  "REVOKED",
  "DEVICE_LIMIT",
  "BAD_REQUEST",
  "WRONG_PRODUCT",
  "NOT_ACTIVATED",
  "SERVICE_UNAVAILABLE",
]);

let installationIdInitialization: Promise<string> | null = null;
let licenseOperationTail: Promise<void> = Promise.resolve();

export function normalizeKey(input: string): string {
  return input.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidKeyFormat(key: string): boolean {
  return LICENSE_KEY_PATTERN.test(normalizeKey(key));
}

export async function getLicense(): Promise<LicenseState> {
  const result = await chrome.storage.local.get(LICENSE_KEY);
  const stored = result[LICENSE_KEY];
  if (!stored || typeof stored !== "object") return {};
  const record = stored as Record<string, unknown>;
  if (typeof record.key !== "string" || !isValidKeyFormat(record.key)) {
    return {};
  }
  const state: LicenseState = { key: normalizeKey(record.key) };
  for (const field of [
    "activatedAt",
    "lastValidatedAt",
    "lastValidationAttemptAt",
  ] as const) {
    const value = record[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      state[field] = value;
    }
  }
  if (typeof record.activationId === "string" && UUID_PATTERN.test(record.activationId)) {
    state.activationId = record.activationId;
  }
  if (
    typeof record.pendingDeactivationId === "string" &&
    UUID_PATTERN.test(record.pendingDeactivationId)
  ) {
    state.pendingDeactivationId = record.pendingDeactivationId;
  }
  return state;
}

export async function isLicensed(): Promise<boolean> {
  const license = await getLicense();
  return Boolean(license.key);
}

async function initializeInstallationId(): Promise<string> {
  const result = await chrome.storage.local.get(INSTALLATION_ID_KEY);
  const stored = result[INSTALLATION_ID_KEY];
  if (typeof stored === "string" && UUID_PATTERN.test(stored)) return stored;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTALLATION_ID_KEY]: id });
  return id;
}

export function getInstallationId(): Promise<string> {
  if (installationIdInitialization !== null) {
    return installationIdInitialization;
  }
  installationIdInitialization = initializeInstallationId().finally(() => {
    installationIdInitialization = null;
  });
  return installationIdInitialization;
}

async function withLicenseOperation<T>(operation: () => Promise<T>): Promise<T> {
  const previous = licenseOperationTail;
  let release: (() => void) | undefined;
  licenseOperationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
  }
}

function humanizeReason(reason: KnownReason | undefined, maxDevices?: number): string {
  switch (reason) {
    case "NOT_FOUND":
      return "License key not found. Check that you copied it correctly from your purchase email.";
    case "REFUNDED":
      return "This license has been refunded.";
    case "REVOKED":
      return "This license has been revoked.";
    case "DEVICE_LIMIT":
      return `This license is already activated on ${maxDevices ?? 5} devices. Deactivate it on one of them or contact support.`;
    case "WRONG_PRODUCT":
      return "This key belongs to a different product.";
    case "NOT_ACTIVATED":
      return "This browser is no longer activated for this license.";
    case "SERVICE_UNAVAILABLE":
      return "The license service is temporarily unavailable. Try again later.";
    case "BAD_REQUEST":
      return "The license server rejected the request.";
    default:
      return "The license server returned an unsupported response.";
  }
}

function removalMessage(reason: LicenseNotice["reason"]): string {
  if (reason === "NOT_ACTIVATED") {
    return "This browser is no longer activated, so ClipHutch returned to the free tier. Open Options to activate this browser again, or contact support if you expected the device slot to remain active.";
  }
  return `${humanizeReason(reason)} ClipHutch returned to the free tier. Open Options to review the license or contact support.`;
}

async function readBoundedJson(
  response: Response,
): Promise<Record<string, unknown> | null> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) return null;

  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_LICENSE_RESPONSE_BYTES) {
      return null;
    }
  }
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_LICENSE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

async function callEndpoint(
  url: string,
  key: string,
  installationId: string,
  extra: Record<string, string> = {},
): Promise<EndpointResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LICENSE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, installationId, ...extra }),
      signal: controller.signal,
    });
    const body = await readBoundedJson(response);
    if (body === null) {
      return { ok: false, message: "The license server returned an invalid response." };
    }
    return { ok: true, status: response.status, body };
  } catch {
    return {
      ok: false,
      message: "Could not reach the license server. Check your connection and try again.",
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseValidationResponse(
  body: Record<string, unknown>,
): ValidationResponse | null {
  if (body.valid === true) {
    const maxDevices = body.maxDevices;
    const activationId = body.activationId;
    if (
      typeof maxDevices !== "number" ||
      !Number.isSafeInteger(maxDevices) ||
      maxDevices < 1 ||
      maxDevices > 100 ||
      (body.active !== undefined && body.active !== true) ||
      (activationId !== undefined &&
        (typeof activationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            activationId,
          )))
    ) {
      return null;
    }
    return {
      valid: true,
      ...(body.active === true ? { active: true as const } : {}),
      maxDevices,
      ...(typeof activationId === "string" ? { activationId } : {}),
    };
  }
  if (
    body.valid === false &&
    typeof body.reason === "string" &&
    KNOWN_REASONS.has(body.reason) &&
    (body.active === undefined || body.active === false) &&
    (body.maxDevices === undefined ||
      (typeof body.maxDevices === "number" &&
        Number.isSafeInteger(body.maxDevices) &&
        body.maxDevices >= 1 &&
        body.maxDevices <= 100))
  ) {
    return {
      valid: false,
      ...(body.active === false ? { active: false as const } : {}),
      reason: body.reason as KnownReason,
      ...(typeof body.maxDevices === "number"
        ? { maxDevices: body.maxDevices }
        : {}),
    };
  }
  return null;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function clearLocalLicense(notice?: LicenseNotice): Promise<void> {
  if (notice) {
    await chrome.storage.local.set({
      [LICENSE_KEY]: {} satisfies LicenseState,
      [LICENSE_NOTICE_KEY]: notice,
    });
    return;
  }
  await chrome.storage.local.set({ [LICENSE_KEY]: {} satisfies LicenseState });
  await chrome.storage.local.remove(LICENSE_NOTICE_KEY);
}

export async function getLicenseNotice(): Promise<LicenseNotice | null> {
  const result = await chrome.storage.local.get(LICENSE_NOTICE_KEY);
  const stored = result[LICENSE_NOTICE_KEY];
  if (typeof stored !== "object" || stored === null) return null;
  const notice = stored as Partial<LicenseNotice>;
  if (
    (notice.reason !== "NOT_FOUND" &&
      notice.reason !== "REFUNDED" &&
      notice.reason !== "REVOKED" &&
      notice.reason !== "NOT_ACTIVATED") ||
    typeof notice.message !== "string" ||
    typeof notice.createdAt !== "number"
  ) {
    return null;
  }
  return notice as LicenseNotice;
}

export async function dismissLicenseNotice(): Promise<void> {
  await chrome.storage.local.remove(LICENSE_NOTICE_KEY);
}

export async function activateLicense(key: string): Promise<ActivateResult> {
  const normalized = normalizeKey(key);
  if (!isValidKeyFormat(normalized)) {
    return {
      ok: false,
      error: `Invalid license key format. Expected: ${LICENSE_FORMAT_HINT}`,
    };
  }

  return withLicenseOperation(async () => {
    const existing = await getLicense();
    if (existing.key === normalized && existing.activationId) return { ok: true };
    if (existing.key && existing.key !== normalized) {
      return {
        ok: false,
        error: "Deactivate the current license before activating a different key on this browser.",
      };
    }
    const installationId = await getInstallationId();
    const endpoint = await callEndpoint(
      LICENSE_ACTIVATE_URL,
      normalized,
      installationId,
    );
    if (!endpoint.ok) return { ok: false, error: endpoint.message };
    const result = parseValidationResponse(endpoint.body);
    if (result === null || isTransientStatus(endpoint.status)) {
      return {
        ok: false,
        error:
          result?.valid === false
            ? humanizeReason(result.reason, result.maxDevices)
            : "The license service is temporarily unavailable. Try again later.",
      };
    }
    if (!result.valid) {
      return {
        ok: false,
        error: humanizeReason(result.reason, result.maxDevices),
      };
    }
    if (endpoint.status < 200 || endpoint.status >= 300) {
      return {
        ok: false,
        error: "The license server rejected the activation request.",
      };
    }
    if (!result.activationId) {
      return {
        ok: false,
        error: "The license server returned an invalid activation response.",
      };
    }

    const now = Date.now();
    await chrome.storage.local.set({
      [LICENSE_KEY]: {
        key: normalized,
        activatedAt: now,
        lastValidatedAt: now,
        lastValidationAttemptAt: now,
        activationId: result.activationId,
      } satisfies LicenseState,
    });
    await chrome.storage.local.remove(LICENSE_NOTICE_KEY);
    return { ok: true };
  });
}

export async function deactivateLicense(): Promise<DeactivateResult> {
  return withLicenseOperation(async () => {
    let license = await getLicense();
    if (!license.key) return { ok: true };
    const licenseKey = license.key;
    const installationId = await getInstallationId();

    if (!license.activationId) {
      const statusEndpoint = await callEndpoint(
        LICENSE_STATUS_URL,
        licenseKey,
        installationId,
      );
      if (!statusEndpoint.ok || isTransientStatus(statusEndpoint.status)) {
        return {
          ok: false,
          error: statusEndpoint.ok
            ? "ClipHutch could not confirm this browser's current activation. Try again while online."
            : statusEndpoint.message,
          canRemoveLocally: true,
        };
      }
      const status = parseValidationResponse(statusEndpoint.body);
      if (
        status === null ||
        statusEndpoint.status < 200 ||
        statusEndpoint.status >= 300
      ) {
        return {
          ok: false,
          error: "ClipHutch could not confirm this browser's current activation. Try again while online.",
          canRemoveLocally: true,
        };
      }
      if (!status.valid) {
        if (
          status.reason === "NOT_ACTIVATED" ||
          status.reason === "NOT_FOUND" ||
          status.reason === "REFUNDED" ||
          status.reason === "REVOKED"
        ) {
          await clearLocalLicense();
          return { ok: true };
        }
        return {
          ok: false,
          error: humanizeReason(status.reason, status.maxDevices),
          canRemoveLocally: true,
        };
      }
      if (status.active !== true || !status.activationId) {
        return {
          ok: false,
          error: "ClipHutch could not confirm this browser's current activation. Try again while online.",
          canRemoveLocally: true,
        };
      }
      license = { ...license, activationId: status.activationId };
      await chrome.storage.local.set({ [LICENSE_KEY]: license });
    }

    const operationId = license.pendingDeactivationId ?? crypto.randomUUID();
    if (!license.pendingDeactivationId) {
      license = { ...license, pendingDeactivationId: operationId };
      await chrome.storage.local.set({ [LICENSE_KEY]: license });
    }
    const activationId = license.activationId;
    if (!activationId) {
      return {
        ok: false,
        error: "ClipHutch could not confirm this browser's current activation. Try again while online.",
        canRemoveLocally: true,
      };
    }
    const endpoint = await callEndpoint(
      LICENSE_DEACTIVATE_URL,
      licenseKey,
      installationId,
      { activationId, operationId },
    );
    if (
      !endpoint.ok ||
      isTransientStatus(endpoint.status) ||
      endpoint.status < 200 ||
      endpoint.status >= 300 ||
      endpoint.body.ok !== true ||
      endpoint.body.active !== false
    ) {
      return {
        ok: false,
        error: endpoint.ok
          ? "ClipHutch could not confirm that this device slot was freed. Try again while online."
          : endpoint.message,
        canRemoveLocally: true,
      };
    }
    await clearLocalLicense();
    return { ok: true };
  });
}

export async function removeLicenseLocally(): Promise<void> {
  await withLicenseOperation(() => clearLocalLicense());
}

export type RevalidateResult =
  | { status: "skipped" }
  | { status: "ok" }
  | { status: "deactivated"; reason: string; message: string }
  | { status: "transient" };

// Called periodically (for example, when the popup opens) to refresh only an
// already-active installation. This endpoint never creates a new device slot.
export async function revalidateIfStale(
  now: number = Date.now(),
): Promise<RevalidateResult> {
  return withLicenseOperation(async () => {
    const license = await getLicense();
    if (!license.key) return { status: "skipped" };
    if (
      license.lastValidatedAt !== undefined &&
      license.lastValidatedAt <= now &&
      now - license.lastValidatedAt < REVALIDATION_INTERVAL_MS
    ) {
      return { status: "skipped" };
    }
    if (
      license.lastValidationAttemptAt !== undefined &&
      license.lastValidationAttemptAt <= now &&
      now - license.lastValidationAttemptAt < LICENSE_RETRY_INTERVAL_MS
    ) {
      return { status: "skipped" };
    }

    await chrome.storage.local.set({
      [LICENSE_KEY]: {
        ...license,
        lastValidationAttemptAt: now,
      } satisfies LicenseState,
    });

    const installationId = await getInstallationId();
    const endpoint = await callEndpoint(
      LICENSE_STATUS_URL,
      license.key,
      installationId,
    );
    if (!endpoint.ok || isTransientStatus(endpoint.status)) {
      return { status: "transient" };
    }
    const result = parseValidationResponse(endpoint.body);
    if (result === null || endpoint.status < 200 || endpoint.status >= 300) {
      return { status: "transient" };
    }
    if (result.valid && result.active === true) {
      if (!result.activationId) return { status: "transient" };
      await chrome.storage.local.set({
        [LICENSE_KEY]: {
          ...license,
          lastValidatedAt: now,
          lastValidationAttemptAt: now,
          activationId: result.activationId,
          pendingDeactivationId: undefined,
        } satisfies LicenseState,
      });
      return { status: "ok" };
    }

    if (
      !result.valid &&
      (result.reason === "NOT_FOUND" ||
        result.reason === "REFUNDED" ||
        result.reason === "REVOKED" ||
        result.reason === "NOT_ACTIVATED")
    ) {
      const reason = result.reason;
      const message = removalMessage(reason);
      await clearLocalLicense({ reason, message, createdAt: now });
      return { status: "deactivated", reason, message };
    }
    return { status: "transient" };
  });
}
