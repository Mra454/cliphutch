import type { CaptureDnrOwnerV1 } from "./capture-dnr-owners";

const SAFE_ID = /^[a-z0-9._:-]+$/i;

export type SweptCaptureLeaseCleanupDependencies = {
  listOwners(): Promise<{ ok: true; owners: CaptureDnrOwnerV1[] } | { ok: false }>;
  removeOwner(owner: CaptureDnrOwnerV1): Promise<boolean>;
};

/**
 * Removes DNR rules that still embed headers for lease records opportunistically
 * swept by a new Add. The caller must await success before accepting the Add.
 */
export async function cleanupSweptCaptureLeaseDnrOwners(
  rawLeaseIds: readonly string[],
  dependencies: SweptCaptureLeaseCleanupDependencies,
): Promise<boolean> {
  if (
    !Array.isArray(rawLeaseIds) ||
    rawLeaseIds.length > 200 ||
    !rawLeaseIds.every((leaseId) =>
      typeof leaseId === "string" && leaseId.length > 0 && leaseId.length <= 256 &&
      SAFE_ID.test(leaseId)) ||
    new Set(rawLeaseIds).size !== rawLeaseIds.length
  ) return false;
  if (rawLeaseIds.length === 0) return true;
  const listed = await dependencies.listOwners();
  if (!listed.ok) return false;
  const expected = new Set(rawLeaseIds);
  let removed = true;
  for (const owner of listed.owners) {
    if (!expected.has(owner.leaseId)) continue;
    if (!await dependencies.removeOwner(owner)) removed = false;
  }
  return removed;
}
