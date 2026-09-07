import type { CaptureHeaderLeaseReplayScopeV1 } from "./capture-header-leases";
import { buildHeaderOps, type CapturedHeaders } from "./header-capture";
import { withKeyLock } from "./session-jobs";

export const CAPTURE_DNR_OWNERS_STORAGE_KEY = "capture-dnr-owners-v2";
export const MAX_CAPTURE_DNR_OWNERS = 200;
export const MAX_CAPTURE_DNR_OWNERS_BYTES = 512 * 1024;

const MIN_CAPTURE_RULE_ID = 1_000_000_001;
const MAX_CAPTURE_RULE_ID = MIN_CAPTURE_RULE_ID + MAX_CAPTURE_DNR_OWNERS - 1;
const SAFE_ID = /^[a-z0-9._:-]+$/i;

export type CaptureDnrOwnerKind = "review" | "attempt";

export type CaptureDnrOwnerV1 = {
  schemaVersion: 1;
  jobKey: string;
  ruleId: number;
  leaseId: string;
  ownerKind: CaptureDnrOwnerKind;
  replayScope: CaptureHeaderLeaseReplayScopeV1;
  expiresAt: number;
};

type CaptureDnrOwnerIndexV1 = {
  schemaVersion: 1;
  orderedJobKeys: string[];
  records: Record<string, CaptureDnrOwnerV1>;
};

export type ClaimCaptureDnrOwnerInput = Omit<CaptureDnrOwnerV1, "schemaVersion" | "ruleId">;

export type CaptureDnrOwnerFailure =
  | { ok: false; reason: "invalid_input" }
  | { ok: false; reason: "storage_corrupt" }
  | {
      ok: false;
      reason: "storage_unavailable";
      operation: "get" | "set";
      commitState: "absent" | "unknown";
    }
  | { ok: false; reason: "capacity"; limit: number }
  | { ok: false; reason: "size_limit"; limit: number }
  | { ok: false; reason: "job_conflict"; jobKey: string }
  | { ok: false; reason: "scope_conflict"; conflictingJobKey: string }
  | { ok: false; reason: "owner_not_found"; jobKey: string };

export type ClaimCaptureDnrOwnerResult =
  | {
      ok: true;
      changed: boolean;
      replayed: boolean;
      commitState: "committed";
      owner: CaptureDnrOwnerV1;
    }
  | CaptureDnrOwnerFailure;

export type ReleaseCaptureDnrOwnerResult =
  | {
      ok: true;
      changed: boolean;
      replayed: boolean;
      commitState: "committed";
      owner: CaptureDnrOwnerV1;
    }
  | CaptureDnrOwnerFailure;

export type ListCaptureDnrOwnersResult =
  | { ok: true; owners: CaptureDnrOwnerV1[] }
  | CaptureDnrOwnerFailure;

function safeId(value: unknown, max = 600): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && SAFE_ID.test(value);
}

function safeTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) return undefined;
    const clone = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      clone[key] = descriptor.value;
    }
    return clone;
  } catch {
    return undefined;
  }
}

function canonicalScope(value: unknown): CaptureHeaderLeaseReplayScopeV1 | undefined {
  const record = exactDataRecord(value, [
    "mode",
    "origin",
    "requestDomain",
    "scopeUrl",
    "urlFilter",
    "isUrlFilterCaseSensitive",
  ]);
  if (!record) return undefined;
  try {
    if (
      (record.mode !== "exact_url" && record.mode !== "directory_prefix") ||
      typeof record.origin !== "string" ||
      typeof record.requestDomain !== "string" ||
      typeof record.scopeUrl !== "string" ||
      typeof record.urlFilter !== "string" ||
      record.isUrlFilterCaseSensitive !== true
    ) return undefined;
    const scopeUrl = new URL(record.scopeUrl);
    if (
      (scopeUrl.protocol !== "http:" && scopeUrl.protocol !== "https:") ||
      scopeUrl.username.length > 0 ||
      scopeUrl.password.length > 0 ||
      scopeUrl.hash.length > 0 ||
      scopeUrl.href !== record.scopeUrl ||
      scopeUrl.origin !== record.origin ||
      scopeUrl.hostname !== record.requestDomain ||
      record.scopeUrl.length > 16_384 ||
      record.urlFilter.length > 16_386 ||
      /[*|^]/.test(record.scopeUrl) ||
      /[\u0000-\u001f\u007f]/.test(record.urlFilter)
    ) return undefined;
    const expectedFilter = record.mode === "exact_url"
      ? `|${record.scopeUrl}|`
      : `|${record.scopeUrl}`;
    if (record.urlFilter !== expectedFilter) return undefined;
    if (
      record.mode === "directory_prefix" &&
      (scopeUrl.search.length > 0 || !scopeUrl.pathname.endsWith("/"))
    ) return undefined;
    return {
      mode: record.mode,
      origin: scopeUrl.origin,
      requestDomain: scopeUrl.hostname,
      scopeUrl: scopeUrl.href,
      urlFilter: expectedFilter,
      isUrlFilterCaseSensitive: true,
    };
  } catch {
    return undefined;
  }
}

