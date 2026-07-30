import { describe, it, expect, beforeEach } from "vitest";
import {
  FREE_DOWNLOAD_LIMIT,
  getDownloadCount,
  isRateLimited,
  recordDownload,
  releaseDownloadReservation,
  reserveDownload,
  resetHistory,
} from "./rate-limit";

let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get(keys: string | string[] | Record<string, unknown>) {
          const result: Record<string, unknown> = {};
          if (typeof keys === "string") {
            if (keys in store) result[keys] = store[keys];
          } else if (Array.isArray(keys)) {
            for (const k of keys) if (k in store) result[k] = store[k];
          }
          return Promise.resolve(result);
        },
        set(items: Record<string, unknown>) {
          Object.assign(store, items);
          return Promise.resolve();
        },
        remove(keys: string | string[]) {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete store[k];
          return Promise.resolve();
        },
      },
    },
  };
});

const HOUR = 60 * 60 * 1000;

describe("rate-limit", () => {
  it("empty history → count 0", async () => {
    expect(await getDownloadCount()).toBe(0);
    expect(await isRateLimited()).toBe(false);
  });

  it("recording one download → count 1", async () => {
    await recordDownload(1000);
    expect(await getDownloadCount(1000)).toBe(1);
  });

  it("at FREE_DOWNLOAD_LIMIT → isRateLimited true", async () => {
    const now = 100_000;
    for (let i = 0; i < FREE_DOWNLOAD_LIMIT; i++) {
      await recordDownload(now + i);
    }
    expect(await isRateLimited(now + FREE_DOWNLOAD_LIMIT)).toBe(true);
  });

  it("one below limit → isRateLimited false", async () => {
    const now = 100_000;
    for (let i = 0; i < FREE_DOWNLOAD_LIMIT - 1; i++) {
      await recordDownload(now + i);
    }
    expect(await isRateLimited(now + FREE_DOWNLOAD_LIMIT)).toBe(false);
  });

  it("events older than 24h pruned from count", async () => {
    const now = 1_000_000_000;
    await recordDownload(now - 25 * HOUR); // outside window
    await recordDownload(now - 23 * HOUR); // inside window
    await recordDownload(now - 1 * HOUR); // inside window
    expect(await getDownloadCount(now)).toBe(2);
  });

  it("recordDownload prunes when adding", async () => {
    const now = 1_000_000_000;
    await recordDownload(now - 25 * HOUR);
    await recordDownload(now); // also prunes the old one
    expect(await getDownloadCount(now)).toBe(1);
  });

  it("sliding window: limit hit then becomes available 24h later", async () => {
    const t0 = 1_000_000_000;
    for (let i = 0; i < FREE_DOWNLOAD_LIMIT; i++) {
      await recordDownload(t0 + i * 1000);
    }
    expect(await isRateLimited(t0 + 100)).toBe(true);
    // Move forward past the window
    expect(await isRateLimited(t0 + 25 * HOUR)).toBe(false);
  });

  it("resetHistory clears all events", async () => {
    await recordDownload(1000);
    await recordDownload(2000);
    await resetHistory();
    expect(await getDownloadCount(3000)).toBe(0);
  });

  it("reserveDownload counts a started download immediately", async () => {
    const reservation = await reserveDownload(1000);
    expect(reservation).not.toBeNull();
    expect(await getDownloadCount(1000)).toBe(1);
  });

  it("reserveDownload refuses reservations at the free limit", async () => {
    const now = 100_000;
    for (let i = 0; i < FREE_DOWNLOAD_LIMIT; i++) {
      expect(await reserveDownload(now + i)).not.toBeNull();
    }
    expect(await reserveDownload(now + FREE_DOWNLOAD_LIMIT)).toBeNull();
  });

  it("releaseDownloadReservation frees a reserved slot after failure", async () => {
    const now = 100_000;
    const reservation = await reserveDownload(now);
    expect(reservation).not.toBeNull();
    await releaseDownloadReservation(reservation ?? undefined, now + 1);
    expect(await getDownloadCount(now + 2)).toBe(0);
  });

  it("serializes concurrent reservations so a bulk start cannot exceed the limit", async () => {
    const attempts = await Promise.all(
      Array.from({ length: FREE_DOWNLOAD_LIMIT + 3 }, (_, i) => reserveDownload(1000 + i)),
    );
    expect(attempts.filter(Boolean)).toHaveLength(FREE_DOWNLOAD_LIMIT);
    expect(await getDownloadCount(2000)).toBe(FREE_DOWNLOAD_LIMIT);
  });
});
