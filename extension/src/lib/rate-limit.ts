export const VIDEO_DOWNLOAD_HISTORY_KEY = "video-download-history";
export const CAPTURE_QUOTA_BATCHES_STORAGE_KEY = "capture-quota-batches-v1";
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const FREE_DOWNLOAD_LIMIT = 4;
export const MAX_SETTLED_QUOTA_BATCHES = 200;

type DownloadEvent = {
  at: number;
  id?: string;
  batchId?: string;
  batchCount?: number;
  batchIndex?: number;
};

export type DownloadReservation = { id: string };
export type DownloadBatchMemberState = "reserved" | "charged" | "released";

export type DownloadBatchReservation = {
  batchId: string;
  count: number;
  reservedAt: number;
  reservations: DownloadReservation[];
};

export type DownloadQuotaBatchRecordV1 = {
  schemaVersion: 1;
  batchId: string;
  count: number;
  reservedAt: number;
  state: "reserved" | "accepted" | "settled";
  members: Array<{ id: string; state: DownloadBatchMemberState }>;
};

export type DownloadQuotaBatchIndexV1 = {
  schemaVersion: 1;
  orderedBatchIds: string[];
  batches: Record<string, DownloadQuotaBatchRecordV1>;
};

export type StoredQuotaValueResult<T> =
  | { status: "empty"; value: T }
  | { status: "valid"; value: T }
  | { status: "invalid"; reason: "corrupt" | "future_schema"; schemaVersion?: number };

export type DownloadReservationSettlement = {
  id: string;
  state: "charged" | "released";
  changed: boolean;
  batchId?: string;
};

export type DownloadBatchReconciliationResult = {
  changed: boolean;
  acceptedBatchIds: string[];
  releasedReservationIds: string[];
  chargedReservationIds: string[];
};

export class DownloadQuotaStorageError extends Error {
  readonly code: "storage_corrupt" | "storage_future_schema" | "storage_unavailable";

  constructor(
    code: DownloadQuotaStorageError["code"],
    message: string,
  ) {
    super(message);
    this.name = "DownloadQuotaStorageError";
    this.code = code;
  }
}

const MAX_BATCH_ID_LENGTH = 200;
const MAX_RESERVATION_ID_LENGTH = 256;
const MAX_HISTORY_EVENTS = 512;
const MAX_BATCH_INDEX_BYTES = 512 * 1024;
const MAX_ACTIVE_BATCHES = FREE_DOWNLOAD_LIMIT;
const MAX_RECONCILIATION_COMMAND_IDS = 256;

let historyWriteQueue: Promise<unknown> = Promise.resolve();

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function serializedBytes(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return undefined;
  }
}

function safeIdentifier(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}

function assertValidBatchId(batchId: string): void {
  if (!safeIdentifier(batchId, MAX_BATCH_ID_LENGTH)) {
    throw new TypeError("batchId must be a trimmed, non-empty identifier of at most 200 characters.");
  }
}

function assertValidReservationId(id: string): void {
  if (!safeIdentifier(id, MAX_RESERVATION_ID_LENGTH)) {
    throw new TypeError("Reservation id must be a bounded, non-empty identifier.");
  }
}

function assertValidBatchCount(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0 || count > FREE_DOWNLOAD_LIMIT) {
    throw new RangeError(`count must be an integer between 1 and ${FREE_DOWNLOAD_LIMIT}.`);
  }
}

function assertValidTimestamp(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("now must be a non-negative safe-integer timestamp.");
  }
}

function canonicalEvent(event: DownloadEvent): DownloadEvent {
  const result: DownloadEvent = { at: event.at };
  if (event.id !== undefined) result.id = event.id;
  if (event.batchId !== undefined) {
    result.batchId = event.batchId;
    result.batchCount = event.batchCount;
    result.batchIndex = event.batchIndex;
  }
  return result;
}

