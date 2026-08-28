export const CAPTURE_LEASE_EXPIRY_ALARM_NAME = "capture-header-lease-expiry-v1";
export const CAPTURE_CLEANUP_RETRY_ALARM_NAME = "capture-cleanup-retry-v1";

// Chrome may defer alarms, but a failed expiry cleanup must receive another
// browser wake without spinning the service worker or polling continuously.
export const CAPTURE_LEASE_EXPIRY_RETRY_MS = 60_000;
export const CAPTURE_CLEANUP_FAST_RETRY_LIMIT = 5;

export type CaptureCleanupRetryPlan =
  | { kind: "clear"; nextAttempt: 0 }
  | { kind: "timer"; delayMs: number; nextAttempt: number }
  | { kind: "alarm"; delayMs: typeof CAPTURE_LEASE_EXPIRY_RETRY_MS; nextAttempt: number };

export function planCaptureCleanupRetry(
  pending: boolean,
  attempt: number,
): CaptureCleanupRetryPlan {
  if (!pending) return { kind: "clear", nextAttempt: 0 };
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    return { kind: "alarm", delayMs: CAPTURE_LEASE_EXPIRY_RETRY_MS, nextAttempt: 0 };
  }
  if (attempt >= CAPTURE_CLEANUP_FAST_RETRY_LIMIT) {
    return { kind: "alarm", delayMs: CAPTURE_LEASE_EXPIRY_RETRY_MS, nextAttempt: attempt };
  }
  return {
    kind: "timer",
    delayMs: Math.min(4_000, 250 * 2 ** attempt),
    nextAttempt: attempt + 1,
  };
}

export type CaptureLeaseExpiryAlarmSnapshot = {
  activeExpiresAt: readonly number[];
  expiredLeaseCount: number;
};

/**
 * Returns the absolute time for the one-shot lease-expiry alarm.
 *
 * Expired records use a bounded retry wake. Active records schedule the exact
 * earliest TTL; an empty registry clears the named alarm.
 */
export function nextCaptureLeaseExpiryAlarmTime(
  snapshot: CaptureLeaseExpiryAlarmSnapshot,
  now: number,
): number | undefined {
  if (!Number.isSafeInteger(now) || now < 0) return undefined;
  if (
    !Number.isSafeInteger(snapshot.expiredLeaseCount) ||
    snapshot.expiredLeaseCount < 0 ||
    snapshot.expiredLeaseCount > 200 ||
    !Array.isArray(snapshot.activeExpiresAt) ||
    snapshot.activeExpiresAt.length > 200
  ) return undefined;
  if (snapshot.expiredLeaseCount > 0) return now + CAPTURE_LEASE_EXPIRY_RETRY_MS;

  let earliest: number | undefined;
  for (const expiresAt of snapshot.activeExpiresAt) {
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return undefined;
    if (earliest === undefined || expiresAt < earliest) earliest = expiresAt;
  }
  return earliest;
}