function parseOwner(value: unknown): CaptureDnrOwnerV1 | undefined {
  const record = exactDataRecord(value, [
    "schemaVersion",
    "jobKey",
    "ruleId",
    "leaseId",
    "ownerKind",
    "replayScope",
    "expiresAt",
  ]);
  if (!record) return undefined;
  try {
    const scope = canonicalScope(record.replayScope);
    if (
      record.schemaVersion !== 1 || !safeId(record.jobKey) || !safeId(record.leaseId, 256) ||
      (record.ownerKind !== "review" && record.ownerKind !== "attempt") ||
      !Number.isSafeInteger(record.ruleId) ||
      (record.ruleId as number) < MIN_CAPTURE_RULE_ID ||
      (record.ruleId as number) > MAX_CAPTURE_RULE_ID ||
      !safeTime(record.expiresAt) || !scope
    ) return undefined;
    return {
      schemaVersion: 1,
      jobKey: record.jobKey,
      ruleId: record.ruleId as number,
      leaseId: record.leaseId,
      ownerKind: record.ownerKind,
      replayScope: scope,
      expiresAt: record.expiresAt,
    };
  } catch {
    return undefined;
  }
}

function cloneOwner(owner: CaptureDnrOwnerV1): CaptureDnrOwnerV1 {
  return {
    ...owner,
    replayScope: { ...owner.replayScope },
  };
}

function emptyIndex(): CaptureDnrOwnerIndexV1 {
  return { schemaVersion: 1, orderedJobKeys: [], records: {} };
}

function parseIndex(value: unknown): CaptureDnrOwnerIndexV1 | undefined {
  if (value === undefined) return emptyIndex();
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 || !Array.isArray(record.orderedJobKeys) ||
      record.orderedJobKeys.length > MAX_CAPTURE_DNR_OWNERS ||
      !record.orderedJobKeys.every((key) => safeId(key)) ||
      new Set(record.orderedJobKeys).size !== record.orderedJobKeys.length ||
      !record.records || typeof record.records !== "object" || Array.isArray(record.records)
    ) return undefined;
    const records = record.records as Record<string, unknown>;
    if (Object.keys(records).length !== record.orderedJobKeys.length) return undefined;
    const parsed: Record<string, CaptureDnrOwnerV1> = {};
    const ruleIds = new Set<number>();
    for (const jobKey of record.orderedJobKeys) {
      const owner = parseOwner(records[jobKey]);
      if (!owner || owner.jobKey !== jobKey || ruleIds.has(owner.ruleId)) return undefined;
      parsed[jobKey] = owner;
      ruleIds.add(owner.ruleId);
    }
    return {
      schemaVersion: 1,
      orderedJobKeys: [...record.orderedJobKeys],
      records: parsed,
    };
  } catch {
    return undefined;
  }
}

function bytes(value: unknown): number | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : new TextEncoder().encode(text).byteLength;
  } catch {
    return undefined;
  }
}

function sameOwner(left: CaptureDnrOwnerV1, right: CaptureDnrOwnerV1): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.jobKey === right.jobKey &&
    left.ruleId === right.ruleId &&
    left.leaseId === right.leaseId &&
    left.ownerKind === right.ownerKind &&
    left.expiresAt === right.expiresAt &&
    left.replayScope.mode === right.replayScope.mode &&
    left.replayScope.origin === right.replayScope.origin &&
    left.replayScope.requestDomain === right.replayScope.requestDomain &&
    left.replayScope.scopeUrl === right.replayScope.scopeUrl &&
    left.replayScope.urlFilter === right.replayScope.urlFilter &&
    left.replayScope.isUrlFilterCaseSensitive ===
      right.replayScope.isUrlFilterCaseSensitive;
}

