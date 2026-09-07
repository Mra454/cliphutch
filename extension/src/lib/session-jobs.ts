// Serialized read-modify-write for the per-tab download-job records kept in
// chrome.storage.session. The service worker handles progress, blob-ready, and
// error messages concurrently; each does get -> mutate -> set on the whole
// record, so without serialization a late progress write can resurrect a job
// that another handler already moved to a terminal state, leaving the popup
// stuck on "running" with a dead Cancel. Every writer for a given storage key
// runs through the same promise chain, and mutations read the current job
// inside the lock so guards see up-to-date state.

const locks = new Map<string, Promise<unknown>>();

export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Swallow rejection on the chained copy so one failed writer does not reject
  // every later writer; callers still see the real result via `run`.
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function readRecord<J>(storageKey: string): Promise<Record<string, J>> {
  const result = await chrome.storage.session.get(storageKey);
  const value = result[storageKey];
  return value && typeof value === "object" ? (value as Record<string, J>) : {};
}

// Insert or replace a job wholesale (creation). Atomic against concurrent
// writers to the same record so a create never drops a sibling job.
export async function putJobRecord<J>(
  storageKey: string,
  jobId: string,
  job: J,
): Promise<void> {
  await withKeyLock(storageKey, async () => {
    const rec = await readRecord<J>(storageKey);
    rec[jobId] = job;
    await chrome.storage.session.set({ [storageKey]: rec });
  });
}

// Atomically read one job, apply `mutate`, and write it back. The job passed to
// `mutate` is read inside the lock, so a status guard reflects the latest
// state. Returning `false` from `mutate` skips the write. Returns the stored
// job, or undefined when the job is absent or the write was skipped.
export async function updateJobRecord<J>(
  storageKey: string,
  jobId: string,
  mutate: (job: J) => boolean | void,
): Promise<J | undefined> {
  return withKeyLock(storageKey, async () => {
    const rec = await readRecord<J>(storageKey);
    const job = rec[jobId];
    if (!job) return undefined;
    if (mutate(job) === false) return undefined;
    rec[jobId] = job;
    await chrome.storage.session.set({ [storageKey]: rec });
    return job;
  });
}