function canonicalBatch(record: DownloadQuotaBatchRecordV1): DownloadQuotaBatchRecordV1 {
  return {
    schemaVersion: 1,
    batchId: record.batchId,
    count: record.count,
    reservedAt: record.reservedAt,
    state: record.state,
    members: record.members.map((member) => ({ id: member.id, state: member.state })),
  };
}

function emptyBatchIndex(): DownloadQuotaBatchIndexV1 {
  return { schemaVersion: 1, orderedBatchIds: [], batches: Object.fromEntries([]) };
}

function sortedBatchIds(batches: Record<string, DownloadQuotaBatchRecordV1>): string[] {
  return Object.values(batches)
    .sort((left, right) => right.reservedAt - left.reservedAt || left.batchId.localeCompare(right.batchId))
    .map((record) => record.batchId);
}

function canonicalBatchIndex(records: DownloadQuotaBatchRecordV1[]): DownloadQuotaBatchIndexV1 {
  const active = records.filter((record) => record.state !== "settled");
  const settled = records
    .filter((record) => record.state === "settled")
    .sort((left, right) => right.reservedAt - left.reservedAt || left.batchId.localeCompare(right.batchId))
    .slice(0, MAX_SETTLED_QUOTA_BATCHES);
  const batches = Object.fromEntries(
    [...active, ...settled].map((record) => [record.batchId, canonicalBatch(record)] as const),
  );
  return { schemaVersion: 1, orderedBatchIds: sortedBatchIds(batches), batches };
}

export function parseStoredDownloadHistory(
  value: unknown,
  now: number,
): StoredQuotaValueResult<DownloadEvent[]> {
  assertValidTimestamp(now);
  if (value === undefined) return { status: "empty", value: [] };
  try {
    if (!Array.isArray(value) || value.length > MAX_HISTORY_EVENTS) {
      return { status: "invalid", reason: "corrupt" };
    }
    const ids = new Set<string>();
    const events: DownloadEvent[] = [];
    for (const rawEvent of value) {
      const event = asRecord(rawEvent);
      if (
        !event ||
        !Number.isSafeInteger(event.at) ||
        (event.at as number) < 0 ||
        (event.at as number) > now + MAX_CLOCK_SKEW_MS
      ) {
        return { status: "invalid", reason: "corrupt" };
      }
      const hasBatchMetadata =
        event.batchId !== undefined || event.batchCount !== undefined || event.batchIndex !== undefined;
      if (event.id !== undefined && !safeIdentifier(event.id, MAX_RESERVATION_ID_LENGTH)) {
        return { status: "invalid", reason: "corrupt" };
      }
      if (typeof event.id === "string") {
        if (ids.has(event.id)) return { status: "invalid", reason: "corrupt" };
        ids.add(event.id);
      }
      if (hasBatchMetadata) {
        if (
          !safeIdentifier(event.id, MAX_RESERVATION_ID_LENGTH) ||
          !safeIdentifier(event.batchId, MAX_BATCH_ID_LENGTH) ||
          !Number.isSafeInteger(event.batchCount) ||
          (event.batchCount as number) <= 0 ||
          (event.batchCount as number) > FREE_DOWNLOAD_LIMIT ||
          !Number.isSafeInteger(event.batchIndex) ||
          (event.batchIndex as number) < 0 ||
          (event.batchIndex as number) >= (event.batchCount as number)
        ) {
          return { status: "invalid", reason: "corrupt" };
        }
      }
      events.push(canonicalEvent(event as DownloadEvent));
    }
    return { status: "valid", value: events };
  } catch {
    return { status: "invalid", reason: "corrupt" };
  }
}

