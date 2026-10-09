import type { SandboxConnection } from "@cohub/sandbox-client";
import { logger } from "./logger.js";
import { ensureSandboxConnection, recoverSandboxForUpgrade } from "./sandbox-pool.js";
import { supportsAtomicUpload } from "./sandbox-upload-capabilities.js";

export async function connectAtomicInstallSandbox(spaceId: string, reason: string): Promise<SandboxConnection | null> {
  let connection = await ensureSandboxConnection(spaceId);
  if (supportsAtomicUpload(connection.capabilities)) return connection;

  logger.warn("[SandboxInstall] sandbox lacks atomic install capabilities; requesting upgrade", { spaceId, reason });
  const recovery = await recoverSandboxForUpgrade(spaceId, reason);
  if (!recovery.recovering && (recovery.throttled || !recovery.ok)) return null;

  connection = await ensureSandboxConnection(spaceId, { timeoutMs: 180_000 });
  if (supportsAtomicUpload(connection.capabilities)) return connection;
  logger.error("[SandboxInstall] sandbox upgrade did not provide atomic install capabilities", { spaceId, reason });
  return null;
}
