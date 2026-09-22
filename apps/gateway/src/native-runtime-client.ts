import type { NativeRuntimeEvent } from "@cohub/protocol";
import { buildTraceHeaders } from "@cohub/infra/tracing";
import { gatewayConfig } from "./config.js";

export async function forwardNativeRuntimeEvent(input: { spaceId: string; ownerUserId: string; requestId?: string; event: NativeRuntimeEvent }) {
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/native-runtime-event`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": gatewayConfig.workerSecret, ...buildTraceHeaders() },
    body: JSON.stringify(input),
  });
  const body = await response.json().catch(() => null) as { result?: unknown; message?: string } | null;
  if (!response.ok) throw new Error(body?.message ?? `Native runtime event failed: ${response.status}`);
  return body?.result ?? { accepted: true };
}
