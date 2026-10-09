import type { MessageRecord } from "@neta-art/cohub";
function messageTurnSequence(message: Pick<MessageRecord, "meta">) {
  const sequence = message.meta?.turnSequence;
  return typeof sequence === "number" && Number.isInteger(sequence) ? sequence : null;
}

export function latestUnreadAssistantIndex(messages: MessageRecord[], readSequence: number | null) {
  let latestIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const sequence = messageTurnSequence(message);
    if (sequence !== null && (readSequence === null || sequence > readSequence)) latestIndex = index;
  }
  return latestIndex;
}
