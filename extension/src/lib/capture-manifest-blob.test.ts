import { describe, expect, it, vi } from "vitest";
import {
  captureManifestBlobCreateErrorIsRetryable,
  CaptureManifestBlobRegistry,
  MAX_CAPTURE_MANIFEST_BLOB_BYTES,
  MAX_CAPTURE_MANIFEST_BLOB_ID_LENGTH,
  captureManifestContentSizeBytes,
  parseCaptureManifestBlobCreateResponse,
  parseCaptureManifestBlobMessage,
  parseCaptureManifestBlobRevokeResponse,
  parseCaptureManifestBlobStatusResponse,
  sha256CaptureManifestContent,
  type CaptureManifestBlobCreateMessage,
  type CaptureManifestBlobRegistryOptions,
} from "./capture-manifest-blob";

const DIGEST = "0".repeat(64);

function createMessage(
  content: string,
  contentDigest: string,
  overrides: Partial<CaptureManifestBlobCreateMessage> = {},
): CaptureManifestBlobCreateMessage {
  return {
    type: "capture-manifest-blob-create",
    runId: "run-1",
    attemptId: "attempt-1",
    format: "json",
    content,
    contentDigest,
    ...overrides,
  };
}

function registryHarness(options: CaptureManifestBlobRegistryOptions = {}) {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  let sequence = 0;
  const registry = new CaptureManifestBlobRegistry({
    createObjectUrl: (blob) => {
      blobs.push(blob);
      sequence += 1;
      return `blob:cliphutch-manifest-${sequence}`;
    },
    revokeObjectUrl: (blobUrl) => {
      revoked.push(blobUrl);
    },
    ...options,
  });
  return { registry, blobs, revoked };
}

describe("capture manifest Blob message parser", () => {
  it("retires one orphaned ID without permanently disabling a fresh attempt", () => {
    expect(captureManifestBlobCreateErrorIsRetryable("ATTEMPT_RETIRED")).toBe(true);
    expect(captureManifestBlobCreateErrorIsRetryable("REGISTRY_FULL")).toBe(true);
    expect(captureManifestBlobCreateErrorIsRetryable("DIGEST_UNAVAILABLE")).toBe(true);
    expect(captureManifestBlobCreateErrorIsRetryable("BLOB_CREATE_FAILED")).toBe(true);
    expect(captureManifestBlobCreateErrorIsRetryable("CONTENT_TOO_LARGE")).toBe(false);
    expect(captureManifestBlobCreateErrorIsRetryable("CONTENT_DIGEST_MISMATCH")).toBe(false);
    expect(captureManifestBlobCreateErrorIsRetryable("IDENTITY_CONFLICT")).toBe(false);
  });

  it("accepts exact create, revoke, and status messages", () => {
    const create = createMessage("{}", DIGEST);
    expect(parseCaptureManifestBlobMessage(create)).toEqual(create);
    expect(
      parseCaptureManifestBlobMessage({
        type: "capture-manifest-blob-create",
        runId: "run-1",
        attemptId: "csv-attempt-1",
        format: "csv",
        content: "name\nCafé\n",
        contentDigest: "a".repeat(64),
      }),
    ).toMatchObject({ format: "csv", content: "name\nCafé\n" });
    expect(
      parseCaptureManifestBlobMessage({
        type: "capture-manifest-blob-revoke",
        runId: "run-1",
        attemptId: "attempt-1",
      }),
    ).toEqual({
      type: "capture-manifest-blob-revoke",
      runId: "run-1",
      attemptId: "attempt-1",
    });
    expect(parseCaptureManifestBlobMessage({ type: "capture-manifest-blob-status" })).toEqual({
      type: "capture-manifest-blob-status",
    });
  });

  it("enforces the 1 MiB UTF-8 limit, including multibyte content", () => {
    const exact = "😀".repeat(MAX_CAPTURE_MANIFEST_BLOB_BYTES / 4);
    expect(captureManifestContentSizeBytes(exact)).toBe(MAX_CAPTURE_MANIFEST_BLOB_BYTES);
    expect(parseCaptureManifestBlobMessage(createMessage(exact, DIGEST))).toBeDefined();
    expect(parseCaptureManifestBlobMessage(createMessage(`${exact}a`, DIGEST))).toBeUndefined();
  });

  it("rejects extra authority, unsafe IDs, and malformed digests", () => {
    const create = createMessage("{}", DIGEST);
    expect(parseCaptureManifestBlobMessage({ ...create, mimeType: "text/html" })).toBeUndefined();
    expect(parseCaptureManifestBlobMessage({ ...create, blobUrl: "blob:attacker" })).toBeUndefined();
    expect(parseCaptureManifestBlobMessage({ ...create, runId: "../run" })).toBeUndefined();
    expect(parseCaptureManifestBlobMessage({ ...create, attemptId: "attempt/1" })).toBeUndefined();
    expect(
      parseCaptureManifestBlobMessage({
        ...create,
        runId: "r".repeat(MAX_CAPTURE_MANIFEST_BLOB_ID_LENGTH + 1),
      }),
    ).toBeUndefined();
    expect(parseCaptureManifestBlobMessage({ ...create, contentDigest: "A".repeat(64) })).toBeUndefined();
    expect(parseCaptureManifestBlobMessage({ ...create, contentDigest: "a".repeat(63) })).toBeUndefined();
    expect(parseCaptureManifestBlobMessage({ ...create, format: "html" })).toBeUndefined();
    expect(
      parseCaptureManifestBlobMessage({
        type: "capture-manifest-blob-status",
        runId: "run-1",
      }),
    ).toBeUndefined();
    expect(
      parseCaptureManifestBlobMessage({
        type: "capture-manifest-blob-revoke",
        runId: "run-1",
        attemptId: "attempt-1",
        all: true,
      }),
    ).toBeUndefined();
  });

  it("fails closed on accessors and hostile proxies without invoking getters", () => {
    let getterCalls = 0;
    const accessor = {
      runId: "run-1",
      attemptId: "attempt-1",
      format: "json",
      content: "{}",
      contentDigest: DIGEST,
    };
    Object.defineProperty(accessor, "type", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "capture-manifest-blob-create";
      },
    });
    expect(parseCaptureManifestBlobMessage(accessor)).toBeUndefined();
    expect(getterCalls).toBe(0);

    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new Error("hostile proxy");
      },
    });
    expect(() => parseCaptureManifestBlobMessage(hostile)).not.toThrow();
    expect(parseCaptureManifestBlobMessage(hostile)).toBeUndefined();
  });
});