function validBatchRecord(value: unknown): value is DownloadQuotaBatchRecordV1 {
  const record = asRecord(value);
  if (
    !record ||
    record.schemaVersion !== 1 ||
    !safeIdentifier(record.batchId, MAX_BATCH_ID_LENGTH) ||
    !Number.isSafeInteger(record.count) ||
    (record.count as number) <= 0 ||
    (record.count as number) > FREE_DOWNLOAD_LIMIT ||
    !Number.isSafeInteger(record.reservedAt) ||
    (record.reservedAt as number) < 0 ||
    (record.state !== "reserved" && record.state !== "accepted" && record.state !== "settled") ||
    !Array.isArray(record.members) ||
    record.members.length !== record.count
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (const rawMember of record.members) {
    const member = asRecord(rawMember);
    if (
      !member ||
      !safeIdentifier(member.id, MAX_RESERVATION_ID_LENGTH) ||
      (member.state !== "reserved" && member.state !== "charged" && member.state !== "released") ||
      ids.has(member.id)
    ) {
      return false;
    }
    ids.add(member.id);
  }
  if (record.state === "reserved" && record.members.some((member) => member.state !== "reserved")) {
    return false;
  }
  if (record.state === "settled" && record.members.some((member) => member.state === "reserved")) {
    return false;
  }
  if (record.state === "accepted" && record.members.every((member) => member.state !== "reserved")) {
    return false;
  }
  return true;
}

export function parseStoredDownloadBatchIndex(
  value: unknown,
): StoredQuotaValueResult<DownloadQuotaBatchIndexV1> {
  if (value === undefined) return { status: "empty", value: emptyBatchIndex() };
  try {
    const bytes = serializedBytes(value);
    if (bytes === undefined || bytes > MAX_BATCH_INDEX_BYTES) {
      return { status: "invalid", reason: "corrupt" };
    }
    const record = asRecord(value);
    if (!record) return { status: "invalid", reason: "corrupt" };
    if (record.schemaVersion !== 1) {
      const version = record.schemaVersion;
      return typeof version === "number" && Number.isSafeInteger(version) && version > 1
        ? { status: "invalid", reason: "future_schema", schemaVersion: version }
        : { status: "invalid", reason: "corrupt" };
    }
    if (
      !Array.isArray(record.orderedBatchIds) ||
      record.orderedBatchIds.length > MAX_ACTIVE_BATCHES + MAX_SETTLED_QUOTA_BATCHES ||
      !record.orderedBatchIds.every((id) => safeIdentifier(id, MAX_BATCH_ID_LENGTH)) ||
      new Set(record.orderedBatchIds).size !== record.orderedBatchIds.length
    ) {
      return { status: "invalid", reason: "corrupt" };
    }
    const rawBatches = asRecord(record.batches);
    if (!rawBatches || Object.keys(rawBatches).length !== record.orderedBatchIds.length) {
      return { status: "invalid", reason: "corrupt" };
    }
    let activeCount = 0;
    let settledCount = 0;
    const memberIds = new Set<string>();
    const records: DownloadQuotaBatchRecordV1[] = [];
    for (const batchId of record.orderedBatchIds) {
      if (!Object.prototype.hasOwnProperty.call(rawBatches, batchId)) {
        return { status: "invalid", reason: "corrupt" };
      }
      const rawBatch = rawBatches[batchId];
      if (!validBatchRecord(rawBatch) || rawBatch.batchId !== batchId) {
        return { status: "invalid", reason: "corrupt" };
      }
      if (rawBatch.state === "settled") settledCount += 1;
      else activeCount += 1;
      for (const member of rawBatch.members) {
        if (memberIds.has(member.id)) return { status: "invalid", reason: "corrupt" };
        memberIds.add(member.id);
      }
      records.push(canonicalBatch(rawBatch));
    }
    if (activeCount > MAX_ACTIVE_BATCHES || settledCount > MAX_SETTLED_QUOTA_BATCHES) {
      return { status: "invalid", reason: "corrupt" };
    }
    return { status: "valid", value: canonicalBatchIndex(records) };
  } catch {
    return { status: "invalid", reason: "corrupt" };
  }
}

function quotaFailure(
  parsed: Extract<StoredQuotaValueResult<unknown>, { status: "invalid" }>,
): DownloadQuotaStorageError {
  return parsed.reason === "future_schema"
    ? new DownloadQuotaStorageError(
      "storage_future_schema",
      `Stored quota data uses unsupported schema ${parsed.schemaVersion ?? "unknown"}.`,
    )
    : new DownloadQuotaStorageError("storage_corrupt", "Stored quota data is corrupt.");
}

function migrateHistoryBatches(
  events: DownloadEvent[],
  index: DownloadQuotaBatchIndexV1,
): { index: DownloadQuotaBatchIndexV1; migrated: boolean } {
  const records = new Map(index.orderedBatchIds.map((id) => [id, canonicalBatch(index.batches[id])]));
  let migrated = false;
  const grouped = new Map<string, DownloadEvent[]>();
  for (const event of events) {
    if (!event.batchId) continue;
    const group = grouped.get(event.batchId) ?? [];
    group.push(event);
    grouped.set(event.batchId, group);
  }
  for (const [batchId, group] of grouped) {
    const existing = records.get(batchId);
    if (existing) {
      for (const event of group) {
        const member = existing.members[event.batchIndex ?? -1];
        if (
          !member ||
          member.id !== event.id ||
          member.state === "released" ||
          event.batchCount !== existing.count ||
          event.at !== existing.reservedAt
        ) {
          throw new DownloadQuotaStorageError("storage_corrupt", "Quota batch projection is corrupt.");
        }
      }
      continue;
    }
    const count = group[0]?.batchCount;
    const reservedAt = group[0]?.at;
    if (
      !Number.isSafeInteger(count) ||
      count !== group.length ||
      !Number.isSafeInteger(reservedAt)
    ) {
      throw new DownloadQuotaStorageError("storage_corrupt", "Legacy quota batch is incomplete.");
    }
    const ordered = [...group].sort((left, right) => (left.batchIndex ?? -1) - (right.batchIndex ?? -1));
    if (ordered.some((event, position) => event.batchIndex !== position || event.batchCount !== count || event.at !== reservedAt)) {
      throw new DownloadQuotaStorageError("storage_corrupt", "Legacy quota batch ordering is corrupt.");
    }
    records.set(batchId, {
      schemaVersion: 1,
      batchId,
      count: count as number,
      reservedAt: reservedAt as number,
      state: "reserved",
      members: ordered.map((event) => ({ id: event.id as string, state: "reserved" })),
    });
    migrated = true;
  }
  return { index: canonicalBatchIndex([...records.values()]), migrated };
}

function pruneOldEvents(events: DownloadEvent[], now: number): DownloadEvent[] {
  return events.filter((event) => now - event.at < WINDOW_MS);
}

function pruneOldBatches(index: DownloadQuotaBatchIndexV1, now: number): DownloadQuotaBatchIndexV1 {
  return canonicalBatchIndex(
    index.orderedBatchIds
      .map((id) => index.batches[id])
      .filter((record) => now - record.reservedAt < WINDOW_MS),
  );
}

type QuotaState = {
  nonBatchEvents: DownloadEvent[];
  batches: DownloadQuotaBatchIndexV1;
  dirty: boolean;
};

async function readQuotaState(now: number): Promise<QuotaState> {
  let stored: Record<string, unknown>;
  try {
    stored = await chrome.storage.local.get([
      VIDEO_DOWNLOAD_HISTORY_KEY,
      CAPTURE_QUOTA_BATCHES_STORAGE_KEY,
    ]);
  } catch (error) {
    throw new DownloadQuotaStorageError(
      "storage_unavailable",
      error instanceof Error ? error.message : "Chrome local storage is unavailable.",
    );
  }
  const parsedHistory = parseStoredDownloadHistory(stored[VIDEO_DOWNLOAD_HISTORY_KEY], now);
  if (parsedHistory.status === "invalid") throw quotaFailure(parsedHistory);
  const parsedBatches = parseStoredDownloadBatchIndex(stored[CAPTURE_QUOTA_BATCHES_STORAGE_KEY]);
  if (parsedBatches.status === "invalid") throw quotaFailure(parsedBatches);
  const events = pruneOldEvents(parsedHistory.value, now);
  const migrated = migrateHistoryBatches(events, pruneOldBatches(parsedBatches.value, now));
  return {
    nonBatchEvents: events.filter((event) => event.batchId === undefined),
    batches: migrated.index,
    dirty:
      migrated.migrated ||
      events.length !== parsedHistory.value.length ||
      migrated.index.orderedBatchIds.length !== parsedBatches.value.orderedBatchIds.length,
  };
}

function projectedHistory(state: QuotaState): DownloadEvent[] {
  const events = state.nonBatchEvents.map(canonicalEvent);
  for (const batchId of state.batches.orderedBatchIds) {
    const batch = state.batches.batches[batchId];
    batch.members.forEach((member, batchIndex) => {
      if (member.state === "released") return;
      events.push({
        at: batch.reservedAt,
        id: member.id,
        batchId: batch.batchId,
        batchCount: batch.count,
        batchIndex,
      });
    });
  }
  if (events.length > MAX_HISTORY_EVENTS) {
    throw new DownloadQuotaStorageError("storage_corrupt", "Quota history exceeds its event limit.");
  }
  return events;
}

async function writeQuotaState(state: QuotaState): Promise<void> {
  const batches = canonicalBatchIndex(
    state.batches.orderedBatchIds.map((id) => state.batches.batches[id]),
  );
  const bytes = serializedBytes(batches);
  if (bytes === undefined || bytes > MAX_BATCH_INDEX_BYTES) {
    throw new DownloadQuotaStorageError("storage_corrupt", "Quota batch control data exceeds its byte limit.");
  }
  try {
    await chrome.storage.local.set({
      [VIDEO_DOWNLOAD_HISTORY_KEY]: projectedHistory({ ...state, batches }),
      [CAPTURE_QUOTA_BATCHES_STORAGE_KEY]: batches,
    });
  } catch (error) {
    throw new DownloadQuotaStorageError(
      "storage_unavailable",
      error instanceof Error ? error.message : "Chrome local storage is unavailable.",
    );
  }
}

function activeQuotaCount(state: QuotaState): number {
  let count = state.nonBatchEvents.length;
  for (const batchId of state.batches.orderedBatchIds) {
    count += state.batches.batches[batchId].members.filter((member) => member.state !== "released").length;
  }
  return count;
}

function makeReservationId(now: number): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `quota-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function withHistoryWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = historyWriteQueue.then(fn, fn);
  historyWriteQueue = next.catch(() => undefined);
  return next;
}

function reservationForBatch(record: DownloadQuotaBatchRecordV1): DownloadBatchReservation {
  return {
    batchId: record.batchId,
    count: record.count,
    reservedAt: record.reservedAt,
    reservations: record.members.map((member) => ({ id: member.id })),
  };
}

export async function getDownloadCount(now: number = Date.now()): Promise<number> {
  assertValidTimestamp(now);
  return activeQuotaCount(await readQuotaState(now));
}

export async function recordDownload(now: number = Date.now()): Promise<void> {
  assertValidTimestamp(now);
  await withHistoryWrite(async () => {
    const state = await readQuotaState(now);
    state.nonBatchEvents.push({ at: now });
    await writeQuotaState(state);
  });
}

export async function isRateLimited(now: number = Date.now()): Promise<boolean> {
  return (await getDownloadCount(now)) >= FREE_DOWNLOAD_LIMIT;
}

export async function reserveDownload(now: number = Date.now()): Promise<DownloadReservation | null> {
  assertValidTimestamp(now);
  return withHistoryWrite(async () => {
    const state = await readQuotaState(now);
    if (activeQuotaCount(state) >= FREE_DOWNLOAD_LIMIT) return null;
    const reservation = { id: makeReservationId(now) };
    state.nonBatchEvents.push({ at: now, id: reservation.id });
    await writeQuotaState(state);
    return reservation;
  });
}

/** Atomically reserves every requested slot in one local-storage writer realm. */
export async function reserveDownloads(
  batchId: string,
  count: number,
  now: number = Date.now(),
): Promise<DownloadBatchReservation | null> {
  assertValidBatchId(batchId);
  assertValidBatchCount(count);
  assertValidTimestamp(now);
  return withHistoryWrite(async () => {
    const state = await readQuotaState(now);
    const existing = Object.prototype.hasOwnProperty.call(state.batches.batches, batchId)
      ? state.batches.batches[batchId]
      : undefined;
    if (existing) {
      if (existing.count !== count) {
        throw new Error(`Batch "${batchId}" is already reserved for ${existing.count} downloads, not ${count}.`);
      }
      if (existing.state !== "reserved") {
        throw new Error(`Batch "${batchId}" was already accepted and cannot be reserved again.`);
      }
      return reservationForBatch(existing);
    }
    if (activeQuotaCount(state) + count > FREE_DOWNLOAD_LIMIT) return null;
    const record: DownloadQuotaBatchRecordV1 = {
      schemaVersion: 1,
      batchId,
      count,
      reservedAt: now,
      state: "reserved",
      members: Array.from({ length: count }, () => ({
        id: makeReservationId(now),
        state: "reserved" as const,
      })),
    };
    state.batches = canonicalBatchIndex([
      ...state.batches.orderedBatchIds.map((id) => state.batches.batches[id]),
      record,
    ]);
    await writeQuotaState(state);
    return reservationForBatch(record);
  });
}

/** Marks the pre-commit batch as owned by a durable accepted Capture command. */
export async function markDownloadBatchAccepted(
  batchId: string,
  now: number = Date.now(),
): Promise<void> {
  assertValidBatchId(batchId);
  assertValidTimestamp(now);
  await withHistoryWrite(async () => {
    const state = await readQuotaState(now);
    const record = state.batches.batches[batchId];
    if (!record) {
      throw new DownloadQuotaStorageError("storage_corrupt", `Quota batch "${batchId}" is missing.`);
    }
    if (record.state === "reserved") {
      record.state = "accepted";
      await writeQuotaState(state);
    }
  });
}

export async function settleDownloadReservation(
  reservation: DownloadReservation | string,
  disposition: "charged" | "released",
  now: number = Date.now(),
): Promise<DownloadReservationSettlement> {
  const id = typeof reservation === "string" ? reservation : reservation.id;
  assertValidReservationId(id);
  assertValidTimestamp(now);
  return withHistoryWrite(async () => {
    const state = await readQuotaState(now);
    for (const batchId of state.batches.orderedBatchIds) {
      const batch = state.batches.batches[batchId];
      const member = batch.members.find((candidate) => candidate.id === id);
      if (!member) continue;
      if (batch.state === "reserved") {
        throw new Error(`Batch "${batchId}" has not crossed the durable acceptance boundary.`);
      }
      if (member.state === disposition) {
        return { id, state: disposition, changed: false, batchId };
      }
      if (member.state === "charged" || member.state === "released") {
        return { id, state: member.state, changed: false, batchId };
      }
      member.state = disposition;
      if (batch.members.every((candidate) => candidate.state !== "reserved")) batch.state = "settled";
      await writeQuotaState(state);
      return { id, state: disposition, changed: true, batchId };
    }

    const eventIndex = state.nonBatchEvents.findIndex((event) => event.id === id);
    if (eventIndex === -1) return { id, state: disposition, changed: false };
    if (disposition === "charged") return { id, state: "charged", changed: false };
    state.nonBatchEvents.splice(eventIndex, 1);
    await writeQuotaState(state);
    return { id, state: "released", changed: true };
  });
}

export async function chargeDownloadReservation(
  reservation: DownloadReservation | string,
  now: number = Date.now(),
): Promise<DownloadReservationSettlement> {
  return settleDownloadReservation(reservation, "charged", now);
}

export async function releaseDownloadReservation(
  reservation: DownloadReservation | string | undefined,
  now: number = Date.now(),
): Promise<void> {
  const id = typeof reservation === "string" ? reservation : reservation?.id;
  if (!id) return;
  await settleDownloadReservation(id, "released", now);
}

/** Pre-commit compensation. Accepted batches must be settled member-by-member. */
export async function releaseDownloadReservations(
  reservation: DownloadBatchReservation | string | undefined,
  now: number = Date.now(),
): Promise<void> {
  const batchId = typeof reservation === "string" ? reservation : reservation?.batchId;
  if (!batchId) return;
  assertValidBatchId(batchId);
  assertValidTimestamp(now);
  await withHistoryWrite(async () => {
    const state = await readQuotaState(now);
    const existing = state.batches.batches[batchId];
    if (!existing) return;
    if (reservation && typeof reservation !== "string") {
      const suppliedIds = reservation.reservations.map(({ id }) => id);
      const existingIds = existing.members.map(({ id }) => id);
      if (
        reservation.count !== existing.count ||
        reservation.reservedAt !== existing.reservedAt ||
        suppliedIds.length !== existingIds.length ||
        suppliedIds.some((id, index) => id !== existingIds[index])
      ) {
        throw new Error(`Batch reservation "${batchId}" does not match the stored reservation.`);
      }
    }
    if (existing.state === "settled" && existing.members.every((member) => member.state === "released")) {
      return;
    }
    if (existing.state !== "reserved") {
      throw new Error(`Accepted batch "${batchId}" must be settled member-by-member.`);
    }
    existing.members.forEach((member) => { member.state = "released"; });
    existing.state = "settled";
    await writeQuotaState(state);
  });
}

/**
 * Reconciles durable redacted quota control with every command ID retained in
 * the redacted session ledger. Missing owners release only uncharged members.
 */
export async function reconcileDownloadBatchReservations(
  durableCommandIds: readonly string[],
  now: number = Date.now(),
): Promise<DownloadBatchReconciliationResult> {
  assertValidTimestamp(now);
  if (
    !Array.isArray(durableCommandIds) ||
    durableCommandIds.length > MAX_RECONCILIATION_COMMAND_IDS ||
    !durableCommandIds.every((id) => safeIdentifier(id, MAX_BATCH_ID_LENGTH)) ||
    new Set(durableCommandIds).size !== durableCommandIds.length
  ) {
    throw new TypeError("durableCommandIds must contain only unique bounded command identifiers.");
  }
  const active = new Set(durableCommandIds);
  return withHistoryWrite(async () => {
    const state = await readQuotaState(now);
    const acceptedBatchIds: string[] = [];
    const releasedReservationIds: string[] = [];
    const chargedReservationIds: string[] = [];
    let changed = state.dirty;
    for (const batchId of state.batches.orderedBatchIds) {
      const batch = state.batches.batches[batchId];
      if (active.has(batchId)) {
        acceptedBatchIds.push(batchId);
        if (batch.state === "reserved") {
          batch.state = "accepted";
          changed = true;
        }
        continue;
      }
      for (const member of batch.members) {
        if (member.state === "reserved") {
          member.state = "released";
          releasedReservationIds.push(member.id);
          changed = true;
        } else if (member.state === "charged") {
          chargedReservationIds.push(member.id);
        }
      }
      if (batch.state !== "settled" && batch.members.every((member) => member.state !== "reserved")) {
        batch.state = "settled";
        changed = true;
      }
    }
    if (changed) await writeQuotaState(state);
    return { changed, acceptedBatchIds, releasedReservationIds, chargedReservationIds };
  });
}

export async function resetHistory(): Promise<void> {
  await withHistoryWrite(async () => {
    await chrome.storage.local.remove([
      VIDEO_DOWNLOAD_HISTORY_KEY,
      CAPTURE_QUOTA_BATCHES_STORAGE_KEY,
    ]);
  });
}
