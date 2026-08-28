import { describe, it, expect, beforeEach } from "vitest";
import {
  CAPTURE_QUOTA_BATCHES_STORAGE_KEY,
  FREE_DOWNLOAD_LIMIT,
  VIDEO_DOWNLOAD_HISTORY_KEY,
  chargeDownloadReservation,
  getDownloadCount,
  isRateLimited,
  markDownloadBatchAccepted,
  parseStoredDownloadBatchIndex,
  reconcileDownloadBatchReservations,
  recordDownload,
  releaseDownloadReservations,
  releaseDownloadReservation,
  reserveDownloads,
  reserveDownload,
  resetHistory,
  settleDownloadReservation,
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

  it("reserves a batch all-or-none while preserving the history array", async () => {
    await recordDownload(1000);
    const rejected = await reserveDownloads("batch-too-large", FREE_DOWNLOAD_LIMIT, 1001);
    expect(rejected).toBeNull();
    expect(await getDownloadCount(1001)).toBe(1);

    const reservation = await reserveDownloads("batch-accepted", 3, 1002);
    expect(reservation).toMatchObject({
      batchId: "batch-accepted",
      count: 3,
      reservedAt: 1002,
    });
    expect(reservation?.reservations).toHaveLength(3);
    expect(Array.isArray(store["video-download-history"])).toBe(true);
    expect(await getDownloadCount(1002)).toBe(FREE_DOWNLOAD_LIMIT);
  });

  it("replays the exact batch reservation without consuming quota twice", async () => {
    const first = await reserveDownloads("batch-replay", 2, 1000);
    const replay = await reserveDownloads("batch-replay", 2, 2000);
    expect(replay).toEqual(first);
    expect(await getDownloadCount(2000)).toBe(2);
  });

  it("rejects a different-count replay without changing history", async () => {
    const first = await reserveDownloads("batch-conflict", 2, 1000);
    await expect(reserveDownloads("batch-conflict", 3, 1001)).rejects.toThrow(
      /already reserved for 2 downloads, not 3/i,
    );
    expect(await getDownloadCount(1001)).toBe(2);
    expect(await reserveDownloads("batch-conflict", 2, 1002)).toEqual(first);
  });

  it("serializes concurrent batches without partially exceeding the limit", async () => {
    const attempts = await Promise.all([
      reserveDownloads("batch-a", 2, 1000),
      reserveDownloads("batch-b", 2, 1000),
      reserveDownloads("batch-c", 2, 1000),
    ]);
    expect(attempts.filter(Boolean)).toHaveLength(2);
    expect(attempts[2]).toBeNull();
    expect(await getDownloadCount(1000)).toBe(FREE_DOWNLOAD_LIMIT);
  });

  it("serializes concurrent replays of one batch to one exact allocation", async () => {
    const [first, second, third] = await Promise.all([
      reserveDownloads("same-batch", 2, 1000),
      reserveDownloads("same-batch", 2, 1001),
      reserveDownloads("same-batch", 2, 1002),
    ]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await getDownloadCount(1002)).toBe(2);
  });

  it("validates batch ids, counts, and timestamps before touching storage", async () => {
    await expect(reserveDownloads("", 1, 1000)).rejects.toThrow(/batchId/i);
    await expect(reserveDownloads(" padded ", 1, 1000)).rejects.toThrow(/batchId/i);
    await expect(reserveDownloads("batch", 0, 1000)).rejects.toThrow(/count/i);
    await expect(reserveDownloads("batch", 1.5, 1000)).rejects.toThrow(/count/i);
    await expect(reserveDownloads("batch", FREE_DOWNLOAD_LIMIT + 1, 1000)).rejects.toThrow(/count/i);
    await expect(reserveDownloads("batch", 1, Number.NaN)).rejects.toThrow(/now/i);
    expect(await getDownloadCount(1000)).toBe(0);
  });

  it("releases a complete batch idempotently without removing legacy events", async () => {
    await recordDownload(900);
    const reservation = await reserveDownloads("batch-release", 2, 1000);
    expect(await getDownloadCount(1000)).toBe(3);

    await releaseDownloadReservations(reservation ?? undefined, 1001);
    expect(await getDownloadCount(1001)).toBe(1);
    await releaseDownloadReservations(reservation ?? undefined, 1002);
    await releaseDownloadReservations("batch-release", 1003);
    expect(await getDownloadCount(1003)).toBe(1);
  });

  it("rejects a forged batch release and leaves every reservation intact", async () => {
    const reservation = await reserveDownloads("batch-release-guard", 2, 1000);
    if (!reservation) throw new Error("Expected a batch reservation");
    const forged = {
      ...reservation,
      reservations: [{ id: "not-the-reserved-id" }, reservation.reservations[1]],
    };
    await expect(releaseDownloadReservations(forged, 1001)).rejects.toThrow(/does not match/i);
    expect(await getDownloadCount(1001)).toBe(2);
  });

  it("settles accepted batch members independently and idempotently", async () => {
    const reservation = await reserveDownloads("batch-single-release", 2, 1000);
    if (!reservation) throw new Error("Expected a batch reservation");
    await markDownloadBatchAccepted(reservation.batchId, 1001);
    await releaseDownloadReservation(reservation.reservations[0], 1002);
    await releaseDownloadReservation(reservation.reservations[0], 1003);
    expect(await getDownloadCount(1003)).toBe(1);
    await releaseDownloadReservation(reservation.reservations[1], 1004);
    expect(await getDownloadCount(1004)).toBe(0);
    await expect(reserveDownloads("batch-single-release", 2, 1005)).rejects.toThrow(
      /already accepted/i,
    );
  });

  it("persists mixed charged/released outcomes without refunding charged members", async () => {
    const reservation = await reserveDownloads("batch-mixed", 3, 1000);
    if (!reservation) throw new Error("Expected a batch reservation");
    await markDownloadBatchAccepted(reservation.batchId, 1001);
    expect(await chargeDownloadReservation(reservation.reservations[0], 1002)).toMatchObject({
      changed: true,
      state: "charged",
    });
    expect(await releaseDownloadReservation(reservation.reservations[1], 1003)).toBeUndefined();
    expect(await chargeDownloadReservation(reservation.reservations[2], 1004)).toMatchObject({
      changed: true,
      state: "charged",
    });
    expect(await settleDownloadReservation(reservation.reservations[0], "released", 1005)).toMatchObject({
      changed: false,
      state: "charged",
    });
    expect(await getDownloadCount(1005)).toBe(2);
    expect(store[CAPTURE_QUOTA_BATCHES_STORAGE_KEY]).toMatchObject({
      batches: {
        "batch-mixed": {
          state: "settled",
          members: [
            { state: "charged" },
            { state: "released" },
            { state: "charged" },
          ],
        },
      },
    });
    expect(store[VIDEO_DOWNLOAD_HISTORY_KEY]).toHaveLength(2);
  });

  it("reconciles a lost session owner by releasing only uncharged reservations", async () => {
    const reservation = await reserveDownloads("batch-session-loss", 2, 1000);
    if (!reservation) throw new Error("Expected a batch reservation");
    await markDownloadBatchAccepted(reservation.batchId, 1001);
    await chargeDownloadReservation(reservation.reservations[0], 1002);

    const reconciled = await reconcileDownloadBatchReservations([], 1003);
    expect(reconciled).toMatchObject({
      changed: true,
      acceptedBatchIds: [],
      chargedReservationIds: [reservation.reservations[0].id],
      releasedReservationIds: [reservation.reservations[1].id],
    });
    expect(await getDownloadCount(1003)).toBe(1);
    expect(store[CAPTURE_QUOTA_BATCHES_STORAGE_KEY]).toMatchObject({
      batches: { "batch-session-loss": { state: "settled" } },
    });
  });

  it("migrates a complete legacy batch projection into redacted control state", async () => {
    store[VIDEO_DOWNLOAD_HISTORY_KEY] = [
      { at: 1000, id: "legacy-1", batchId: "legacy-batch", batchCount: 2, batchIndex: 0 },
      { at: 1000, id: "legacy-2", batchId: "legacy-batch", batchCount: 2, batchIndex: 1 },
    ];
    const result = await reconcileDownloadBatchReservations(["legacy-batch"], 1001);
    expect(result).toMatchObject({ changed: true, acceptedBatchIds: ["legacy-batch"] });
    expect(store[CAPTURE_QUOTA_BATCHES_STORAGE_KEY]).toMatchObject({
      schemaVersion: 1,
      batches: {
        "legacy-batch": {
          state: "accepted",
          count: 2,
          members: [{ id: "legacy-1" }, { id: "legacy-2" }],
        },
      },
    });
    expect(await getDownloadCount(1001)).toBe(2);
  });

  it("rejects future, impossible, and incomplete quota control records without overwriting", async () => {
    expect(parseStoredDownloadBatchIndex({ schemaVersion: 2 })).toEqual({
      status: "invalid",
      reason: "future_schema",
      schemaVersion: 2,
    });
    expect(
      parseStoredDownloadBatchIndex({
        schemaVersion: 1,
        orderedBatchIds: ["impossible"],
        batches: {
          impossible: {
            schemaVersion: 1,
            batchId: "impossible",
            count: 1,
            reservedAt: 1000,
            state: "accepted",
            members: [{ id: "member-1", state: "charged" }],
          },
        },
      }),
    ).toMatchObject({ status: "invalid", reason: "corrupt" });

    store[VIDEO_DOWNLOAD_HISTORY_KEY] = [
      { at: 1000, id: "only-one", batchId: "incomplete", batchCount: 2, batchIndex: 0 },
    ];
    await expect(reconcileDownloadBatchReservations([], 1001)).rejects.toMatchObject({
      code: "storage_corrupt",
    });
    expect(store[CAPTURE_QUOTA_BATCHES_STORAGE_KEY]).toBeUndefined();
  });
});
