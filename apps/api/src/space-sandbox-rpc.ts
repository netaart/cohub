import { hostname } from "node:os";
import { createLogger } from "@cohub/infra/logging";
import {
  createSandboxConnectionHeaders,
  SandboxRpcError,
  getSandboxClientConnection,
  hasPendingSandboxRequests,
  disconnectSandboxWsClient,
  startSandboxWsClient,
  waitForSandboxConnection,
  type SandboxConnection,
} from "@cohub/sandbox-client";
import type { RpcEventPayload, RpcMethod, RpcRequestMap } from "@cohub/protocol/sandbox";
import { config } from "./config.js";
import { getSpaceSandboxBySpaceId } from "./space-sandboxes.js";

const logger = createLogger({ serviceName: "cohub-api" });

// Identity the API presents when attaching to a sandbox session. Kept distinct
// from the agent instance id so sandbox-side logs/ownership are attributable.
const API_IDENTITY = `api-${process.env.POD_NAME || hostname() || "unknown"}`;

// Web fs calls are interactive: fail fast when the local sandbox is offline
// rather than hanging the request. The relay reconnects on its own.
const CONNECT_TIMEOUT_MS = 6_000;
const IDLE_TTL_MS = 5 * 60_000;

/**
 * Raised when a space's local sandbox is not currently reachable (runner
 * offline / relay not connected). Callers map this to a 503 so the web client
 * can show its offline state instead of a hard error.
 */
export class SandboxOfflineError extends Error {
  constructor(public readonly spaceId: string, cause?: unknown) {
    super("local sandbox is offline");
    this.name = "SandboxOfflineError";
    if (cause) this.cause = cause;
  }
}

type PoolEntry = { spaceId: string; lastUsedAt: number; idleTimer: ReturnType<typeof setTimeout> | null };
const entries = new Map<string, PoolEntry>();

async function resolveWsEndpoint(spaceId: string): Promise<string> {
  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  const meta = (sandbox?.meta as Record<string, unknown> | null) ?? null;
  const wsEndpoint = typeof meta?.wsEndpoint === "string" ? meta.wsEndpoint.trim() : "";
  if (!wsEndpoint) throw new SandboxOfflineError(spaceId);
  return wsEndpoint;
}

function disconnectEntry(spaceId: string, reason: string) {
  const entry = entries.get(spaceId);
  if (entry?.idleTimer) clearTimeout(entry.idleTimer);
  entries.delete(spaceId);
  disconnectSandboxWsClient(spaceId, reason);
}

function scheduleIdleEviction(entry: PoolEntry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const current = entries.get(entry.spaceId);
    if (!current) return;
    if (Date.now() - current.lastUsedAt < IDLE_TTL_MS || hasPendingSandboxRequests(current.spaceId)) {
      scheduleIdleEviction(current);
      return;
    }
    disconnectEntry(current.spaceId, "api sandbox pool idle eviction");
  }, IDLE_TTL_MS);
}

function touch(spaceId: string) {
  const existing = entries.get(spaceId);
  const entry = existing ?? { spaceId, lastUsedAt: Date.now(), idleTimer: null };
  entry.lastUsedAt = Date.now();
  if (!existing) entries.set(spaceId, entry);
  scheduleIdleEviction(entry);
}

async function ensureConnection(spaceId: string): Promise<SandboxConnection> {
  touch(spaceId);
  const existing = getSandboxClientConnection(spaceId);
  if (existing) return existing;

  const wsUrl = await resolveWsEndpoint(spaceId);
  await startSandboxWsClient({
    spaceId,
    wsUrl,
    identity: API_IDENTITY,
    headers: (endpoint) => createSandboxConnectionHeaders({ wsUrl: endpoint, spaceId, identity: API_IDENTITY, workerSecret: config.workerSecret }),
  });
  try {
    return await waitForSandboxConnection(spaceId, CONNECT_TIMEOUT_MS);
  } catch (error) {
    throw new SandboxOfflineError(spaceId, error);
  }
}

export async function getSandboxCapabilities(spaceId: string) {
  return (await ensureConnection(spaceId)).capabilities;
}

/**
 * Issue a single sandbox RPC on behalf of a web/API request. Connection
 * failures surface as SandboxOfflineError; RPC-level failures surface as the
 * original SandboxRpcError for the caller to translate.
 */
export async function callSandboxRpc<M extends RpcMethod>(
  spaceId: string,
  method: M,
  params: RpcRequestMap[M]["params"],
  options?: { onEvent?: (event: RpcEventPayload) => void },
): Promise<RpcRequestMap[M]["result"]> {
  const connection = await ensureConnection(spaceId);
  try {
    return await connection.request(method, params, {
      spaceId,
      sandboxId: connection.sandboxId,
      onEvent: options?.onEvent,
    });
  } catch (error) {
    if (error instanceof SandboxRpcError && error.rpcErrorCode === "IO_ERROR") {
      // Connection dropped mid-flight; treat as offline for a clean retry story.
      logger.warn(`[SandboxRpc] rpc io error spaceId=${spaceId} method=${method}: ${error.message}`);
      throw new SandboxOfflineError(spaceId, error);
    }
    throw error;
  }
}

export { SandboxRpcError };
