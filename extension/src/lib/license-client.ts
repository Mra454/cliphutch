import type {
  ActivateResult,
  DeactivateResult,
  RevalidateResult,
} from "./license";

type LicenseRuntimeResponse =
  | ActivateResult
  | DeactivateResult
  | RevalidateResult
  | { ok: true };

async function sendLicenseCommand(
  message: Record<string, unknown>,
): Promise<LicenseRuntimeResponse> {
  return (await chrome.runtime.sendMessage(message)) as LicenseRuntimeResponse;
}

export async function activateLicense(key: string): Promise<ActivateResult> {
  try {
    const response = await sendLicenseCommand({ type: "license-activate", key });
    if ("ok" in response && typeof response.ok === "boolean") {
      return response as ActivateResult;
    }
  } catch {
    // The background service worker may be restarting. The customer can retry
    // without risking a second browser identity because generation happens in
    // that single background context.
  }
  return {
    ok: false,
    error: "ClipHutch could not reach its background service. Try again.",
  };
}

export async function deactivateLicense(): Promise<DeactivateResult> {
  try {
    const response = await sendLicenseCommand({ type: "license-deactivate" });
    if ("ok" in response && typeof response.ok === "boolean") {
      return response as DeactivateResult;
    }
  } catch {
    // Preserve the local key and server slot on an ambiguous background start.
  }
  return {
    ok: false,
    error: "ClipHutch could not reach its background service. Try again.",
    canRemoveLocally: true,
  };
}

export async function revalidateIfStale(): Promise<RevalidateResult> {
  try {
    const response = await sendLicenseCommand({ type: "license-revalidate" });
    if ("status" in response && typeof response.status === "string") {
      return response as RevalidateResult;
    }
  } catch {
    // A failed refresh must never remove a cached entitlement.
  }
  return { status: "transient" };
}

export async function removeLicenseLocally(): Promise<void> {
  const response = await sendLicenseCommand({ type: "license-remove-local" });
  if (!("ok" in response) || response.ok !== true) {
    throw new Error("ClipHutch could not remove the local key. Try again.");
  }
}