function scopeContains(scope: CaptureHeaderLeaseReplayScopeV1, url: string): boolean {
  if (scope.mode === "exact_url") return scope.scopeUrl === url;
  return url.startsWith(scope.scopeUrl);
}

export function captureDnrScopesOverlap(
  leftValue: unknown,
  rightValue: unknown,
): boolean {
  const left = canonicalScope(leftValue);
  const right = canonicalScope(rightValue);
  if (!left || !right || left.origin !== right.origin) return false;
  return scopeContains(left, right.scopeUrl) || scopeContains(right, left.scopeUrl);
}

/**
 * Builds the rule from the lease-derived immutable scope rather than deriving
 * a broader host filter again at execution time. Header values are supplied by
 * the separately protected lease registry and are never persisted here.
 */
export function buildCaptureDnrSessionRule(input: {
  owner: CaptureDnrOwnerV1;
  captured: CapturedHeaders;
  extensionId: string;
}): chrome.declarativeNetRequest.Rule | undefined {
  const owner = parseOwner(input?.owner);
  if (
    !owner ||
    typeof input.extensionId !== "string" ||
    !/^[a-p]{32}$/.test(input.extensionId)
  ) return undefined;
  const requestHeaders = buildHeaderOps(input.captured);
  if (requestHeaders.length === 0) return undefined;
  return {
    id: owner.ruleId,
    priority: 1,
    action: {
      type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
      requestHeaders: requestHeaders as unknown as chrome.declarativeNetRequest.ModifyHeaderInfo[],
    },
    condition: {
      urlFilter: owner.replayScope.urlFilter,
      isUrlFilterCaseSensitive: true,
      requestDomains: [owner.replayScope.requestDomain],
      initiatorDomains: [input.extensionId],
      resourceTypes: [
        "xmlhttprequest" as chrome.declarativeNetRequest.ResourceType,
        "other" as chrome.declarativeNetRequest.ResourceType,
      ],
    },
  };
}

async function readIndex(): Promise<CaptureDnrOwnerIndexV1 | undefined> {
  const stored = await chrome.storage.session.get(CAPTURE_DNR_OWNERS_STORAGE_KEY);
  return parseIndex(stored[CAPTURE_DNR_OWNERS_STORAGE_KEY]);
}

async function writeWithReadback(
  index: CaptureDnrOwnerIndexV1,
  expectedOwner: CaptureDnrOwnerV1 | null,
  previousOwner: CaptureDnrOwnerV1 | null,
): Promise<"committed" | "absent" | "unknown"> {
  try {
    await chrome.storage.session.set({ [CAPTURE_DNR_OWNERS_STORAGE_KEY]: index });
    return "committed";
  } catch {
    try {
      const reread = await readIndex();
      if (!reread) return "unknown";
      const observed = reread.records[expectedOwner?.jobKey ?? previousOwner?.jobKey ?? ""] ?? null;
      if (expectedOwner ? observed && sameOwner(observed, expectedOwner) : observed === null) {
        return "committed";
      }
      if (previousOwner ? observed && sameOwner(observed, previousOwner) : observed === null) {
        return "absent";
      }
      return "unknown";
    } catch {
      return "unknown";
    }
  }
}

function parseClaim(value: unknown): ClaimCaptureDnrOwnerInput | undefined {
  const record = exactDataRecord(value, [
    "jobKey",
    "leaseId",
    "ownerKind",
    "replayScope",
    "expiresAt",
  ]);
  if (!record) return undefined;
  try {
    const replayScope = canonicalScope(record.replayScope);
    if (
      !safeId(record.jobKey) || !safeId(record.leaseId, 256) ||
      (record.ownerKind !== "review" && record.ownerKind !== "attempt") ||
      !safeTime(record.expiresAt) || !replayScope
    ) return undefined;
    return {
      jobKey: record.jobKey,
      leaseId: record.leaseId,
      ownerKind: record.ownerKind,
      replayScope,
      expiresAt: record.expiresAt,
    };
  } catch {
    return undefined;
  }
}

function nextRuleId(index: CaptureDnrOwnerIndexV1): number | undefined {
  const used = new Set(Object.values(index.records).map((owner) => owner.ruleId));
  for (let ruleId = MIN_CAPTURE_RULE_ID; ruleId <= MAX_CAPTURE_RULE_ID; ruleId += 1) {
    if (!used.has(ruleId)) return ruleId;
  }
  return undefined;
}

