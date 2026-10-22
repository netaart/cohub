const API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 10_000;

export type CustomHostname = {
  id: string;
  hostname: string;
  status: string;
  sslStatus: string | null;
  /** Cloudflare's hostname or certificate validation errors, if any. */
  errors: string[];
};

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[],
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

export type CustomHostnameClient = {
  findByHostname(hostname: string): Promise<CustomHostname | null>;
  get(id: string): Promise<CustomHostname | null>;
  create(hostname: string): Promise<CustomHostname>;
  /** Restarts hostname and certificate validation (Cloudflare "Refresh"). */
  refresh(id: string): Promise<CustomHostname>;
  /** Resolves when the hostname is gone, including when it never existed. */
  delete(id: string): Promise<void>;
};

const SSL_SETTINGS = {
  method: "http",
  type: "dv",
  settings: { min_tls_version: "1.2" },
} as const;

type RawCustomHostname = {
  id?: unknown;
  hostname?: unknown;
  status?: unknown;
  verification_errors?: unknown;
  ssl?: { status?: unknown; validation_errors?: unknown } | null;
};

function toCustomHostname(raw: RawCustomHostname): CustomHostname {
  const errors: string[] = [];
  if (Array.isArray(raw.verification_errors)) {
    for (const item of raw.verification_errors) if (typeof item === "string") errors.push(item);
  }
  if (Array.isArray(raw.ssl?.validation_errors)) {
    for (const item of raw.ssl.validation_errors) {
      const message = (item as { message?: unknown })?.message;
      if (typeof message === "string") errors.push(message);
    }
  }
  return {
    id: String(raw.id),
    hostname: String(raw.hostname),
    status: typeof raw.status === "string" ? raw.status : "unknown",
    sslStatus: typeof raw.ssl?.status === "string" ? raw.ssl.status : null,
    errors,
  };
}

export function createCloudflareCustomHostnameClient(input: {
  apiToken: string;
  zoneId: string;
  fetcher?: typeof fetch;
}): CustomHostnameClient {
  const fetcher = input.fetcher ?? fetch;
  const base = `${API_BASE}/zones/${encodeURIComponent(input.zoneId)}/custom_hostnames`;

  async function call<T>(path: string, init: RequestInit = {}): Promise<{ status: number; result: T }> {
    const response = await fetcher(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${input.apiToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as {
      success?: boolean;
      errors?: Array<{ code?: number; message?: string }>;
      result?: T;
    } | null;
    if (!response.ok || !body?.success) {
      const errors = body?.errors ?? [];
      const message = errors.map((error) => error.message).filter(Boolean).join("; ")
        || `Cloudflare API responded ${response.status}`;
      throw new CloudflareApiError(message, response.status, errors.map((error) => error.code ?? 0));
    }
    return { status: response.status, result: body.result as T };
  }

  return {
    async findByHostname(hostname) {
      const { result } = await call<RawCustomHostname[]>(`?hostname=${encodeURIComponent(hostname)}`);
      const match = result?.find((item) => item.hostname === hostname);
      return match ? toCustomHostname(match) : null;
    },
    async get(id) {
      try {
        const { result } = await call<RawCustomHostname>(`/${encodeURIComponent(id)}`);
        return toCustomHostname(result);
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status === 404) return null;
        throw error;
      }
    },
    async create(hostname) {
      const { result } = await call<RawCustomHostname>("", {
        method: "POST",
        body: JSON.stringify({ hostname, ssl: SSL_SETTINGS }),
      });
      return toCustomHostname(result);
    },
    async refresh(id) {
      const { result } = await call<RawCustomHostname>(`/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ ssl: SSL_SETTINGS }),
      });
      return toCustomHostname(result);
    },
    async delete(id) {
      try {
        await call(`/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (error) {
        if (error instanceof CloudflareApiError && error.status === 404) return;
        throw error;
      }
    },
  };
}
