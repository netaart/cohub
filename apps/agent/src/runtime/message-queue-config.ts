import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { assertValidSpaceId } from "./ids.js";
import { assertInsideRoot } from "./path-containment.js";
import { getAgentWorkspacePath } from "./paths.js";

export const MESSAGE_QUEUE_CONFIG_PATH = ".cohub/agent.json";
export const MESSAGE_QUEUE_CONFIG_MAX_BYTES = 4096;

const OUTSIDE_WORKSPACE_MESSAGE = "Message queue config must stay inside its workspace";

export const FOLLOWUP_DELIVERY_MODES = ["together", "one_by_one"] as const;
export type FollowupDelivery = (typeof FOLLOWUP_DELIVERY_MODES)[number];
export const DEFAULT_FOLLOWUP_DELIVERY: FollowupDelivery = "together";

export type MessageQueueConfig = {
  version: 1;
  followupDelivery: FollowupDelivery;
};

const CONFIG_KEYS = ["version", "followupDelivery"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFollowupDelivery(value: unknown): value is FollowupDelivery {
  return FOLLOWUP_DELIVERY_MODES.some((mode) => mode === value);
}

export function parseMessageQueueConfig(rawText: string): MessageQueueConfig {
  const parsed: unknown = JSON.parse(rawText);
  if (!isRecord(parsed)) throw new Error("Message queue config must be a JSON object");
  if (Object.keys(parsed).some((key) => !CONFIG_KEYS.includes(key))) throw new Error("Unknown field in message queue config");
  if (parsed.version !== 1) throw new Error("Unsupported message queue config version");
  if (!isFollowupDelivery(parsed.followupDelivery)) {
    throw new Error(`Unknown followupDelivery in message queue config: ${String(parsed.followupDelivery)}`);
  }
  return { version: 1, followupDelivery: parsed.followupDelivery };
}

/** Return null only when the entry itself is absent; a dangling symlink makes realpath throw ENOENT, which must propagate. */
async function realpathIfExists(path: string): Promise<string | null> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return realpath(path);
}

export async function readMessageQueueConfig(spaceId: string): Promise<MessageQueueConfig | null> {
  const workspace = getAgentWorkspacePath(assertValidSpaceId(spaceId));
  const workspaceReal = await realpathIfExists(workspace);
  if (!workspaceReal) return null;
  const configDirReal = await realpathIfExists(join(workspace, ".cohub"));
  if (!configDirReal) return null;
  assertInsideRoot(configDirReal, workspaceReal, OUTSIDE_WORKSPACE_MESSAGE);
  const configReal = await realpathIfExists(join(configDirReal, "agent.json"));
  if (!configReal) return null;
  assertInsideRoot(configReal, workspaceReal, OUTSIDE_WORKSPACE_MESSAGE);

  const handle = await open(configReal, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); // O_NONBLOCK: a FIFO must not block the claim transaction
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MESSAGE_QUEUE_CONFIG_MAX_BYTES) {
      throw new Error(`Message queue config must be a regular file of at most ${MESSAGE_QUEUE_CONFIG_MAX_BYTES} bytes`);
    }
    // realpath and open are not atomic; check the path the kernel actually opened.
    assertInsideRoot(await realpath(`/proc/self/fd/${handle.fd}`), workspaceReal, OUTSIDE_WORKSPACE_MESSAGE);

    // One byte past the size check: a file that grew after fstat reads back more bytes than fstat reported.
    const buffer = Buffer.alloc(MESSAGE_QUEUE_CONFIG_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size) throw new Error("Message queue config changed while reading");
    return parseMessageQueueConfig(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}
