import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_HEADER_LEASES_STORAGE_KEY,
  CAPTURE_HEADER_LEASE_TTL_MS,
  MAX_CAPTURE_HEADER_LEASE_HEADER_BYTES,
  MAX_CAPTURE_HEADER_LEASE_HEADER_COUNT,
  MAX_CAPTURE_HEADER_LEASE_HEADER_NAME_BYTES,
  MAX_CAPTURE_HEADER_LEASE_HEADER_VALUE_BYTES,
  MAX_CAPTURE_HEADER_LEASE_BATCH_ITEMS,
  MAX_CAPTURE_HEADER_LEASE_RECORDS,
  claimCaptureHeaderLease,
  claimCaptureHeaderLeaseBatch,
  captureHeaderReplayScopeMatchesRequest,
  createCaptureHeaderLease,
  getCaptureHeaderLease,
  getClaimedCaptureHeaderLease,
  listCaptureHeaderLeases,
  releaseCaptureHeaderLease,
  releaseCaptureHeaderLeaseBatch,
  releaseClaimedCaptureHeaderLease,
  retireClaimedCaptureHeaderLease,
  sweepExpiredCaptureHeaderLeases,
  type CaptureHeaderLeaseBindingV1,
  type CaptureHeaderLeaseAttemptBindingV1,
  type ClaimCaptureHeaderLeaseBatchInput,
  type CreateCaptureHeaderLeaseInput,
} from "./capture-header-leases";

const storage: Record<string, unknown> = Object.create(null);
let failGet = false;
let failNextGet = false;
let setFailure: "none" | "before" | "after" = "none";

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  failGet = false;
  failNextGet = false;
  setFailure = "none";
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async (key: string) => {
          if (failGet || failNextGet) {
            failNextGet = false;
            throw new Error("session get failed");
          }
          return Object.prototype.hasOwnProperty.call(storage, key)
            ? { [key]: storage[key] }
            : {};
        }),
        set: vi.fn(async (values: Record<string, unknown>) => {
          if (setFailure === "before") throw new Error("session set failed");
          Object.assign(storage, values);
          if (setFailure === "after") throw new Error("session acknowledgement lost");
        }),
      },
    },
  });
});

function binding(index = 1): CaptureHeaderLeaseBindingV1 {
  return {
    leaseId: `lease-${index}`,
    draftId: "draft-1",
    itemId: `item-${index}`,
    mediaId: `media-${index}`,
    sourceTabId: 41,
    pageUrl: "https://page.example/gallery#slide-1",
    sourceUrl: `https://cdn.example/media-${index}.mp4?signature=bound-${index}`,
    replayKind: "direct",
  };
}

function createInput(index = 1, now = 1_000): CreateCaptureHeaderLeaseInput {
  return {
    ...binding(index),
    authoritativeHeaders: {
      referer: "https://page.example/gallery",
      authorization: "Bearer private-token",
      custom: { "X-Signed-Token": "signed-value" },
    },
    now,
  };
}

function getInput(index = 1, now = 1_000) {
  return { ...binding(index), now };
}

function claimInput(index = 1, now = 1_000) {
  return {
    ...binding(index),
    runId: "run-1",
    jobId: `job-${index}`,
    attemptId: `attempt-${index}`,
    now,
  };
}

function attemptBinding(
  index = 1,
  owner = "run-1",
): CaptureHeaderLeaseAttemptBindingV1 {
  return {
    ...binding(index),
    ...attemptOwner(index, owner),
  };
}

function attemptOwner(index = 1, owner = "run-1") {
  return {
    runId: owner,
    jobId: `${owner}-job-${index}`,
    attemptId: `${owner}-attempt-${index}`,
  };
}

function storedRegistry(): {
  schemaVersion: 1;
  orderedLeaseIds: string[];
  records: Record<string, unknown>;
} {
  return storage[CAPTURE_HEADER_LEASES_STORAGE_KEY] as ReturnType<typeof storedRegistry>;
}

