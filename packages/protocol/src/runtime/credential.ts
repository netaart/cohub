/** Whose credentials served an LLM call; only `platform` usage is billed and shown unmasked in public. */
export const USAGE_CREDENTIALS = ["platform", "user"] as const;
export type UsageCredential = typeof USAGE_CREDENTIALS[number];

const MAX_HOST_LENGTH = 255;

export function baseUrlHost(baseUrl: unknown): string | null {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host && host.length <= MAX_HOST_LENGTH ? host : null;
  } catch {
    return null;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function readUsageHost(value: unknown): string | null {
  const host = asRecord(value)?.host;
  return typeof host === "string" && baseUrlHost(`https://${host}`) === host ? host : null;
}

export function readUsageCredential(meta: unknown): UsageCredential {
  const record = asRecord(meta);
  return record?.runtime === "local" || record?.credential === "user" ? "user" : "platform";
}

export function usageCredentialMeta(model: { credential?: UsageCredential; baseUrl?: string } | null | undefined): { credential: UsageCredential; host?: string } {
  if (model?.credential !== "user") return { credential: "platform" };
  const host = baseUrlHost(model.baseUrl);
  return host ? { credential: "user", host } : { credential: "user" };
}
