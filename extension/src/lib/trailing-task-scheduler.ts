export type TrailingTaskScheduler = {
  request: () => Promise<void>;
};

type Waiter = {
  generation: number;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

/**
 * Serializes a task while guaranteeing one trailing pass for work requested
 * during the active pass or during its promise-settlement window.
 */
export function createTrailingTaskScheduler(
  task: () => Promise<void>,
): TrailingTaskScheduler {
  let requestedGeneration = 0;
  let completedGeneration = 0;
  let runner: Promise<void> | undefined;
  const waiters: Waiter[] = [];

  const settleThrough = (
    generation: number,
    outcome: { ok: true } | { ok: false; error: unknown },
  ): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter || waiter.generation > generation) continue;
      waiters.splice(index, 1);
      if (outcome.ok) waiter.resolve();
      else waiter.reject(outcome.error);
    }
  };

  const start = (): void => {
    if (runner) return;
    runner = (async () => {
      while (completedGeneration < requestedGeneration) {
        const generation = requestedGeneration;
        try {
          await task();
          completedGeneration = generation;
          settleThrough(generation, { ok: true });
        } catch (error) {
          completedGeneration = generation;
          settleThrough(generation, { ok: false, error });
        }
      }
    })().finally(() => {
      runner = undefined;
      // A request can arrive after the loop observes no work but before this
      // finally handler runs. Start another pass instead of dropping it.
      if (completedGeneration < requestedGeneration) start();
    });
  };

  return {
    request: () => {
      const generation = ++requestedGeneration;
      const completion = new Promise<void>((resolve, reject) => {
        waiters.push({ generation, resolve, reject });
      });
      start();
      return completion;
    },
  };
}