describe("Capture header lease registry", () => {
  it("persists only canonical approved headers and isolates input/output mutations", async () => {
    const input = createInput();
    const created = await createCaptureHeaderLease(input);
    expect(created).toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      lease: {
        schemaVersion: 1,
        ...binding(),
        createdAt: 1_000,
        expiresAt: 1_000 + CAPTURE_HEADER_LEASE_TTL_MS,
        replayScope: {
          mode: "exact_url",
          origin: "https://cdn.example",
          requestDomain: "cdn.example",
          scopeUrl: "https://cdn.example/media-1.mp4?signature=bound-1",
          urlFilter: "|https://cdn.example/media-1.mp4?signature=bound-1|",
          isUrlFilterCaseSensitive: true,
        },
        headers: {
          referer: "https://page.example/gallery",
          authorization: "Bearer private-token",
          custom: { "x-signed-token": "signed-value" },
        },
        draftItemOwnerActive: true,
        acceptedAttemptOwner: null,
      },
    });

    input.authoritativeHeaders.authorization = "changed input";
    input.authoritativeHeaders.custom!["X-Signed-Token"] = "changed input";
    if (created.ok) {
      created.lease.headers.authorization = "changed result";
      created.lease.headers.custom!["x-signed-token"] = "changed result";
    }

    const firstRead = await getCaptureHeaderLease(getInput());
    expect(firstRead).toMatchObject({
      ok: true,
      lease: {
        headers: {
          authorization: "Bearer private-token",
          custom: { "x-signed-token": "signed-value" },
        },
      },
    });
    if (firstRead.ok && firstRead.lease) {
      firstRead.lease.headers.authorization = "changed read";
    }
    await expect(getCaptureHeaderLease(getInput())).resolves.toMatchObject({
      ok: true,
      lease: { headers: { authorization: "Bearer private-token" } },
    });

    const listed = await listCaptureHeaderLeases(1_000);
    expect(listed).toMatchObject({ ok: true, leases: [{ leaseId: "lease-1" }] });
    expect(JSON.stringify(listed)).not.toContain("private-token");
    expect(JSON.stringify(listed)).not.toContain("signed-value");
    expect(JSON.stringify(listed)).not.toContain('"headers"');
  });

  it("returns replay material only to the exact accepted attempt owner", async () => {
    await createCaptureHeaderLease(createInput());
    await claimCaptureHeaderLease(claimInput());
    await expect(getClaimedCaptureHeaderLease({
      leaseId: "lease-1",
      runId: "run-1",
      jobId: "job-1",
      attemptId: "attempt-1",
      now: 1_001,
    })).resolves.toMatchObject({
      ok: true,
      lease: {
        leaseId: "lease-1",
        headers: { authorization: "Bearer private-token" },
      },
    });
    await expect(getClaimedCaptureHeaderLease({
      leaseId: "lease-1",
      runId: "run-1",
      jobId: "job-1",
      attemptId: "later-attempt",
      now: 1_001,
    })).resolves.toMatchObject({ ok: false, reason: "owner_conflict" });
    await expect(getClaimedCaptureHeaderLease({
      leaseId: "lease-1",
      runId: "run-1",
      jobId: "job-1",
      attemptId: "attempt-1",
      now: 1_000 + CAPTURE_HEADER_LEASE_TTL_MS,
    })).resolves.toMatchObject({ ok: false, reason: "lease_expired" });
  });

  it("releases only the exact accepted attempt while retaining its draft owner", async () => {
    await createCaptureHeaderLease(createInput());
    await claimCaptureHeaderLease(claimInput());
    await expect(releaseClaimedCaptureHeaderLease({
      leaseId: "lease-1",
      runId: "run-1",
      jobId: "job-1",
      attemptId: "wrong-attempt",
      now: 1_001,
    })).resolves.toMatchObject({ ok: false, reason: "owner_conflict" });
    await expect(releaseClaimedCaptureHeaderLease({
      leaseId: "lease-1",
      runId: "run-1",
      jobId: "job-1",
      attemptId: "attempt-1",
      now: 1_001,
    })).resolves.toMatchObject({
      ok: true,
      changed: true,
      lease: { draftItemOwnerActive: true, acceptedAttemptOwner: null },
    });
    await expect(releaseClaimedCaptureHeaderLease({
      leaseId: "lease-1",
      runId: "run-1",
      jobId: "job-1",
      attemptId: "attempt-1",
      now: 1_001,
    })).resolves.toMatchObject({ ok: true, changed: false, replayed: true });
  });

  it("retires all replay material only for the exact terminal attempt", async () => {
    await createCaptureHeaderLease(createInput());
    await claimCaptureHeaderLease(claimInput());
    await expect(retireClaimedCaptureHeaderLease({
      leaseId: "lease-1",
      runId: "run-1",
      jobId: "job-1",
      attemptId: "wrong-attempt",
      now: 1_001,
    })).resolves.toMatchObject({ ok: false, reason: "owner_conflict" });
    await expect(retireClaimedCaptureHeaderLease({
      leaseId: "lease-1",
      runId: "run-1",
      jobId: "job-1",
      attemptId: "attempt-1",
      now: 1_001,
    })).resolves.toMatchObject({
      ok: true,
      changed: true,
      lease: null,
    });
    await expect(getCaptureHeaderLease(getInput(1, 1_001))).resolves.toMatchObject({
      ok: true,
      lease: null,
    });
    await expect(retireClaimedCaptureHeaderLease({
      leaseId: "lease-1",
      runId: "run-1",
      jobId: "job-1",
      attemptId: "attempt-1",
      now: 1_001,
    })).resolves.toMatchObject({ ok: true, changed: false, replayed: true });
  });

  it("rejects non-approved, empty, duplicate, oversized, and injectable headers", async () => {
    const cases: unknown[] = [
      { cookie: "secret-cookie" },
      {},
      { authorization: "" },
      { authorization: "Bearer good\r\nCookie: stolen" },
      { custom: { "X-Key": "one", "x-key": "two" } },
      { custom: { "x-": "value" } },
      { custom: { "content-type": "value" } },
      { custom: Object.fromEntries(
        Array.from({ length: MAX_CAPTURE_HEADER_LEASE_HEADER_COUNT + 1 }, (_, index) => [
          `x-key-${index}`,
          "v",
        ]),
      ) },
      { custom: { [`x-${"n".repeat(MAX_CAPTURE_HEADER_LEASE_HEADER_NAME_BYTES)}`]: "v" } },
      { authorization: "é".repeat(Math.floor(MAX_CAPTURE_HEADER_LEASE_HEADER_VALUE_BYTES / 2) + 1) },
      { custom: Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `x-large-${index}`,
          "v".repeat(Math.floor(MAX_CAPTURE_HEADER_LEASE_HEADER_BYTES / 5)),
        ]),
      ) },
    ];
    for (const authoritativeHeaders of cases) {
      const result = await createCaptureHeaderLease({
        ...createInput(),
        authoritativeHeaders,
      } as CreateCaptureHeaderLeaseInput);
      expect(result).toMatchObject({ ok: false, reason: "invalid_input" });
      expect(JSON.stringify(result)).not.toContain("secret-cookie");
      expect(JSON.stringify(result)).not.toContain("stolen");
    }
    expect(storage[CAPTURE_HEADER_LEASES_STORAGE_KEY]).toBeUndefined();
  });

  it("does not invoke accessors or trust proxies, prototypes, or cyclic values", async () => {
    let getterCalls = 0;
    const accessorHeaders = {};
    Object.defineProperty(accessorHeaders, "authorization", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "Bearer getter-secret";
      },
    });
    await expect(createCaptureHeaderLease({
      ...createInput(),
      authoritativeHeaders: accessorHeaders,
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    expect(getterCalls).toBe(0);

    const proxyHeaders = new Proxy({}, {
      ownKeys() {
        throw new Error("hostile ownKeys");
      },
    });
    await expect(createCaptureHeaderLease({
      ...createInput(),
      authoritativeHeaders: proxyHeaders,
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });

    const inheritedHeaders = Object.create({ authorization: "Bearer inherited-secret" });
    await expect(createCaptureHeaderLease({
      ...createInput(),
      authoritativeHeaders: inheritedHeaders,
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });

    const cyclicCustom: Record<string, unknown> = Object.create(null);
    cyclicCustom["x-cycle"] = cyclicCustom;
    await expect(createCaptureHeaderLease({
      ...createInput(),
      authoritativeHeaders: { custom: cyclicCustom },
    } as CreateCaptureHeaderLeaseInput)).resolves.toMatchObject({
      ok: false,
      reason: "invalid_input",
    });
  });

  it("canonicalizes HTTP(S) page bindings while rejecting credentials and wrong bindings", async () => {
    await expect(createCaptureHeaderLease({
      ...createInput(),
      pageUrl: "https://page.example",
    })).resolves.toMatchObject({
      ok: true,
      lease: { pageUrl: "https://page.example/" },
    });
    await expect(getCaptureHeaderLease({
      ...getInput(),
      pageUrl: "https://page.example/",
    })).resolves.toMatchObject({ ok: true, lease: { leaseId: "lease-1" } });
    await expect(getCaptureHeaderLease({
      ...getInput(),
      itemId: "item-other",
      pageUrl: "https://page.example/",
    })).resolves.toMatchObject({ ok: false, reason: "binding_conflict" });
    await expect(getCaptureHeaderLease({
      ...getInput(),
      pageUrl: "https://page.example/",
      sourceTabId: 42,
    })).resolves.toMatchObject({ ok: false, reason: "binding_conflict" });
    await expect(getCaptureHeaderLease({
      ...getInput(),
      pageUrl: "https://page.example/",
      sourceUrl: "https://other-cdn.example/media-1.mp4?signature=bound-1",
    })).resolves.toMatchObject({ ok: false, reason: "binding_conflict" });
    await expect(getCaptureHeaderLease({
      ...getInput(),
      pageUrl: "https://page.example/",
      sourceUrl: "https://cdn.example/other/media-1.mp4?signature=bound-1",
    })).resolves.toMatchObject({ ok: false, reason: "binding_conflict" });
    await expect(getCaptureHeaderLease({
      ...getInput(),
      pageUrl: "https://page.example/",
      replayKind: "hls",
    })).resolves.toMatchObject({ ok: false, reason: "binding_conflict" });
    await expect(getCaptureHeaderLease({
      ...getInput(),
      pageUrl: "https://page.example/other",
    })).resolves.toMatchObject({ ok: false, reason: "binding_conflict" });
    await expect(createCaptureHeaderLease({
      ...createInput(2),
      pageUrl: "https://user:password@page.example/private",
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    await expect(createCaptureHeaderLease({
      ...createInput(2),
      pageUrl: "file:///private/path",
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    await expect(createCaptureHeaderLease({
      ...createInput(2),
      sourceUrl: "https://user:password@cdn.example/private.mp4",
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    await expect(createCaptureHeaderLease({
      ...createInput(2),
      sourceUrl: "https://cdn.example/private*.mp4",
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
  });

  it("derives immutable direct and stream replay filters from the selected source", async () => {
    await expect(createCaptureHeaderLease({
      ...createInput(),
      sourceUrl: "https://cdn.example/video/master.m3u8?token=secret#ignored-fragment",
      replayKind: "hls",
    })).resolves.toMatchObject({
      ok: true,
      lease: {
        sourceUrl: "https://cdn.example/video/master.m3u8?token=secret",
        replayKind: "hls",
        replayScope: {
          mode: "directory_prefix",
          origin: "https://cdn.example",
          requestDomain: "cdn.example",
          scopeUrl: "https://cdn.example/video/",
          urlFilter: "|https://cdn.example/video/",
          isUrlFilterCaseSensitive: true,
        },
      },
    });
    await expect(getCaptureHeaderLease({
      ...getInput(),
      sourceUrl: "https://cdn.example/video/master.m3u8?token=secret",
      replayKind: "hls",
    })).resolves.toMatchObject({
      ok: true,
      lease: { replayScope: { urlFilter: "|https://cdn.example/video/" } },
    });
  });

  it("matches only the exact source origin and intended direct or stream path", async () => {
    const direct = await createCaptureHeaderLease(createInput());
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(captureHeaderReplayScopeMatchesRequest(
      direct.lease.replayScope,
      "https://cdn.example/media-1.mp4?signature=bound-1",
    )).toBe(true);
    expect(captureHeaderReplayScopeMatchesRequest(
      direct.lease.replayScope,
      "https://cdn.example/media-1.mp4?signature=changed",
    )).toBe(false);
    expect(captureHeaderReplayScopeMatchesRequest(
      direct.lease.replayScope,
      "https://cdn.example/Media-1.mp4?signature=bound-1",
    )).toBe(false);
    expect(captureHeaderReplayScopeMatchesRequest(
      direct.lease.replayScope,
      "http://cdn.example/media-1.mp4?signature=bound-1",
    )).toBe(false);

    delete storage[CAPTURE_HEADER_LEASES_STORAGE_KEY];
    const stream = await createCaptureHeaderLease({
      ...createInput(),
      sourceUrl: "https://cdn.example/video/master.m3u8?token=secret",
      replayKind: "hls",
    });
    expect(stream.ok).toBe(true);
    if (!stream.ok) return;
    const scope = stream.lease.replayScope;
    expect(captureHeaderReplayScopeMatchesRequest(scope, "https://cdn.example/video/seg-1.ts"))
      .toBe(true);
    expect(captureHeaderReplayScopeMatchesRequest(
      scope,
      "https://cdn.example/video/audio/seg-1.m4s?token=other",
    )).toBe(true);
    expect(captureHeaderReplayScopeMatchesRequest(scope, "https://sub.cdn.example/video/seg.ts"))
      .toBe(false);
    expect(captureHeaderReplayScopeMatchesRequest(scope, "https://cdn.example/videos/seg.ts"))
      .toBe(false);
    expect(captureHeaderReplayScopeMatchesRequest(scope, "https://cdn.example/sibling/seg.ts"))
      .toBe(false);
    expect(captureHeaderReplayScopeMatchesRequest(scope, "http://cdn.example/video/seg.ts"))
      .toBe(false);
  });

  it("replays the exact immutable snapshot without extending TTL and conflicts on changed payload", async () => {
    await createCaptureHeaderLease(createInput(1, 100));
    await expect(createCaptureHeaderLease(createInput(1, 500))).resolves.toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
      lease: { createdAt: 100, expiresAt: 100 + CAPTURE_HEADER_LEASE_TTL_MS },
    });
    const changed = await createCaptureHeaderLease({
      ...createInput(1, 500),
      authoritativeHeaders: { authorization: "Bearer replacement-secret" },
    });
    expect(changed).toMatchObject({ ok: false, reason: "lease_conflict" });
    expect(JSON.stringify(changed)).not.toContain("replacement-secret");
    await expect(createCaptureHeaderLease(
      createInput(1, 100 + CAPTURE_HEADER_LEASE_TTL_MS),
    )).resolves.toMatchObject({ ok: false, reason: "lease_expired" });
  });

  it("claims one accepted attempt idempotently and keeps independent owner references", async () => {
    await createCaptureHeaderLease(createInput());
    await expect(claimCaptureHeaderLease(claimInput())).resolves.toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      lease: {
        draftItemOwnerActive: true,
        acceptedAttemptOwner: {
          runId: "run-1",
          jobId: "job-1",
          attemptId: "attempt-1",
        },
      },
    });
    await expect(claimCaptureHeaderLease(claimInput())).resolves.toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
    });
    await expect(claimCaptureHeaderLease({
      ...claimInput(),
      attemptId: "attempt-other",
    })).resolves.toMatchObject({ ok: false, reason: "owner_conflict" });

    await expect(releaseCaptureHeaderLease({
      ...getInput(),
      owner: { kind: "draft_item" },
    })).resolves.toMatchObject({
      ok: true,
      changed: true,
      lease: { draftItemOwnerActive: false, headers: { authorization: "Bearer private-token" } },
    });
    await expect(releaseCaptureHeaderLease({
      ...getInput(),
      owner: {
        kind: "accepted_attempt",
        runId: "run-1",
        jobId: "job-1",
        attemptId: "stale-attempt",
      },
    })).resolves.toMatchObject({ ok: false, reason: "owner_conflict" });
    await expect(releaseCaptureHeaderLease({
      ...getInput(),
      owner: {
        kind: "accepted_attempt",
        runId: "run-1",
        jobId: "job-1",
        attemptId: "attempt-1",
      },
    })).resolves.toMatchObject({ ok: true, changed: true, lease: null });
    await expect(releaseCaptureHeaderLease({
      ...getInput(),
      owner: {
        kind: "accepted_attempt",
        runId: "run-1",
        jobId: "job-1",
        attemptId: "attempt-1",
      },
    })).resolves.toMatchObject({ ok: true, changed: false, replayed: true, lease: null });
    await expect(claimCaptureHeaderLease(claimInput())).resolves.toMatchObject({
      ok: false,
      reason: "lease_not_found",
    });
  });

  it("retains an expired accepted attempt when the draft item releases first", async () => {
    await createCaptureHeaderLease(createInput(1, 0));
    await claimCaptureHeaderLease(claimInput(1, 10));
    const released = await releaseCaptureHeaderLease({
      ...getInput(1, CAPTURE_HEADER_LEASE_TTL_MS),
      owner: { kind: "draft_item" },
    });
    expect(released).toMatchObject({
      ok: true,
      changed: true,
      expired: true,
      lease: {
        draftItemOwnerActive: false,
        acceptedAttemptOwner: {
          runId: "run-1",
          jobId: "job-1",
          attemptId: "attempt-1",
        },
      },
    });
    expect(storedRegistry().records["lease-1"]).toMatchObject({
      draftItemOwnerActive: false,
      acceptedAttemptOwner: { attemptId: "attempt-1" },
    });
    await expect(listCaptureHeaderLeases(CAPTURE_HEADER_LEASE_TTL_MS)).resolves.toMatchObject({
      ok: true,
      leases: [],
      expiredLeaseIds: ["lease-1"],
    });
  });

  it("claims a whole pack atomically and replays exact owners without exposing headers", async () => {
    for (let index = 1; index <= 3; index += 1) {
      await createCaptureHeaderLease(createInput(index, 100 + index));
    }
    const claims = [attemptBinding(1), attemptBinding(2), attemptBinding(3)];
    const claimed = await claimCaptureHeaderLeaseBatch({ claims, now: 500 });
    expect(claimed).toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      items: claims.map((claim) => ({
        leaseId: claim.leaseId,
        lease: {
          leaseId: claim.leaseId,
          draftItemOwnerActive: true,
          acceptedAttemptOwner: {
            runId: claim.runId,
            jobId: claim.jobId,
            attemptId: claim.attemptId,
          },
        },
      })),
    });
    expect(JSON.stringify(claimed)).not.toContain("private-token");
    expect(JSON.stringify(claimed)).not.toContain("signed-value");
    expect(JSON.stringify(claimed)).not.toContain('"headers"');

    for (let index = 1; index <= 3; index += 1) {
      await expect(getCaptureHeaderLease(getInput(index, 500))).resolves.toMatchObject({
        ok: true,
        lease: {
          createdAt: 100 + index,
          expiresAt: 100 + index + CAPTURE_HEADER_LEASE_TTL_MS,
          acceptedAttemptOwner: attemptOwner(index),
        },
      });
    }
    await expect(claimCaptureHeaderLeaseBatch({ claims, now: 900 })).resolves.toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
      items: [{ leaseId: "lease-1" }, { leaseId: "lease-2" }, { leaseId: "lease-3" }],
    });
  });

  it("leaves every sibling untouched when one batch claim conflicts, is missing, or expired", async () => {
    await createCaptureHeaderLease(createInput(1, 0));
    await createCaptureHeaderLease(createInput(2, 10));
    await claimCaptureHeaderLease({
      ...binding(2),
      runId: "other-run",
      jobId: "other-job",
      attemptId: "other-attempt",
      now: 20,
    });
    await expect(claimCaptureHeaderLeaseBatch({
      claims: [attemptBinding(1), attemptBinding(2)],
      now: 20,
    })).resolves.toMatchObject({ ok: false, reason: "owner_conflict", leaseId: "lease-2" });
    await expect(getCaptureHeaderLease(getInput(1, 20))).resolves.toMatchObject({
      ok: true,
      lease: { acceptedAttemptOwner: null },
    });

    await expect(claimCaptureHeaderLeaseBatch({
      claims: [attemptBinding(1), attemptBinding(3)],
      now: 20,
    })).resolves.toMatchObject({ ok: false, reason: "lease_not_found", leaseId: "lease-3" });
    await expect(getCaptureHeaderLease(getInput(1, 20))).resolves.toMatchObject({
      ok: true,
      lease: { acceptedAttemptOwner: null },
    });

    await expect(claimCaptureHeaderLeaseBatch({
      claims: [
        attemptBinding(1),
        { ...attemptBinding(2, "other-run"), sourceTabId: 99 },
      ],
      now: 20,
    })).resolves.toMatchObject({ ok: false, reason: "binding_conflict", leaseId: "lease-2" });
    await expect(getCaptureHeaderLease(getInput(1, 20))).resolves.toMatchObject({
      ok: true,
      lease: { acceptedAttemptOwner: null },
    });

    await expect(claimCaptureHeaderLeaseBatch({
      claims: [attemptBinding(1)],
      now: CAPTURE_HEADER_LEASE_TTL_MS,
    })).resolves.toMatchObject({ ok: false, reason: "lease_expired", leaseId: "lease-1" });
  });

  it("releases exact attempt references atomically while preserving draft ownership", async () => {
    await createCaptureHeaderLease(createInput(1, 100));
    await createCaptureHeaderLease(createInput(2, 200));
    const releases = [attemptBinding(1), attemptBinding(2)];
    await claimCaptureHeaderLeaseBatch({ claims: releases, now: 300 });

    const released = await releaseCaptureHeaderLeaseBatch({ releases, now: 400 });
    expect(released).toMatchObject({
      ok: true,
      changed: true,
      replayed: false,
      commitState: "committed",
      items: [
        {
          leaseId: "lease-1",
          lease: { draftItemOwnerActive: true, acceptedAttemptOwner: null },
        },
        {
          leaseId: "lease-2",
          lease: { draftItemOwnerActive: true, acceptedAttemptOwner: null },
        },
      ],
    });
    expect(JSON.stringify(released)).not.toContain("private-token");
    expect(JSON.stringify(released)).not.toContain("signed-value");
    expect(JSON.stringify(released)).not.toContain('"headers"');
    await expect(getCaptureHeaderLease(getInput(1, 400))).resolves.toMatchObject({
      ok: true,
      lease: {
        createdAt: 100,
        expiresAt: 100 + CAPTURE_HEADER_LEASE_TTL_MS,
        draftItemOwnerActive: true,
        acceptedAttemptOwner: null,
      },
    });
    await expect(releaseCaptureHeaderLeaseBatch({ releases, now: 500 })).resolves.toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
    });

    await claimCaptureHeaderLeaseBatch({ claims: releases, now: 600 });
    await releaseCaptureHeaderLease({
      ...getInput(1, 600),
      owner: { kind: "draft_item" },
    });
    await expect(releaseCaptureHeaderLeaseBatch({ releases, now: 700 })).resolves.toMatchObject({
      ok: true,
      changed: true,
      items: [
        { leaseId: "lease-1", lease: null },
        { leaseId: "lease-2", lease: { draftItemOwnerActive: true } },
      ],
    });
    await expect(releaseCaptureHeaderLeaseBatch({ releases, now: 800 })).resolves.toMatchObject({
      ok: true,
      changed: false,
      replayed: true,
      items: [{ leaseId: "lease-1", lease: null }, { leaseId: "lease-2" }],
    });
  });

  it("does not partially release when one active attempt has a different owner", async () => {
    await createCaptureHeaderLease(createInput(1));
    await createCaptureHeaderLease(createInput(2));
    await claimCaptureHeaderLeaseBatch({
      claims: [attemptBinding(1), attemptBinding(2, "other-run")],
      now: 1_100,
    });
    await expect(releaseCaptureHeaderLeaseBatch({
      releases: [attemptBinding(1), attemptBinding(2)],
      now: 1_200,
    })).resolves.toMatchObject({ ok: false, reason: "owner_conflict", leaseId: "lease-2" });
    await expect(getCaptureHeaderLease(getInput(1, 1_200))).resolves.toMatchObject({
      ok: true,
      lease: { acceptedAttemptOwner: attemptOwner(1) },
    });
    await expect(getCaptureHeaderLease(getInput(2, 1_200))).resolves.toMatchObject({
      ok: true,
      lease: { acceptedAttemptOwner: attemptOwner(2, "other-run") },
    });
  });

  it("rejects a mixed claimed/unclaimed release cohort instead of releasing only siblings", async () => {
    await createCaptureHeaderLease(createInput(1));
    await createCaptureHeaderLease(createInput(2));
    await claimCaptureHeaderLeaseBatch({ claims: [attemptBinding(1)], now: 1_100 });
    await expect(releaseCaptureHeaderLeaseBatch({
      releases: [attemptBinding(1), attemptBinding(2)],
      now: 1_200,
    })).resolves.toMatchObject({ ok: false, reason: "owner_conflict", leaseId: "lease-2" });
    await expect(getCaptureHeaderLease(getInput(1, 1_200))).resolves.toMatchObject({
      ok: true,
      lease: { acceptedAttemptOwner: attemptOwner(1) },
    });
    await expect(getCaptureHeaderLease(getInput(2, 1_200))).resolves.toMatchObject({
      ok: true,
      lease: { acceptedAttemptOwner: null },
    });
  });

  it("strictly guards hostile, sparse, duplicate, and over-bound batch inputs", async () => {
    const invalidInputs: unknown[] = [
      { claims: [], now: 1 },
      { claims: [attemptBinding(1), attemptBinding(1)], now: 1 },
      {
        claims: [attemptBinding(1), { ...binding(2), ...attemptOwner(1) }],
        now: 1,
      },
      { claims: Array(MAX_CAPTURE_HEADER_LEASE_BATCH_ITEMS + 1)
        .fill(undefined)
        .map((_, index) => attemptBinding(index + 1)), now: 1 },
      { claims: Array(1), now: 1 },
      { claims: [attemptBinding(1)], now: Number.NaN },
      { claims: [{ ...attemptBinding(1), extra: "not-allowed" }], now: 1 },
    ];
    for (const input of invalidInputs) {
      await expect(claimCaptureHeaderLeaseBatch(
        input as ClaimCaptureHeaderLeaseBatchInput,
      )).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    }

    let getterCalls = 0;
    const accessorEntry = { ...attemptBinding(1) } as Record<string, unknown>;
    Object.defineProperty(accessorEntry, "attemptId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "accessor-attempt";
      },
    });
    await expect(claimCaptureHeaderLeaseBatch({
      claims: [accessorEntry] as unknown as CaptureHeaderLeaseAttemptBindingV1[],
      now: 1,
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    expect(getterCalls).toBe(0);

    const proxyClaims = new Proxy([attemptBinding(1)], {
      ownKeys() {
        throw new Error("hostile batch ownKeys");
      },
    });
    await expect(claimCaptureHeaderLeaseBatch({
      claims: proxyClaims as CaptureHeaderLeaseAttemptBindingV1[],
      now: 1,
    })).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    expect(storage[CAPTURE_HEADER_LEASES_STORAGE_KEY]).toBeUndefined();
  });

  it("fails batch operations closed on a corrupt session registry", async () => {
    storage[CAPTURE_HEADER_LEASES_STORAGE_KEY] = {
      schemaVersion: 2,
      orderedLeaseIds: [],
      records: {},
    };
    await expect(claimCaptureHeaderLeaseBatch({
      claims: [attemptBinding(1)],
      now: 1,
    })).resolves.toMatchObject({ ok: false, reason: "storage_corrupt" });
    await expect(releaseCaptureHeaderLeaseBatch({
      releases: [attemptBinding(1)],
      now: 1,
    })).resolves.toMatchObject({ ok: false, reason: "storage_corrupt" });
  });

  it("serializes competing batch claims so one exact owner wins without mixed ownership", async () => {
    await createCaptureHeaderLease(createInput(1));
    await createCaptureHeaderLease(createInput(2));
    const firstClaims = [attemptBinding(1, "first-run"), attemptBinding(2, "first-run")];
    const secondClaims = [attemptBinding(1, "second-run"), attemptBinding(2, "second-run")];
    const results = await Promise.all([
      claimCaptureHeaderLeaseBatch({ claims: firstClaims, now: 1_100 }),
      claimCaptureHeaderLeaseBatch({ claims: secondClaims, now: 1_100 }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    const owner = (await getCaptureHeaderLease(getInput(1, 1_100)));
    const sibling = (await getCaptureHeaderLease(getInput(2, 1_100)));
    expect(owner.ok && sibling.ok && owner.lease?.acceptedAttemptOwner?.runId)
      .toBe(sibling.ok ? sibling.lease?.acceptedAttemptOwner?.runId : undefined);
  });

  it("uses exact read-back disposition for partial batch claim and release failures", async () => {
    await createCaptureHeaderLease(createInput(1));
    await createCaptureHeaderLease(createInput(2));
    const entries = [attemptBinding(1), attemptBinding(2)];

    setFailure = "after";
    await expect(claimCaptureHeaderLeaseBatch({ claims: entries, now: 1_100 }))
      .resolves.toMatchObject({ ok: true, changed: true, commitState: "committed" });

    setFailure = "before";
    const absent = await releaseCaptureHeaderLeaseBatch({ releases: entries, now: 1_200 });
    expect(absent).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      commitState: "absent",
    });
    expect(JSON.stringify(absent)).not.toContain("private-token");
    await expect(getCaptureHeaderLease(getInput(1, 1_200))).resolves.toMatchObject({
      ok: true,
      lease: { acceptedAttemptOwner: attemptOwner(1) },
    });

    const sessionSet = chrome.storage.session.set as ReturnType<typeof vi.fn>;
    sessionSet.mockImplementationOnce(async () => {
      failNextGet = true;
      throw new Error("batch set and read-back unavailable");
    });
    await expect(releaseCaptureHeaderLeaseBatch({ releases: entries, now: 1_300 }))
      .resolves.toMatchObject({
        ok: false,
        reason: "storage_unavailable",
        operation: "set",
        commitState: "unknown",
      });

    setFailure = "after";
    await expect(releaseCaptureHeaderLeaseBatch({ releases: entries, now: 1_400 }))
      .resolves.toMatchObject({ ok: true, changed: true, commitState: "committed" });
    await expect(getCaptureHeaderLease(getInput(1, 1_400))).resolves.toMatchObject({
      ok: true,
      lease: { acceptedAttemptOwner: null, draftItemOwnerActive: true },
    });
  });

  it("does not let stale references release or read another bound lease", async () => {
    await createCaptureHeaderLease(createInput());
    await expect(releaseCaptureHeaderLease({
      ...getInput(),
      draftId: "draft-other",
      owner: { kind: "draft_item" },
    })).resolves.toMatchObject({ ok: false, reason: "binding_conflict" });
    await expect(getCaptureHeaderLease({
      ...getInput(),
      mediaId: "media-other",
    })).resolves.toMatchObject({ ok: false, reason: "binding_conflict" });
    await expect(getCaptureHeaderLease(getInput())).resolves.toMatchObject({
      ok: true,
      lease: { headers: { authorization: "Bearer private-token" } },
    });
  });

  it("enforces the hard TTL on reads/claims and sweeps every expired owner", async () => {
    await createCaptureHeaderLease(createInput(1, 0));
    await createCaptureHeaderLease(createInput(2, CAPTURE_HEADER_LEASE_TTL_MS - 1));
    await claimCaptureHeaderLease(claimInput(1, 10));
    const now = CAPTURE_HEADER_LEASE_TTL_MS;
    await expect(getCaptureHeaderLease(getInput(1, now))).resolves.toMatchObject({
      ok: false,
      reason: "lease_expired",
    });
    await expect(claimCaptureHeaderLease(claimInput(1, now))).resolves.toMatchObject({
      ok: false,
      reason: "lease_expired",
    });
    const listed = await listCaptureHeaderLeases(now);
    expect(listed).toMatchObject({
      ok: true,
      leases: [{ leaseId: "lease-2" }],
      expiredLeaseIds: ["lease-1"],
    });
    await expect(sweepExpiredCaptureHeaderLeases(now)).resolves.toMatchObject({
      ok: true,
      changed: true,
      removedLeaseIds: ["lease-1"],
    });
    await expect(getCaptureHeaderLease(getInput(1, now))).resolves.toEqual({
      ok: true,
      lease: null,
    });
    expect(storedRegistry().orderedLeaseIds).toEqual(["lease-2"]);
  });

  it("atomically sweeps expired records while creating a new lease", async () => {
    await createCaptureHeaderLease(createInput(1, 0));
    await expect(createCaptureHeaderLease(
      createInput(2, CAPTURE_HEADER_LEASE_TTL_MS),
    )).resolves.toMatchObject({
      ok: true,
      sweptExpiredLeaseIds: ["lease-1"],
    });
    expect(storedRegistry().orderedLeaseIds).toEqual(["lease-2"]);
  });

  it("serializes concurrent creators without dropping sibling leases", async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        createCaptureHeaderLease(createInput(index + 1, 1_000 + index))),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const listed = await listCaptureHeaderLeases(2_000);
    expect(listed.ok && listed.leases).toHaveLength(30);
    expect(new Set(listed.ok ? listed.leases.map((lease) => lease.leaseId) : [])).toHaveLength(30);
  });

  it("never exceeds the active record limit or prunes an unexpired owner", async () => {
    for (let index = 0; index < MAX_CAPTURE_HEADER_LEASE_RECORDS; index += 1) {
      const result = await createCaptureHeaderLease(createInput(index + 1));
      expect(result.ok).toBe(true);
    }
    await expect(createCaptureHeaderLease(
      createInput(MAX_CAPTURE_HEADER_LEASE_RECORDS + 1),
    )).resolves.toMatchObject({
      ok: false,
      reason: "record_capacity",
      limit: MAX_CAPTURE_HEADER_LEASE_RECORDS,
    });
    expect(storedRegistry().orderedLeaseIds).toHaveLength(MAX_CAPTURE_HEADER_LEASE_RECORDS);
  });

  it("enforces the aggregate serialized-byte limit without evicting active owners", async () => {
    const authoritativeHeaders = {
      custom: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
        `x-large-${index}`,
        "v".repeat(8_000),
      ])),
    };
    let failure: Awaited<ReturnType<typeof createCaptureHeaderLease>> | undefined;
    for (let index = 0; index < MAX_CAPTURE_HEADER_LEASE_RECORDS; index += 1) {
      const result = await createCaptureHeaderLease({
        ...createInput(index + 1),
        authoritativeHeaders,
      });
      if (!result.ok) {
        failure = result;
        break;
      }
    }
    expect(failure).toMatchObject({ ok: false, reason: "serialized_byte_limit" });
    const before = storedRegistry().orderedLeaseIds.length;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(MAX_CAPTURE_HEADER_LEASE_RECORDS);
    expect(storedRegistry().orderedLeaseIds).toHaveLength(before);
  }, 30_000);

  it("treats corrupt, accessor-backed, malformed-TTL, and ownerless storage as closed", async () => {
    storage[CAPTURE_HEADER_LEASES_STORAGE_KEY] = { schemaVersion: 2, orderedLeaseIds: [], records: {} };
    await expect(listCaptureHeaderLeases(1)).resolves.toMatchObject({
      ok: false,
      reason: "storage_corrupt",
    });

    let getterCalls = 0;
    const accessorRegistry = { schemaVersion: 1, orderedLeaseIds: [] } as Record<string, unknown>;
    Object.defineProperty(accessorRegistry, "records", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      },
    });
    storage[CAPTURE_HEADER_LEASES_STORAGE_KEY] = accessorRegistry;
    await expect(listCaptureHeaderLeases(1)).resolves.toMatchObject({
      ok: false,
      reason: "storage_corrupt",
    });
    expect(getterCalls).toBe(0);

    await createCaptureHeaderLeaseAfterReset(createInput());
    const rawLease = storedRegistry().records["lease-1"] as Record<string, unknown>;
    rawLease.expiresAt = Number(rawLease.expiresAt) + 1;
    await expect(getCaptureHeaderLease(getInput())).resolves.toMatchObject({
      ok: false,
      reason: "storage_corrupt",
    });

    await createCaptureHeaderLeaseAfterReset(createInput());
    const ownerless = storedRegistry().records["lease-1"] as Record<string, unknown>;
    ownerless.draftItemOwnerActive = false;
    ownerless.acceptedAttemptOwner = null;
    await expect(getCaptureHeaderLease(getInput())).resolves.toMatchObject({
      ok: false,
      reason: "storage_corrupt",
    });
  });

  it("handles prototype-looking lease IDs without prototype pollution", async () => {
    const dangerous = {
      ...createInput(),
      leaseId: "__proto__",
    };
    await expect(createCaptureHeaderLease(dangerous)).resolves.toMatchObject({
      ok: true,
      lease: { leaseId: "__proto__" },
    });
    await expect(getCaptureHeaderLease({
      ...getInput(),
      leaseId: "__proto__",
    })).resolves.toMatchObject({ ok: true, lease: { leaseId: "__proto__" } });
    expect(Object.prototype).not.toHaveProperty("headers");
  });

  it("confirms an applied-then-failed write by exact read-back", async () => {
    setFailure = "after";
    await expect(createCaptureHeaderLease(createInput())).resolves.toMatchObject({
      ok: true,
      changed: true,
      commitState: "committed",
    });
    await expect(getCaptureHeaderLease(getInput())).resolves.toMatchObject({
      ok: true,
      lease: { leaseId: "lease-1" },
    });
  });

  it("distinguishes a definitively absent failed write from unknown read-back", async () => {
    setFailure = "before";
    const absent = await createCaptureHeaderLease(createInput());
    expect(absent).toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      commitState: "absent",
    });
    expect(JSON.stringify(absent)).not.toContain("private-token");

    setFailure = "before";
    const sessionSet = chrome.storage.session.set as ReturnType<typeof vi.fn>;
    sessionSet.mockImplementationOnce(async () => {
      failNextGet = true;
      throw new Error("set failed and read-back unavailable");
    });
    await expect(createCaptureHeaderLease(createInput())).resolves.toMatchObject({
      ok: false,
      reason: "storage_unavailable",
      operation: "set",
      commitState: "unknown",
    });
  });

  it("returns generic storage-read failures without sensitive payloads", async () => {
    failGet = true;
    const result = await createCaptureHeaderLease(createInput());
    expect(result).toEqual({
      ok: false,
      reason: "storage_unavailable",
      operation: "get",
      commitState: "unknown",
      message: "Chrome session storage is unavailable.",
    });
    expect(JSON.stringify(result)).not.toContain("private-token");
  });
});

async function createCaptureHeaderLeaseAfterReset(input: CreateCaptureHeaderLeaseInput) {
  delete storage[CAPTURE_HEADER_LEASES_STORAGE_KEY];
  setFailure = "none";
  const result = await createCaptureHeaderLease(input);
  expect(result.ok).toBe(true);
}