export async function claimCaptureDnrOwner(
  rawInput: ClaimCaptureDnrOwnerInput,
): Promise<ClaimCaptureDnrOwnerResult> {
  const input = parseClaim(rawInput);
  if (!input) return { ok: false, reason: "invalid_input" };
  return withKeyLock(CAPTURE_DNR_OWNERS_STORAGE_KEY, async () => {
    let index: CaptureDnrOwnerIndexV1 | undefined;
    try {
      index = await readIndex();
    } catch {
      return { ok: false, reason: "storage_unavailable", operation: "get", commitState: "unknown" };
    }
    if (!index) return { ok: false, reason: "storage_corrupt" };
    const existing = index.records[input.jobKey];
    if (existing) {
      const expected = { ...input, schemaVersion: 1 as const, ruleId: existing.ruleId };
      return sameOwner(existing, expected)
        ? { ok: true, changed: false, replayed: true, commitState: "committed", owner: cloneOwner(existing) }
        : { ok: false, reason: "job_conflict", jobKey: input.jobKey };
    }
    const overlap = index.orderedJobKeys.find((jobKey) =>
      captureDnrScopesOverlap(index!.records[jobKey].replayScope, input.replayScope));
    if (overlap) return { ok: false, reason: "scope_conflict", conflictingJobKey: overlap };
    if (index.orderedJobKeys.length >= MAX_CAPTURE_DNR_OWNERS) {
      return { ok: false, reason: "capacity", limit: MAX_CAPTURE_DNR_OWNERS };
    }
    const ruleId = nextRuleId(index);
    if (ruleId === undefined) return { ok: false, reason: "capacity", limit: MAX_CAPTURE_DNR_OWNERS };
    const owner: CaptureDnrOwnerV1 = { schemaVersion: 1, ruleId, ...input };
    const next: CaptureDnrOwnerIndexV1 = {
      schemaVersion: 1,
      orderedJobKeys: [...index.orderedJobKeys, input.jobKey],
      records: { ...index.records, [input.jobKey]: owner },
    };
    const measured = bytes(next);
    if (measured === undefined || measured > MAX_CAPTURE_DNR_OWNERS_BYTES) {
      return { ok: false, reason: "size_limit", limit: MAX_CAPTURE_DNR_OWNERS_BYTES };
    }
    const written = await writeWithReadback(next, owner, null);
    if (written !== "committed") {
      return {
        ok: false,
        reason: "storage_unavailable",
        operation: "set",
        commitState: written,
      };
    }
    return { ok: true, changed: true, replayed: false, commitState: "committed", owner: cloneOwner(owner) };
  });
}

export async function releaseCaptureDnrOwner(input: {
  jobKey: string;
  leaseId: string;
}): Promise<ReleaseCaptureDnrOwnerResult> {
  if (!safeId(input?.jobKey) || !safeId(input?.leaseId, 256)) {
    return { ok: false, reason: "invalid_input" };
  }
  return withKeyLock(CAPTURE_DNR_OWNERS_STORAGE_KEY, async () => {
    let index: CaptureDnrOwnerIndexV1 | undefined;
    try {
      index = await readIndex();
    } catch {
      return { ok: false, reason: "storage_unavailable", operation: "get", commitState: "unknown" };
    }
    if (!index) return { ok: false, reason: "storage_corrupt" };
    const existing = index.records[input.jobKey];
    if (!existing) return { ok: false, reason: "owner_not_found", jobKey: input.jobKey };
    if (existing.leaseId !== input.leaseId) {
      return { ok: false, reason: "job_conflict", jobKey: input.jobKey };
    }
    const records = { ...index.records };
    delete records[input.jobKey];
    const next: CaptureDnrOwnerIndexV1 = {
      schemaVersion: 1,
      orderedJobKeys: index.orderedJobKeys.filter((key) => key !== input.jobKey),
      records,
    };
    const written = await writeWithReadback(next, null, existing);
    if (written !== "committed") {
      return {
        ok: false,
        reason: "storage_unavailable",
        operation: "set",
        commitState: written,
      };
    }
    return { ok: true, changed: true, replayed: false, commitState: "committed", owner: cloneOwner(existing) };
  });
}

export async function listCaptureDnrOwners(): Promise<ListCaptureDnrOwnersResult> {
  try {
    const index = await readIndex();
    if (!index) return { ok: false, reason: "storage_corrupt" };
    return {
      ok: true,
      owners: index.orderedJobKeys.map((key) => cloneOwner(index.records[key])),
    };
  } catch {
    return { ok: false, reason: "storage_unavailable", operation: "get", commitState: "unknown" };
  }
}
