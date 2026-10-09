import { readSessionTurnOrigin } from "@cohub/protocol/model";
import type { ReferenceInput } from "./types.js";

/** A causal edge, independent of whether the caller and child share a Space or Session. */
export const turnTriggerReference = (turn: {
  id: string;
  sessionId: string;
  spaceId: string;
  meta: unknown;
}): ReferenceInput | null => {
  const origin = readSessionTurnOrigin(turn.meta, turn.spaceId);
  if (!origin || origin.turnId === turn.id) return null;
  return {
    kind: "turn_trigger",
    sourceType: "turn",
    sourceId: origin.turnId,
    sourceSpaceId: origin.spaceId,
    sourceSessionId: origin.sessionId,
    targetType: "turn",
    targetId: turn.id,
    count: 1,
    meta: {
      kind: origin.kind,
      targetSpaceId: turn.spaceId,
      targetSessionId: turn.sessionId,
      ...(origin.toolCallId ? { toolCallId: origin.toolCallId } : {}),
    },
  };
};
