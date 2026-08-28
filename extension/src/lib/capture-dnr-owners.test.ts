import { beforeEach, describe, expect, it } from "vitest";
import {
  CAPTURE_DNR_OWNERS_STORAGE_KEY,
  buildCaptureDnrSessionRule,
  captureDnrScopesOverlap,
  claimCaptureDnrOwner,
  listCaptureDnrOwners,
  releaseCaptureDnrOwner,
} from "./capture-dnr-owners";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      session: {
        async get(key: string) {
          return key in store ? { [key]: structuredClone(store[key]) } : {};
        },
        async set(values: Record<string, unknown>) {
          Object.assign(store, structuredClone(values));
        },
      },
    },
  };
});

function scope(url = "https://cdn.example/video/") {
  const parsed = new URL(url);
  return {
    mode: "directory_prefix" as const,
    origin: parsed.origin,
    requestDomain: parsed.hostname,
    scopeUrl: parsed.href,
    urlFilter: `|${parsed.href}`,
    isUrlFilterCaseSensitive: true as const,
  };
}

function claim(jobKey = "capture:review:one", leaseId = "lease-1", replayScope = scope()) {
  return {
    jobKey,
    leaseId,
    ownerKind: "review" as const,
    replayScope,
    expiresAt: 3_600_000,
  };
}

describe("capture DNR ownership", () => {
  it("allocates collision-free IDs and replays an exact claim", async () => {
    const first = await claimCaptureDnrOwner(claim());
    expect(first).toMatchObject({ ok: true, changed: true, owner: { ruleId: 1_000_000_001 } });
    await expect(claimCaptureDnrOwner(claim())).resolves.toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
      owner: { ruleId: 1_000_000_001 },
    });
    await expect(claimCaptureDnrOwner(claim(
      "capture:review:two",
      "lease-2",
      scope("https://other.example/video/"),
    ))).resolves.toMatchObject({ ok: true, owner: { ruleId: 1_000_000_002 } });
  });

  it("rejects identical, parent/child, and direct-inside-directory overlaps", async () => {
    const directory = scope();
    const child = scope("https://cdn.example/video/child/");
    const sibling = scope("https://cdn.example/audio/");
    const direct = {
      mode: "exact_url" as const,
      origin: "https://cdn.example",
      requestDomain: "cdn.example",
      scopeUrl: "https://cdn.example/video/file.m4s?token=one",
      urlFilter: "|https://cdn.example/video/file.m4s?token=one|",
      isUrlFilterCaseSensitive: true as const,
    };
    expect(captureDnrScopesOverlap(directory, child)).toBe(true);
    expect(captureDnrScopesOverlap(directory, direct)).toBe(true);
    expect(captureDnrScopesOverlap(directory, sibling)).toBe(false);
    expect(captureDnrScopesOverlap(directory, scope("https://sub.cdn.example/video/"))).toBe(false);
    expect(captureDnrScopesOverlap(directory, scope("http://cdn.example/video/"))).toBe(false);
    await claimCaptureDnrOwner(claim("capture:one", "lease-1", directory));
    await expect(claimCaptureDnrOwner(claim("capture:two", "lease-2", child)))
      .resolves.toMatchObject({ ok: false, reason: "scope_conflict" });
    await expect(claimCaptureDnrOwner(claim("capture:three", "lease-3", sibling)))
      .resolves.toMatchObject({ ok: true });
  });

  it("builds an exact extension-fetch-only rule and excludes preview media", async () => {
    const claimed = await claimCaptureDnrOwner(claim());
    if (!claimed.ok) throw new Error("Expected claim");
    expect(buildCaptureDnrSessionRule({
      owner: claimed.owner,
      captured: { authorization: "Bearer secret", custom: { "x-proof": "one" } },
      extensionId: "a".repeat(32),
    })).toEqual({
      id: 1_000_000_001,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "authorization", operation: "set", value: "Bearer secret" },
          { header: "x-proof", operation: "set", value: "one" },
        ],
      },
      condition: {
        urlFilter: "|https://cdn.example/video/",
        isUrlFilterCaseSensitive: true,
        requestDomains: ["cdn.example"],
        initiatorDomains: ["a".repeat(32)],
        resourceTypes: ["xmlhttprequest", "other"],
      },
    });
  });

  it("rejects noncanonical or accessor-authored scopes", async () => {
    const extra = { ...scope(), extra: true } as never;
    await expect(claimCaptureDnrOwner(claim("capture:extra", "lease-extra", extra)))
      .resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    const accessor = Object.defineProperties({}, {
      mode: { enumerable: true, get: () => "directory_prefix" },
      origin: { enumerable: true, value: "https://cdn.example" },
      requestDomain: { enumerable: true, value: "cdn.example" },
      scopeUrl: { enumerable: true, value: "https://cdn.example/video/" },
      urlFilter: { enumerable: true, value: "|https://cdn.example/video/" },
      isUrlFilterCaseSensitive: { enumerable: true, value: true },
    }) as never;
    await expect(claimCaptureDnrOwner(claim("capture:accessor", "lease-accessor", accessor)))
      .resolves.toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("releases exact ownership without exposing headers", async () => {
    const claimed = await claimCaptureDnrOwner(claim());
    if (!claimed.ok) throw new Error("Expected claim");
    await expect(releaseCaptureDnrOwner({ jobKey: claimed.owner.jobKey, leaseId: "wrong" }))
      .resolves.toMatchObject({ ok: false, reason: "job_conflict" });
    await expect(releaseCaptureDnrOwner({ jobKey: claimed.owner.jobKey, leaseId: "lease-1" }))
      .resolves.toMatchObject({ ok: true, owner: { ruleId: claimed.owner.ruleId } });
    expect(await listCaptureDnrOwners()).toEqual({ ok: true, owners: [] });
    expect(JSON.stringify(store)).not.toContain("authorization");
  });

  it("detects corrupt duplicate rule IDs", async () => {
    await claimCaptureDnrOwner(claim());
    const index = store[CAPTURE_DNR_OWNERS_STORAGE_KEY] as {
      orderedJobKeys: string[];
      records: Record<string, Record<string, unknown>>;
    };
    index.orderedJobKeys.push("capture:bad");
    index.records["capture:bad"] = {
      ...structuredClone(index.records["capture:review:one"]),
      jobKey: "capture:bad",
    };
    await expect(listCaptureDnrOwners()).resolves.toMatchObject({
      ok: false,
      reason: "storage_corrupt",
    });
  });

  it("reads back acknowledgement-loss writes", async () => {
    let rejectAfterWrite = true;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        session: {
          async get(key: string) {
            return key in store ? { [key]: structuredClone(store[key]) } : {};
          },
          async set(values: Record<string, unknown>) {
            Object.assign(store, structuredClone(values));
            if (rejectAfterWrite) {
              rejectAfterWrite = false;
              throw new Error("ack lost");
            }
          },
        },
      },
    };
    await expect(claimCaptureDnrOwner(claim())).resolves.toMatchObject({
      ok: true,
      commitState: "committed",
    });
  });
});
