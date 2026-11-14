import { settleTurnSpeechSegment } from "@cohub/core/sessions";
import { readTurnSpeechTarget } from "@cohub/protocol";
import type { GenerationContentBlock } from "@cohub/protocol/generation";
import type { TaskPayload } from "@cohub/protocol/task";
import { db } from "../db.js";
import { dispatchTurnUpdated } from "../realtime-events.js";
import { toTurnRecord } from "./generation-session.js";

export async function settleTurnSpeechTask(input: { taskRunId: string; payload: TaskPayload; output?: GenerationContentBlock[] }) {
  const target = readTurnSpeechTarget(input.payload.data?.speech);
  if (!target || !input.payload.spaceId) return;
  const audio = input.output?.find((block) => block.type === "audio" && block.source.type === "url");
  const url = audio?.type === "audio" && audio.source.type === "url" ? audio.source.url : null;
  const row = await settleTurnSpeechSegment(db, target, url
    ? { taskId: input.taskRunId, status: "completed", url }
    : { taskId: input.taskRunId, status: "failed" });
  if (!row) return;
  await dispatchTurnUpdated({
    spaceId: input.payload.spaceId,
    turn: { ...toTurnRecord(row), sessionId: target.sessionId, sourceSessionId: row.sessionId, sourceTurnId: row.id },
  });
}
