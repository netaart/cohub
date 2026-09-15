import type { MessageRecord } from "@neta-art/cohub";

export type SendBubbleRect = { x: number; y: number; width: number; height: number };
export type SendBubbleSource = SendBubbleRect & { scrollY: number };
export type SendBubbleTransition = { message: MessageRecord; text: string; source: SendBubbleSource };

type Measurable = {
  measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
};

export async function measureSendBubbleSource(input: Measurable | null, root: Measurable | null, scrollY: number): Promise<SendBubbleSource | null> {
  if (!input || !root) return null;
  const measure = (view: Measurable) => new Promise<SendBubbleRect>((resolve) => {
    view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
  const [field, viewport] = await Promise.all([measure(input), measure(root)]);
  if (field.width <= 0 || field.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  return { x: field.x - viewport.x, y: field.y - viewport.y, width: field.width, height: field.height, scrollY };
}

export function isSendBubbleMessage(message: MessageRecord, sent: MessageRecord): boolean {
  if (message.role !== "user" || message.sessionId !== sent.sessionId) return false;
  const clientId = sent.meta?.clientMessageId;
  if (typeof clientId === "string" && typeof message.meta?.clientMessageId === "string") return message.meta.clientMessageId === clientId;
  // Turn projections replace optimistic records, but retain the turn/role slot.
  return message.id === sent.id || (typeof sent.meta?.turnSequence === "number" && message.meta?.turnSequence === sent.meta.turnSequence);
}

export function interpolateSendBubbleRect(source: SendBubbleRect, target: SendBubbleRect, progress: number): SendBubbleRect {
  "worklet";
  const p = Math.max(0, Math.min(1, progress));
  return {
    x: source.x + (target.x - source.x) * p,
    y: source.y + (target.y - source.y) * p,
    width: source.width + (target.width - source.width) * p,
    height: source.height + (target.height - source.height) * p,
  };
}
