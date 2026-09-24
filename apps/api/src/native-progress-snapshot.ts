import type { NativeTurnProgress } from "@cohub/protocol";
import type { SessionStreamSnapshot } from "./session-stream-snapshot.js";

type SnapshotMessage = SessionStreamSnapshot["intermediateMessages"][number];

const snapshotMessages = (turnId: string, messages: NativeTurnProgress["messages"], from = 0): SnapshotMessage[] => messages.map((message, index) => {
  const messageOrdinal = from + index;
  return {
    messageId: `turn:${turnId}:assistant:${messageOrdinal}`, messageOrdinal,
    content: message.content.map((block, streamIndex) => ({ ...block, _meta: { ...block._meta, streamIndex } })),
  };
});

function snapshotOf(identity: { spaceId: string; sessionId: string; turnId: string; userMessageId: string }, revision: number, messages: SnapshotMessage[]): SessionStreamSnapshot {
  return { version: 2, spaceId: identity.spaceId, sessionId: identity.sessionId, turnId: identity.turnId, anchorUserMessageId: identity.userMessageId,
    seq: revision, current: { ...(messages.at(-1) ?? { messageId: null, messageOrdinal: null, content: [] }), appendPath: null },
    intermediateMessages: messages.slice(0, -1), updatedAt: Date.now() };
}

export function nativeProgressSnapshot(identity: { spaceId: string; sessionId: string; turnId: string; userMessageId: string }, progress: NativeTurnProgress): SessionStreamSnapshot {
  return snapshotOf(identity, progress.revision, snapshotMessages(identity.turnId, progress.messages));
}

/** Apply progress to the Turn's current snapshot. */
export function mergeNativeProgress(current: SessionStreamSnapshot | null, identity: { spaceId: string; sessionId: string; turnId: string; userMessageId: string }, progress: NativeTurnProgress) {
  const from = progress.from ?? 0;
  const changed = snapshotMessages(identity.turnId, progress.messages, from);
  const previous = current?.turnId === identity.turnId ? [...current.intermediateMessages, current.current].filter((message) => message.messageOrdinal !== null) : [];
  if (previous.length < from) return null;
  return { snapshot: snapshotOf(identity, progress.revision, [...previous.slice(0, from), ...changed]), changed };
}
