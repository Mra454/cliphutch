export const DOWNLOAD_COMMAND_RECORDS_KEY = "download-command-records";

const DOWNLOAD_COMMAND_PREFIX = "download-";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createDownloadCommandId(
  randomUUID: () => string = () => crypto.randomUUID(),
): string {
  return `${DOWNLOAD_COMMAND_PREFIX}${randomUUID()}`;
}

export function isDownloadCommandId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(DOWNLOAD_COMMAND_PREFIX) &&
    UUID_PATTERN.test(value.slice(DOWNLOAD_COMMAND_PREFIX.length))
  );
}

export type PendingIntentLatch = { current: boolean };

/** Synchronous guard used before React state has had a chance to render. */
export function claimPendingIntent(latch: PendingIntentLatch): boolean {
  if (latch.current) return false;
  latch.current = true;
  return true;
}

export function clearPendingIntent(latch: PendingIntentLatch): void {
  latch.current = false;
}

export type PersistentCommandRecord<Response> =
  | {
      version: 1;
      state: "pending";
      startedAt: number;
    }
  | {
      version: 1;
      state: "settled";
      startedAt: number;
      settledAt: number;
      response: Response;
    };

export type PersistentCommandStore<Response> = {
  read(commandId: string): Promise<PersistentCommandRecord<Response> | undefined>;
  write(commandId: string, record: PersistentCommandRecord<Response>): Promise<void>;
};

/**
 * Coalesces same-context replays and persists enough control state for a new
 * service-worker instance to return the already accepted outcome. A persisted
 * pending record is never executed a second time: the caller must reconcile it
 * against durable side effects or return an interruption result.
 */
export class PersistentCommandGate<Response> {
  private readonly inFlight = new Map<string, Promise<Response>>();

  constructor(
    private readonly store: PersistentCommandStore<Response>,
    private readonly recoverPending: (commandId: string) => Promise<Response>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  run(commandId: string, execute: () => Promise<Response>): Promise<Response> {
    const current = this.inFlight.get(commandId);
    if (current) return current;

    const operation = this.runOnce(commandId, execute);
    this.inFlight.set(commandId, operation);
    void operation.finally(() => {
      if (this.inFlight.get(commandId) === operation) {
        this.inFlight.delete(commandId);
      }
    }).catch(() => undefined);
    return operation;
  }

  private async runOnce(
    commandId: string,
    execute: () => Promise<Response>,
  ): Promise<Response> {
    const stored = await this.store.read(commandId);
    if (stored?.version === 1 && stored.state === "settled") {
      return stored.response;
    }
    if (stored?.version === 1 && stored.state === "pending") {
      const recovered = await this.recoverPending(commandId);
      await this.store.write(commandId, {
        version: 1,
        state: "settled",
        startedAt: stored.startedAt,
        settledAt: this.now(),
        response: recovered,
      });
      return recovered;
    }

    const startedAt = this.now();
    await this.store.write(commandId, { version: 1, state: "pending", startedAt });
    const response = await execute();
    await this.store.write(commandId, {
      version: 1,
      state: "settled",
      startedAt,
      settledAt: this.now(),
      response,
    });
    return response;
  }
}

export type BulkCandidate = {
  isStill: boolean;
  requiresOffscreen: boolean;
};

export type BulkAvailability = {
  enabled: boolean;
  itemCount: number;
  videoCount: number;
  stillCount: number;
  quotaRequired: number;
  description: string;
  reason?: string;
};

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/**
 * Bulk is containment-only: it is enabled only when every selected item can be
 * started independently by the current implementation and the whole selection
 * fits the available free-tier quota. Partial execution is never presented as
 * a successful bulk action.
 */
export function evaluateBulkAvailability(
  candidates: BulkCandidate[],
  options: { licensed: boolean; remainingVideoQuota: number },
): BulkAvailability {
  const itemCount = candidates.length;
  const stillCount = candidates.filter((candidate) => candidate.isStill).length;
  const videoCount = itemCount - stillCount;
  const quotaRequired = options.licensed ? 0 : videoCount;
  const parts = [countLabel(videoCount, "video"), countLabel(stillCount, "still")];
  const description = `${countLabel(itemCount, "pick")}: ${parts.join(", ")}.`;

  if (itemCount === 0) {
    return {
      enabled: false,
      itemCount,
      videoCount,
      stillCount,
      quotaRequired,
      description,
      reason: "There are no picks to download.",
    };
  }

  if (candidates.some((candidate) => candidate.requiresOffscreen)) {
    return {
      enabled: false,
      itemCount,
      videoCount,
      stillCount,
      quotaRequired,
      description,
      reason:
        "Bulk download is unavailable when a pick is HLS, DASH, or WebM. Download those picks individually so none are silently skipped.",
    };
  }

  if (!options.licensed && quotaRequired > options.remainingVideoQuota) {
    return {
      enabled: false,
      itemCount,
      videoCount,
      stillCount,
      quotaRequired,
      description,
      reason: `This bulk action needs ${countLabel(quotaRequired, "video download")}, but ${countLabel(options.remainingVideoQuota, "free download")} remains. Download fewer videos individually or upgrade.`,
    };
  }

  const quotaText = options.licensed
    ? "No quota limit applies."
    : `${countLabel(quotaRequired, "free video download")} will be used; ${countLabel(options.remainingVideoQuota, "free download")} is currently available.`;
  return {
    enabled: true,
    itemCount,
    videoCount,
    stillCount,
    quotaRequired,
    description: `${description} ${quotaText}`,
  };
}
