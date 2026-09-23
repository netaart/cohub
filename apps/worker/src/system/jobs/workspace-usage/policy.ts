export function usagePolicy(env: Record<string, string | undefined> = process.env) {
  const integer = (key: string, fallback: number, max: number) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${key} / 配置无效`);
    return value;
  };
  return {
    enabled: env.WORKSPACE_USAGE_ENABLED !== "false",
    threads: integer("WORKSPACE_USAGE_THREADS", 1, 32),
    concurrency: integer("WORKSPACE_USAGE_CONCURRENCY", 1, 16),
    timeoutMs: integer("WORKSPACE_USAGE_TIMEOUT_MS", 300_000, 3_600_000),
    minScanIntervalMs: integer("WORKSPACE_USAGE_MIN_SCAN_INTERVAL_MS", 48 * 3_600_000, 30 * 24 * 3_600_000),
    batchSize: integer("WORKSPACE_USAGE_BATCH_SIZE", 50, 500),
  };
}
