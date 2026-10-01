import { randomUUID } from "node:crypto";
import type {
  BoardChangeSummary,
  BoardPlaybackSnapshot,
  BoardDelta,
  RequestSource,
} from "@cohub/protocol";
import { BOARD_REALTIME_DELTA_MAX_BYTES } from "@cohub/protocol";
import { dispatchRealtimeEvent } from "./channels.js";

export async function dispatchBoardChanged(input: {
  spaceId: string;
  boardId: string;
  actorId: string;
  mutationId: string;
  baseVersion: number;
  version: number;
  changed: BoardChangeSummary;
  after: BoardDelta;
  source?: RequestSource | null;
}) {
  const inline = Buffer.byteLength(JSON.stringify(input.after), "utf8") <= BOARD_REALTIME_DELTA_MAX_BYTES;
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "board.changed",
    spaceId: input.spaceId,
    sessionId: null,
    payload: {
      boardId: input.boardId,
      actorId: input.actorId,
      mutationId: input.mutationId,
      baseVersion: input.baseVersion,
      version: input.version,
      changed: input.changed,
      ...(inline ? { after: input.after } : {}),
      ...(input.source ? { source: input.source } : {}),
    },
  });
}

export async function dispatchBoardPlaybackChanged(input: {
  spaceId: string;
  boardId: string;
  playback: BoardPlaybackSnapshot | null;
}) {
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: "board.playback.changed",
    spaceId: input.spaceId,
    sessionId: null,
    payload: { boardId: input.boardId, playback: input.playback },
  });
}
