import {
  activateLicense,
  deactivateLicense,
  removeLicenseLocally,
  revalidateIfStale,
} from "./license";

export type LicenseRuntimeMessage =
  | { type: "license-activate"; key: string }
  | { type: "license-deactivate" }
  | { type: "license-revalidate" }
  | { type: "license-remove-local" };

export function isLicenseRuntimeMessage(
  value: unknown,
): value is LicenseRuntimeMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as { type?: unknown; key?: unknown };
  if (record.type === "license-activate") {
    return typeof record.key === "string" && record.key.length <= 128;
  }
  return (
    record.type === "license-deactivate" ||
    record.type === "license-revalidate" ||
    record.type === "license-remove-local"
  );
}

export async function handleLicenseRuntimeMessage(
  message: LicenseRuntimeMessage,
): Promise<unknown> {
  switch (message.type) {
    case "license-activate":
      return activateLicense(message.key);
    case "license-deactivate":
      return deactivateLicense();
    case "license-revalidate":
      return revalidateIfStale();
    case "license-remove-local":
      await removeLicenseLocally();
      return { ok: true };
  }
}
