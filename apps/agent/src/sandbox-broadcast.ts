import { createHash } from "node:crypto";
import type { SandboxBroadcast } from "@cohub/sandbox-client";

// Claim and publish in one Redis step, so a claimed event is never dropped.
export const PUBLISH_ONCE_LUA =
  "if redis.call('SET', KEYS[1], '1', 'NX', 'PX', ARGV[1]) then return redis.call('PUBLISH', ARGV[2], ARGV[3]) end return -1";

const SANDBOX_BROADCAST_CLAIM_TTL_MS = 60_000;

export type PublishOnce = { key: string; id: string; ttlMs: number };

/** Every attached agent relays the same sandbox broadcast; only the first claim publishes it. */
export function sandboxBroadcastOnce(input: {
  spaceId: string;
  type: string;
  payload: unknown;
  broadcast?: SandboxBroadcast;
}): PublishOnce | undefined {
  const { spaceId, type, payload, broadcast } = input;
  if (!broadcast?.sandboxId || !Number.isFinite(broadcast.timestamp)) return undefined;
  const hex = createHash("sha256")
    .update([spaceId, type, broadcast.sandboxId, broadcast.timestamp, JSON.stringify(payload)].join("\0"))
    .digest("hex");
  return {
    key: `sandbox:broadcast:${spaceId}:${hex.slice(0, 32)}`,
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
    ttlMs: SANDBOX_BROADCAST_CLAIM_TTL_MS,
  };
}
