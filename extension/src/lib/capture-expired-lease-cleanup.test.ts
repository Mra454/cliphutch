import { describe, expect, it, vi } from "vitest";
import type { CaptureDnrOwnerV1 } from "./capture-dnr-owners";
import { cleanupSweptCaptureLeaseDnrOwners } from "./capture-expired-lease-cleanup";

function owner(leaseId: string, jobKey = `capture:${leaseId}`): CaptureDnrOwnerV1 {
  return {
    schemaVersion: 1,
    jobKey,
    leaseId,
    ownerKind: "attempt",
    ruleId: 1_000_000_001,
    replayScope: {
      mode: "directory_prefix",
      origin: "https://cdn.example",
      requestDomain: "cdn.example",
      scopeUrl: "https://cdn.example/path/",
      urlFilter: "|https://cdn.example/path/",
      isUrlFilterCaseSensitive: true,
    },
    expiresAt: 10,
  };
}

describe("cleanupSweptCaptureLeaseDnrOwners", () => {
  it("removes every matching expired owner before reporting success", async () => {
    const oldA = owner("lease-old-a");
    const oldB = owner("lease-old-b");
    const current = owner("lease-current");
    const removeOwner = vi.fn(async (_owner: CaptureDnrOwnerV1): Promise<boolean> => true);
    await expect(cleanupSweptCaptureLeaseDnrOwners(
      [oldA.leaseId, oldB.leaseId],
      {
        listOwners: async () => ({ ok: true, owners: [oldA, current, oldB] }),
        removeOwner,
      },
    )).resolves.toBe(true);
    expect(removeOwner.mock.calls.map((call) => call[0].leaseId)).toEqual([
      "lease-old-a",
      "lease-old-b",
    ]);
  });

  it("fails closed when owner discovery or exact removal is unavailable", async () => {
    await expect(cleanupSweptCaptureLeaseDnrOwners(["lease-old"], {
      listOwners: async () => ({ ok: false }),
      removeOwner: async () => true,
    })).resolves.toBe(false);
    await expect(cleanupSweptCaptureLeaseDnrOwners(["lease-old"], {
      listOwners: async () => ({ ok: true, owners: [owner("lease-old")] }),
      removeOwner: async () => false,
    })).resolves.toBe(false);
  });

  it("rejects duplicate and unsafe lease identities without touching storage", async () => {
    const listOwners = vi.fn(async () => ({ ok: true as const, owners: [] }));
    await expect(cleanupSweptCaptureLeaseDnrOwners(
      ["lease-old", "lease-old"],
      { listOwners, removeOwner: async () => true },
    )).resolves.toBe(false);
    await expect(cleanupSweptCaptureLeaseDnrOwners(
      ["https://secret.example/token"],
      { listOwners, removeOwner: async () => true },
    )).resolves.toBe(false);
    expect(listOwners).not.toHaveBeenCalled();
  });
});
