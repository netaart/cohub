import { randomUUID } from "node:crypto";
import type { NativeTurnBinding, NativeTurnProgress } from "@cohub/protocol";
import type { RealtimePatchOperation } from "@cohub/protocol/realtime";
import { redisCommandClient } from "./redis.js";
import { dispatchRealtimeEvent } from "./channels.js";
import { getSessionStreamSnapshotKey, type SessionStreamSnapshot } from "./session-stream-snapshot.js";

const bindingKey = (turnId: string) => `runtime:native-turn:${turnId}`;
type CachedBinding = NativeTurnBinding & { spaceId: string; ownerUserId: string; userMessageId: string };

export async function cacheNativeTurnBinding(input: CachedBinding) {
  await redisCommandClient.set(bindingKey(input.turnId), JSON.stringify(input), "EX", 24 * 60 * 60);
}

export async function clearNativeTurnBinding(turnId: string) {
  await redisCommandClient.del(bindingKey(turnId));
}

/** A finalized Turn releases the ephemeral snapshot; delayed realtime delivery is already sequenced separately. */
export async function releaseNativeStreamSnapshot(spaceId: string, sessionId: string, turnId: string) {
  const key = getSessionStreamSnapshotKey(spaceId, sessionId);
  // Only clear when it still belongs to this Turn: a newer Turn's snapshot must survive.
  await redisCommandClient.eval(
    `local current = redis.call('GET', KEYS[1])
     if current and cjson.decode(current).turnId == ARGV[1] then return redis.call('DEL', KEYS[1]) end
     return 0`,
    1, key, turnId,
  );
}

/** A new Turn takes over the snapshot atomically; a stale finalized Turn can never block it. */
export async function adoptNativeStreamSnapshot(spaceId: string, sessionId: string, turnId: string, userMessageId: string) {
  const key = getSessionStreamSnapshotKey(spaceId, sessionId);
  // revision 0 = placeholder: the first real progress (any revision >= 1) always wins.
  const empty = JSON.stringify(nativeProgressSnapshot({ spaceId, sessionId, turnId, userMessageId }, { revision: 0, messages: [] }));
  // Older Turn snapshots are replaced; an equal-or-newer snapshot for this same Turn stays.
  await redisCommandClient.eval(
    `local current = redis.call('GET', KEYS[1])
     if current then
       local snapshot = cjson.decode(current)
       if snapshot.turnId == ARGV[2] and snapshot.seq > 0 then return 0 end
     end
     redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
     return 1`,
    1, key, empty, turnId, "3600",
  );
}

export function nativeProgressSnapshot(identity: { spaceId: string; sessionId: string; turnId: string; userMessageId: string }, progress: NativeTurnProgress): SessionStreamSnapshot {
  const messages = progress.messages.map((message, messageOrdinal) => ({
    messageId: `turn:${identity.turnId}:assistant:${messageOrdinal}`, messageOrdinal,
    content: message.content.map((block, streamIndex) => ({ ...block, _meta: { ...block._meta, streamIndex } })),
  }));
  return { version: 2, spaceId: identity.spaceId, sessionId: identity.sessionId, turnId: identity.turnId, anchorUserMessageId: identity.userMessageId,
    seq: progress.revision, current: { ...(messages.at(-1) ?? { messageId: null, messageOrdinal: null, content: [] }), appendPath: null },
    intermediateMessages: messages.slice(0, -1), updatedAt: Date.now() };
}

/** Fast path: progress is ephemeral Redis/realtime state, never a DB write. */
export async function publishNativeProgress(spaceId: string, userId: string, sessionId: string, turnId: string, progress: NativeTurnProgress) {
  const raw = await redisCommandClient.get(bindingKey(turnId));
  if (!raw) return { accepted: false };
  let binding: CachedBinding;
  try { binding = JSON.parse(raw) as CachedBinding; }
  catch { return { accepted: false }; }
  if (binding.spaceId !== spaceId || binding.ownerUserId !== userId || binding.sessionId !== sessionId) return { accepted: false };

  const key = getSessionStreamSnapshotKey(spaceId, sessionId);
  const snapshot = nativeProgressSnapshot({ spaceId, sessionId, turnId, userMessageId: binding.userMessageId }, progress);
  // Atomic compare-and-set: a stale Turn or a lower revision can never replace current streaming state.
  const claim = await redisCommandClient.eval(
    `local current = redis.call('GET', KEYS[1])
     if current then
       local snapshot = cjson.decode(current)
       if snapshot.turnId ~= ARGV[2] then return 0 end
       if snapshot.seq >= tonumber(ARGV[3]) then return 0 end
     end
     redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
     return 1`,
    1, key, JSON.stringify(snapshot), turnId, String(progress.revision), "3600",
  );
  if (!claim) return { accepted: false };
  for (const message of [...snapshot.intermediateMessages, snapshot.current]) {
    if (message.messageOrdinal === null) continue;
    const ops: RealtimePatchOperation[] = [
      { o: "replace", p: "/message/status", v: "streaming" },
      { o: "merge", p: "/message/metadata", v: { is_complete: false, turnId, anchorUserMessageId: snapshot.anchorUserMessageId } },
      ...message.content.map((block, index): RealtimePatchOperation => ({ o: "replace", p: `/message/content/blocks/${index}`, v: block })),
    ];
    await dispatchRealtimeEvent({ id: randomUUID(), timestamp: Date.now(), domain: "session", type: "session.turn.patch", spaceId, sessionId,
      payload: { turnId, messageId: message.messageId, messageOrdinal: message.messageOrdinal, anchorUserMessageId: snapshot.anchorUserMessageId,
        sourceMessageId: snapshot.anchorUserMessageId, seq: progress.revision, baseSeq: 0, ops } });
  }
  return { accepted: true };
}