describe("CaptureManifestBlobRegistry", () => {
  it("verifies SHA-256, fixes MIME by format, and creates a UTF-8 Blob", async () => {
    const content = '{"title":"Café 😀"}\n';
    const digest = await sha256CaptureManifestContent(content);
    const { registry, blobs } = registryHarness();
    const response = await registry.create(createMessage(content, digest));

    expect(response).toEqual({
      ok: true,
      runId: "run-1",
      attemptId: "attempt-1",
      format: "json",
      contentDigest: digest,
      blobUrl: "blob:cliphutch-manifest-1",
      sizeBytes: captureManifestContentSizeBytes(content),
      mimeType: "application/json;charset=utf-8",
    });
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toBe("application/json;charset=utf-8");
    await expect(blobs[0]?.text()).resolves.toBe(content);

    const csv = "name\nCafé\n";
    const csvDigest = await sha256CaptureManifestContent(csv);
    const csvResponse = await registry.create(
      createMessage(csv, csvDigest, {
        runId: "run-2",
        attemptId: "attempt-2",
        format: "csv",
      }),
    );
    expect(csvResponse).toMatchObject({
      ok: true,
      mimeType: "text/csv;charset=utf-8",
      sizeBytes: captureManifestContentSizeBytes(csv),
    });
    expect(blobs[1]?.type).toBe("text/csv;charset=utf-8");
  });

  it("returns the same Blob for an exact identity and digest replay", async () => {
    const content = "{}";
    const digest = await sha256CaptureManifestContent(content);
    const { registry, blobs } = registryHarness();
    const message = createMessage(content, digest);

    const first = await registry.create(message);
    const duplicate = await registry.create(message);
    expect(duplicate).toEqual(first);
    expect(blobs).toHaveLength(1);
  });

  it("coalesces concurrent exact replays after digest verification", async () => {
    const content = "{}";
    const digest = await sha256CaptureManifestContent(content);
    const { registry, blobs } = registryHarness();
    const message = createMessage(content, digest);

    const [first, second] = await Promise.all([
      registry.create(message),
      registry.create(message),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, blobUrl: "blob:cliphutch-manifest-1" });
    expect(blobs).toHaveLength(1);
  });

  it("lets an exact revoke win while create is still hashing", async () => {
    const content = "{}";
    const digest = await sha256CaptureManifestContent(content);
    let resolveDigest: ((value: string) => void) | undefined;
    const digestText = () => new Promise<string>((resolve) => {
      resolveDigest = resolve;
    });
    const { registry, blobs } = registryHarness({ digestText });
    const pending = registry.create(createMessage(content, digest));

    expect(registry.revoke({ runId: "run-1", attemptId: "attempt-1" })).toEqual({
      ok: true,
      runId: "run-1",
      attemptId: "attempt-1",
    });
    resolveDigest?.(digest);
    await expect(pending).resolves.toMatchObject({ ok: false, code: "ATTEMPT_RETIRED" });
    expect(blobs).toEqual([]);
  });

  it("rejects reuse of an active identity with a different digest or format", async () => {
    const content = "{}";
    const digest = await sha256CaptureManifestContent(content);
    const otherContent = "{\"changed\":true}";
    const otherDigest = await sha256CaptureManifestContent(otherContent);
    const { registry, blobs } = registryHarness();
    await registry.create(createMessage(content, digest));

    await expect(registry.create(createMessage(otherContent, otherDigest))).resolves.toEqual({
      ok: false,
      runId: "run-1",
      attemptId: "attempt-1",
      code: "IDENTITY_CONFLICT",
    });
    await expect(
      registry.create(createMessage(content, digest, { format: "csv" })),
    ).resolves.toMatchObject({ ok: false, code: "IDENTITY_CONFLICT" });
    expect(blobs).toHaveLength(1);
  });

  it("rejects a digest mismatch before allocating a Blob", async () => {
    const { registry, blobs } = registryHarness();
    await expect(registry.create(createMessage("{}", DIGEST))).resolves.toEqual({
      ok: false,
      runId: "run-1",
      attemptId: "attempt-1",
      code: "CONTENT_DIGEST_MISMATCH",
    });
    expect(blobs).toHaveLength(0);
    expect(registry.status()).toEqual([]);
  });

  it("enforces the byte bound inside the registry as well as at message ingress", async () => {
    const digestText = vi.fn(async () => DIGEST);
    const { registry, blobs } = registryHarness({ digestText });
    const oversized = "a".repeat(MAX_CAPTURE_MANIFEST_BLOB_BYTES + 1);
    await expect(registry.create(createMessage(oversized, DIGEST))).resolves.toEqual({
      ok: false,
      runId: "run-1",
      attemptId: "attempt-1",
      code: "CONTENT_TOO_LARGE",
    });
    expect(digestText).not.toHaveBeenCalled();
    expect(blobs).toEqual([]);
  });

  it("revokes only an exact identity and tombstones revoke-before-create", async () => {
    const content = "{}";
    const digest = await sha256CaptureManifestContent(content);
    const { registry, revoked } = registryHarness();
    await registry.create(createMessage(content, digest));

    expect(registry.revoke({ runId: "run-1", attemptId: "other-attempt" })).toEqual({
      ok: true,
      runId: "run-1",
      attemptId: "other-attempt",
    });
    expect(revoked).toEqual([]);
    expect(registry.status()).toHaveLength(1);
    await expect(
      registry.create(createMessage(content, digest, { attemptId: "other-attempt" })),
    ).resolves.toMatchObject({ ok: false, code: "ATTEMPT_RETIRED" });

    expect(registry.revoke({ runId: "run-1", attemptId: "attempt-1" })).toEqual({
      ok: true,
      runId: "run-1",
      attemptId: "attempt-1",
    });
    expect(revoked).toEqual(["blob:cliphutch-manifest-1"]);
    registry.revoke({ runId: "run-1", attemptId: "attempt-1" });
    expect(revoked).toEqual(["blob:cliphutch-manifest-1"]);
    await expect(registry.create(createMessage(content, digest))).resolves.toMatchObject({
      ok: false,
      code: "ATTEMPT_RETIRED",
    });
  });

  it("bounds active entries and tombstones", async () => {
    const content = "{}";
    const digest = await sha256CaptureManifestContent(content);
    const { registry } = registryHarness({ maxActive: 1, maxTombstones: 1 });
    await registry.create(createMessage(content, digest));
    await expect(
      registry.create(createMessage(content, digest, { runId: "run-2", attemptId: "attempt-2" })),
    ).resolves.toMatchObject({ ok: false, code: "REGISTRY_FULL" });

    registry.revoke({ runId: "run-1", attemptId: "attempt-1" });
    await expect(
      registry.create(createMessage(content, digest, { runId: "run-2", attemptId: "attempt-2" })),
    ).resolves.toMatchObject({ ok: true });
    registry.revoke({ runId: "run-2", attemptId: "attempt-2" });

    await expect(registry.create(createMessage(content, digest))).resolves.toMatchObject({ ok: true });
  });

  it("returns bounded metadata-only status", async () => {
    const content = "{}";
    const digest = await sha256CaptureManifestContent(content);
    const { registry } = registryHarness({ maxActive: 3, maxStatusEntries: 1, now: () => 50 });
    await registry.create(createMessage(content, digest));
    await registry.create(
      createMessage(content, digest, { runId: "run-2", attemptId: "attempt-2" }),
    );

    const status = registry.status();
    expect(status).toEqual([
      {
        runId: "run-1",
        attemptId: "attempt-1",
        format: "json",
        contentDigest: digest,
        sizeBytes: 2,
        mimeType: "application/json;charset=utf-8",
        expiresAt: 3_600_050,
      },
    ]);
    expect(status[0]).not.toHaveProperty("content");
    expect(status[0]).not.toHaveProperty("blobUrl");
  });

  it("expires orphaned Blobs, revokes them, and retires their identities", async () => {
    let now = 1_000;
    const content = "{}";
    const digest = await sha256CaptureManifestContent(content);
    const { registry, revoked } = registryHarness({ ttlMs: 100, now: () => now });
    await registry.create(createMessage(content, digest));
    expect(registry.nextExpiryAt()).toBe(1_100);

    now = 1_099;
    expect(registry.sweepExpired()).toBe(0);
    now = 1_100;
    expect(registry.sweepExpired()).toBe(1);
    expect(revoked).toEqual(["blob:cliphutch-manifest-1"]);
    expect(registry.nextExpiryAt()).toBeUndefined();
    await expect(registry.create(createMessage(content, digest))).resolves.toMatchObject({
      ok: false,
      code: "ATTEMPT_RETIRED",
    });
  });

  it("fails safely when digest or object URL creation is unavailable", async () => {
    const digestFailure = registryHarness({
      digestText: async () => {
        throw new Error("crypto unavailable");
      },
    });
    await expect(digestFailure.registry.create(createMessage("{}", DIGEST))).resolves.toMatchObject({
      ok: false,
      code: "DIGEST_UNAVAILABLE",
    });

    const content = "{}";
    const digest = await sha256CaptureManifestContent(content);
    const createObjectUrl = vi.fn(() => {
      throw new Error("URL allocation failed");
    });
    const blobFailure = registryHarness({ createObjectUrl });
    await expect(blobFailure.registry.create(createMessage(content, digest))).resolves.toMatchObject({
      ok: false,
      code: "BLOB_CREATE_FAILED",
    });
    expect(blobFailure.registry.status()).toEqual([]);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid registry bounds", () => {
    expect(() => new CaptureManifestBlobRegistry({ maxActive: 0 })).toThrow(TypeError);
    expect(() => new CaptureManifestBlobRegistry({ maxTombstones: 0 })).toThrow(TypeError);
    expect(() => new CaptureManifestBlobRegistry({ maxStatusEntries: 0 })).toThrow(TypeError);
    expect(() => new CaptureManifestBlobRegistry({ ttlMs: 0 })).toThrow(TypeError);
  });

  it("strictly parses create, revoke, and metadata-only status responses", () => {
    expect(parseCaptureManifestBlobCreateResponse({
      ok: true,
      runId: "run-1",
      attemptId: "attempt-1",
      format: "json",
      contentDigest: DIGEST,
      blobUrl: "blob:chrome-extension://extension-id/manifest",
      sizeBytes: 2,
      mimeType: "application/json;charset=utf-8",
    })).toMatchObject({ ok: true, runId: "run-1", format: "json" });
    expect(parseCaptureManifestBlobCreateResponse({
      ok: false,
      runId: "run-1",
      attemptId: "attempt-1",
      code: "REGISTRY_FULL",
    })).toMatchObject({ ok: false, code: "REGISTRY_FULL" });
    expect(parseCaptureManifestBlobRevokeResponse({
      ok: true, runId: "run-1", attemptId: "attempt-1",
    })).toEqual({ ok: true, runId: "run-1", attemptId: "attempt-1" });
    expect(parseCaptureManifestBlobStatusResponse({
      ok: true,
      active: [{
        runId: "run-1",
        attemptId: "attempt-1",
        format: "json",
        contentDigest: DIGEST,
        sizeBytes: 2,
        mimeType: "application/json;charset=utf-8",
        expiresAt: 100,
      }],
    })).toMatchObject({ ok: true, active: [{ runId: "run-1", format: "json" }] });
  });

  it("rejects response extras, duplicate status identities, and unsafe Blob metadata", () => {
    expect(parseCaptureManifestBlobCreateResponse({
      ok: true,
      runId: "run-1",
      attemptId: "attempt-1",
      format: "json",
      contentDigest: DIGEST,
      blobUrl: "https://example.test/not-a-blob",
      sizeBytes: 2,
      mimeType: "application/json;charset=utf-8",
    })).toBeUndefined();
    const entry = {
      runId: "run-1",
      attemptId: "attempt-1",
      format: "json",
      contentDigest: DIGEST,
      sizeBytes: 2,
      mimeType: "application/json;charset=utf-8",
      expiresAt: 100,
    };
    expect(parseCaptureManifestBlobStatusResponse({ ok: true, active: [entry, entry] }))
      .toBeUndefined();
    expect(parseCaptureManifestBlobRevokeResponse({
      ok: true, runId: "run-1", attemptId: "attempt-1", secret: "no",
    })).toBeUndefined();
  });
});
