import type { MessageRecord } from "@neta-art/cohub";

export function getUserBubbleLayout(message: Pick<MessageRecord, "text" | "content">): { fillUserWidth: boolean; inlineUserMeta: boolean } {
  const content = message.content ?? [];
  const contentText = content
    .flatMap((block) => block.type === "text" && block.text.trim() ? [block.text] : [])
    .join("\n\n");
  // The renderer prefers content blocks; the optional text summary may arrive later.
  const text = contentText || message.text || "";
  const fillUserWidth = text.includes("\n");
  return {
    fillUserWidth,
    inlineUserMeta: !fillUserWidth && text.length <= 24 && content.every((block) => block.type === "text"),
  };
}
