import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

export type SandboxConnectionOptions = {
  wsUrl: string;
  headers: Record<string, string>;
};

export function createSandboxRpcNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function createSandboxRpcToken(signingKey: string, spaceId: string, nonce: string): string {
  if (!signingKey || !spaceId || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
    throw new Error("Sandbox RPC credentials are missing; recreate the sandbox.");
  }
  return createHmac("sha256", signingKey)
    .update(JSON.stringify(["sandbox-rpc-v1", spaceId, nonce]))
    .digest("base64url");
}

export function sandboxWsEndpoint(podIp: string): string {
  const family = isIP(podIp);
  if (!family) throw new Error("Sandbox Pod IP is invalid.");
  return `ws://${family === 6 ? `[${podIp}]` : podIp}:8788/sandbox`;
}

export function resolveSandboxConnectionOptions(input: {
  spaceId: string;
  sandbox: { provider?: string | null; meta?: unknown } | null;
  signingKey: string;
  workerSecret?: string;
}): SandboxConnectionOptions {
  const meta = input.sandbox?.meta as Record<string, unknown> | null | undefined;
  const wsEndpoint = typeof meta?.wsEndpoint === "string" ? meta.wsEndpoint.trim() : "";
  if (!wsEndpoint) throw new Error("Sandbox is not ready for requests yet: missing endpoint.");
  const url = new URL(wsEndpoint);
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Sandbox WebSocket endpoint is invalid.");
  }

  if (input.sandbox?.provider === "local") {
    if (url.pathname !== `/internal/sandbox-relay/${input.spaceId}` || !input.workerSecret) {
      throw new Error("Local sandbox relay credentials or endpoint are invalid.");
    }
    return { wsUrl: url.toString(), headers: { "x-worker-secret": input.workerSecret } };
  }
  if (input.sandbox?.provider !== "cloud") throw new Error("Sandbox provider is unsupported.");

  const podIp = typeof meta?.podIp === "string" ? meta.podIp : "";
  if (url.toString() !== sandboxWsEndpoint(podIp)) throw new Error("Sandbox endpoint does not match its Pod IP.");
  if (meta?.rpcTokenNonce == null) return { wsUrl: url.toString(), headers: {} };
  const nonce = typeof meta.rpcTokenNonce === "string" ? meta.rpcTokenNonce : "";
  const token = createSandboxRpcToken(input.signingKey, input.spaceId, nonce);
  return { wsUrl: url.toString(), headers: { authorization: `Bearer ${token}` } };
}
