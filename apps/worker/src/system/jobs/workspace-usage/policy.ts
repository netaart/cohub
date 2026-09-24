export function usagePolicy() {
  return {
    threads: 1,
    concurrency: 1,
    timeoutMs: 300_000,
    minScanIntervalMs: 48 * 3_600_000,
    batchSize: 50,
  };
}
