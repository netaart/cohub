export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
