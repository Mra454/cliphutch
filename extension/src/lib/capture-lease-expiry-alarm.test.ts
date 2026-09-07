import { describe, expect, it } from "vitest";
import {
  CAPTURE_CLEANUP_FAST_RETRY_LIMIT,
  CAPTURE_LEASE_EXPIRY_RETRY_MS,
  nextCaptureLeaseExpiryAlarmTime,
  planCaptureCleanupRetry,
} from "./capture-lease-expiry-alarm";

describe("nextCaptureLeaseExpiryAlarmTime", () => {
  it("schedules the earliest active lease expiry", () => {
    expect(nextCaptureLeaseExpiryAlarmTime({
      activeExpiresAt: [9_000, 5_000, 7_000],
      expiredLeaseCount: 0,
    }, 1_000)).toBe(5_000);
  });

  it("uses a bounded retry wake while expired secrets remain", () => {
    expect(nextCaptureLeaseExpiryAlarmTime({
      activeExpiresAt: [9_000],
      expiredLeaseCount: 1,
    }, 1_000)).toBe(1_000 + CAPTURE_LEASE_EXPIRY_RETRY_MS);
  });

  it("clears the alarm for an empty registry", () => {
    expect(nextCaptureLeaseExpiryAlarmTime({
      activeExpiresAt: [],
      expiredLeaseCount: 0,
    }, 1_000)).toBeUndefined();
  });

  it("fails closed for malformed or contradictory snapshots", () => {
    expect(nextCaptureLeaseExpiryAlarmTime({
      activeExpiresAt: [999],
      expiredLeaseCount: 0,
    }, 1_000)).toBeUndefined();
    expect(nextCaptureLeaseExpiryAlarmTime({
      activeExpiresAt: [],
      expiredLeaseCount: -1,
    }, 1_000)).toBeUndefined();
    expect(nextCaptureLeaseExpiryAlarmTime({
      activeExpiresAt: Array.from({ length: 201 }, (_, index) => 2_000 + index),
      expiredLeaseCount: 0,
    }, 1_000)).toBeUndefined();
  });
});

describe("planCaptureCleanupRetry", () => {
  it("uses a bounded fast burst and then a durable alarm", () => {
    let attempt = 0;
    for (let index = 0; index < CAPTURE_CLEANUP_FAST_RETRY_LIMIT; index += 1) {
      const plan = planCaptureCleanupRetry(true, attempt);
      expect(plan.kind).toBe("timer");
      attempt = plan.nextAttempt;
    }
    expect(planCaptureCleanupRetry(true, attempt)).toEqual({
      kind: "alarm",
      delayMs: CAPTURE_LEASE_EXPIRY_RETRY_MS,
      nextAttempt: CAPTURE_CLEANUP_FAST_RETRY_LIMIT,
    });
    // A later alarm wake resets the burst; the seventh execution is not lost.
    expect(planCaptureCleanupRetry(true, 0).kind).toBe("timer");
  });

  it("clears retry state immediately after successful cleanup", () => {
    expect(planCaptureCleanupRetry(false, 99)).toEqual({ kind: "clear", nextAttempt: 0 });
  });
});
