import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MESSAGE_QUEUE_CONFIG_PATH = ".cohub/queue.json";

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

/** Read `.cohub/queue.json` from a Space workspace; a missing file means the default delivery. */
export async function readMessageQueueConfig(workspacePath: string): Promise<MessageQueueConfig | null> {
  let rawText: string;
  try {
    rawText = await readFile(join(workspacePath, MESSAGE_QUEUE_CONFIG_PATH), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseMessageQueueConfig(rawText);
}
