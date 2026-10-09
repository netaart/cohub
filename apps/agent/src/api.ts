import { buildTraceHeaders, getCurrentRequestId } from "@cohub/infra/tracing";
import { env } from "./env.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const INTERNAL_API_BASE_URL =
  env.ENV === "prod"
    ? "http://cohub-api.cohub.svc.cluster.local:8787"
    : "http://cohub-api-dev.cohub-dev.svc.cluster.local:8787";

const internalHeaders = () => ({
  "content-type": "application/json",
  ...(env.WORKER_SECRET ? { "x-worker-secret": env.WORKER_SECRET } : {}),
  ...buildTraceHeaders({ requestId: getCurrentRequestId() }),
});

async function postJsonWithRetry(input: {
  url: string;
  body: unknown;
  errorPrefix: string;
  maxAttempts?: number;
}) {
  const maxAttempts = input.maxAttempts ?? 3;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(input.url, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify(input.body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (response.status >= 500 && attempt < maxAttempts) {
          await sleep(500 * attempt);
          continue;
        }
        throw new Error(`${input.errorPrefix} ${response.status}: ${text}`);
      }

      return response.json().catch(() => null);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) await sleep(500 * attempt);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function getSpaceSandbox(input: { spaceId: string }) {
  const url = `${INTERNAL_API_BASE_URL}/internal/spaces/${input.spaceId}/sandbox`;
  const response = await fetch(url, { method: "GET", headers: internalHeaders() });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Get space sandbox failed ${response.status}: ${text}`);
  }

  return response.json().catch(() => null) as Promise<{
    sandbox: {
      provider?: "cloud" | "local" | string | null;
      status: string;
      podName?: string | null;
      lastActivityAt?: string | null;
      meta?: Record<string, unknown> | null;
    } | null;
  } | null>;
}

export async function recoverSpaceSandbox(input: { spaceId: string; reason?: string; source?: string }) {
  const url = `${INTERNAL_API_BASE_URL}/internal/spaces/${input.spaceId}/sandbox/recover`;
  return postJsonWithRetry({
    url,
    body: { reason: input.reason ?? "recover", source: input.source ?? "agent" },
    errorPrefix: "Recover sandbox failed",
    maxAttempts: 1,
  }) as Promise<{
    ok: boolean;
    status?: string;
    verified?: boolean;
    message?: string;
    recovering?: boolean;
    throttled?: boolean;
    local?: boolean;
  } | null>;
}

export async function getSpace(input: { spaceId: string }) {
  const url = `${INTERNAL_API_BASE_URL}/internal/spaces/${input.spaceId}`;
  const response = await fetch(url, { method: "GET", headers: internalHeaders() });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Get space failed ${response.status}: ${text}`);
  }

  return response.json().catch(() => null) as Promise<{
    space: {
      id: string;
      userUuid: string;
      name: string;
      meta?: Record<string, unknown> | null;
    } | null;
  } | null>;
}

export async function createSessionImageUpload(input: { executionToken: string; spaceId: string; sessionId: string; size: number; mimeType: string }) {
  const response = await fetch(`${INTERNAL_API_BASE_URL}/api/public-assets/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.executionToken}`,
      ...buildTraceHeaders({ requestId: getCurrentRequestId() }),
    },
    body: JSON.stringify({
      purpose: "session_image",
      uploadProtocol: "presigned_put_v1",
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      file: { size: input.size, mimeType: input.mimeType },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Session image upload plan failed ${response.status}: ${text}`);
  }
  const plan = await response.json() as { asset: { publicUrl: string; uploadUrl: string; uploadHeaders?: Record<string, string> } };
  return plan.asset;
}
