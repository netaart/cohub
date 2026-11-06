import type { SkillDirectoryReader } from "@cohub/infra/config-runtime/skills";
import type { RpcMethod, RpcRequestMap } from "@cohub/protocol/sandbox";
import { SandboxRpcError, type SandboxConnection } from "@cohub/sandbox-client";
import { logger } from "../logger.js";
import { SANDBOX_WORKSPACE_PATH } from "../runtime/paths.js";
import type { LocalPromptWorkspace } from "../runtime/system-prompt-builder.js";
import type { RpcCall } from "./local-mounts.js";
import { ensureSandboxConnection } from "../sandbox-pool.js";
import { tracedRpc } from "./tools.js";

// Preparing a Turn must not hang on an offline Local Runtime.
const CONNECT_TIMEOUT_MS = 8_000;

const isNotFound = (error: unknown) => error instanceof SandboxRpcError && error.rpcErrorCode === "NOT_FOUND";

export function createLocalRpc(connection: SandboxConnection, context: { spaceId: string; sessionId: string }): RpcCall {
  return <M extends RpcMethod>(method: M, params: RpcRequestMap[M]["params"]) => tracedRpc(connection, method, params, { context }, false);
}

export async function connectLocalRuntime(spaceId: string): Promise<SandboxConnection | null> {
  try {
    return await ensureSandboxConnection(spaceId, { timeoutMs: CONNECT_TIMEOUT_MS });
  } catch (error) {
    logger.warn(`[LocalWorkspace] Local Runtime unreachable spaceId=${spaceId}`, error);
    return null;
  }
}

/** Reads a local Space's project files from the user's machine; without a connection there are none. */
export async function loadLocalPromptWorkspace(input: {
  connection: SandboxConnection | null;
  spaceId: string;
  sessionId: string;
  mounts: Record<string, string> | null;
}): Promise<LocalPromptWorkspace> {
  const { connection } = input;
  if (!connection) {
    return {
      hostRoot: null,
      mounts: null,
      readText: async () => undefined,
      skillReader: { listDirectories: async () => null, readText: async () => null },
    };
  }

  const rpc = createLocalRpc(connection, input);

  const skillReader: SkillDirectoryReader = {
    async listDirectories(dir) {
      try {
        const { entries } = await rpc("fs.ls", { path: dir });
        return entries.filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1));
      } catch {
        return null;
      }
    },
    async readText(path) {
      try {
        return (await rpc("fs.read", { path })).content;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };

  const hostRoot = await rpc("fs.stat", { path: SANDBOX_WORKSPACE_PATH })
    .then((result) => result.path && result.path !== SANDBOX_WORKSPACE_PATH ? result.path : null)
    .catch(() => null);

  return {
    hostRoot,
    mounts: input.mounts,
    readText: async (relativePath) => {
      try {
        return (await rpc("fs.read", { path: `${SANDBOX_WORKSPACE_PATH}/${relativePath}` })).content.trim() || undefined;
      } catch (error) {
        if (!isNotFound(error)) logger.warn(`[LocalWorkspace] failed to read ${relativePath} spaceId=${input.spaceId}`, error);
        return undefined;
      }
    },
    skillReader,
  };
}
