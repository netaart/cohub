import { loadSkillsFromDirectory, type SkillDirectoryReader } from "@cohub/infra/config-runtime/skills";
import type { RpcMethod, RpcRequestMap } from "@cohub/protocol/sandbox";
import { SandboxRpcError, type SandboxConnection } from "@cohub/sandbox-client";
import { logger } from "../logger.js";
import { SANDBOX_WORKSPACE_PATH, SANDBOX_WORKSPACE_SKILLS_PATH } from "../runtime/paths.js";
import { PROJECT_PROMPT_FILES, type LocalPromptWorkspace } from "../runtime/system-prompt-builder.js";
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

/** Reads a local Space's project files once from the user's machine; without a connection there are none. */
export async function loadLocalPromptWorkspace(input: {
  rpc: RpcCall | null;
  spaceId: string;
  mounts: LocalPromptWorkspace["mounts"];
}): Promise<LocalPromptWorkspace> {
  const { rpc } = input;
  if (!rpc) return { hostRoot: null, files: {}, skills: [], mounts: input.mounts };

  const skillReader: SkillDirectoryReader = {
    async listDirectories(dir) {
      const listing = await rpc("fs.ls", { path: dir }).catch(() => null);
      return listing ? listing.entries.filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1)) : null;
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
  const readText = async (relativePath: string) => {
    try {
      return (await rpc("fs.read", { path: `${SANDBOX_WORKSPACE_PATH}/${relativePath}` })).content.trim() || undefined;
    } catch (error) {
      if (!isNotFound(error)) logger.warn(`[LocalWorkspace] failed to read ${relativePath} spaceId=${input.spaceId}`, error);
      return undefined;
    }
  };

  const [hostRoot, texts, skills] = await Promise.all([
    rpc("fs.stat", { path: SANDBOX_WORKSPACE_PATH })
      .then((result) => result.path && result.path !== SANDBOX_WORKSPACE_PATH ? result.path : null)
      .catch(() => null),
    Promise.all(PROJECT_PROMPT_FILES.map(readText)),
    loadSkillsFromDirectory({ dir: SANDBOX_WORKSPACE_SKILLS_PATH, sandboxDir: SANDBOX_WORKSPACE_SKILLS_PATH, scope: "project", reader: skillReader }),
  ]);
  const files: LocalPromptWorkspace["files"] = {};
  PROJECT_PROMPT_FILES.forEach((name, index) => {
    if (texts[index]) files[name] = texts[index];
  });
  return { hostRoot, files, skills: skills.content.skills, mounts: input.mounts };
}
