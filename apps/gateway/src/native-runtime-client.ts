import type { NativeRuntimeEvent } from "@cohub/protocol";
import { buildTraceHeaders } from "@cohub/infra/tracing";
import { gatewayConfig } from "./config.js";

export async function forwardNativeRuntimeEvent(input: { spaceId: string; ownerUserId: string; requestId?: string; event: NativeRuntimeEvent }) {
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/native-runtime-event`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-worker-secret": gatewayConfig.workerSecret, ...buildTraceHeaders() },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(120_000),
  });
  let body: unknown;
  try { body = await response.json(); }
  catch (cause) { throw new Error(`Invalid native runtime response JSON (${response.status})`, { cause }); }
  const object = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!response.ok) {
    const message = object && typeof object.message === "string" && object.message.length ? `: ${object.message}` : "";
    throw new Error(`Native runtime event failed (${response.status})${message}`);
  }
  if (!object || !Object.hasOwn(object, "result")) throw new Error(`Invalid native runtime response (${response.status}): missing result`);
  return object.result;
}
