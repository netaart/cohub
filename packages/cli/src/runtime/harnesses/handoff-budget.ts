import { trimProjectionTurnsToCompaction, type CanonicalProjectionTurn, type ContentBlock, type ProjectionInput } from "@neta-art/cohub";

const IMAGE_CHARS = 6_000;

const NOTE_CHARS = 300;

/** Only embedded images are handed over. */
export function imageChars(block: ContentBlock): number {
  if (block.type === "tool_result") return Array.isArray(block.content) ? block.content.reduce((sum, item) => sum + imageChars(item), 0) : 0;
  return block.type === "image" && block.source.type === "base64" ? IMAGE_CHARS : 0;
}

export type HandoffBudget = { chars: number; blockChars?: (block: ContentBlock) => number };

function contentChars(block: ContentBlock): number {
  switch (block.type) {
    case "text":
    case "system_note": return block.text.length;
    case "tool_use": return block.name.length + JSON.stringify(block.input ?? null).length;
    case "tool_result": return (typeof block.content === "string" ? block.content.length : block.content.reduce((sum, item) => sum + (item.type === "text" ? item.text.length : 0), 0)) + imageChars(block);
    default: return imageChars(block);
  }
}

const turnChars = (turn: CanonicalProjectionTurn, blockChars: (block: ContentBlock) => number) =>
  turn.messages.reduce((sum, message) => sum + message.content.reduce((total, block) => total + blockChars(block), 0), 0);

function withGapNote(turn: CanonicalProjectionTurn, omitted: number, sessionId: string): CanonicalProjectionTurn {
  const note: ContentBlock = {
    type: "text",
    text: `[${omitted} earlier ${omitted === 1 ? "turn" : "turns"} of this chat left out here. If you need them, read them with \`cohub spaces turns ls --session ${sessionId} --cursor ${turn.sequence} --direction older --json\`.]`,
  };
  const index = turn.messages.findIndex((message) => message.role === "user");
  const messages = index < 0
    ? [{ id: `${turn.id}:handoff-note`, turnId: turn.id, role: "user" as const, content: [note], sourceSessionId: turn.sourceSessionId, sequence: turn.sequence, createdAt: turn.createdAt }, ...turn.messages]
    : turn.messages.map((message, position) => position === index ? { ...message, content: [note, ...message.content] } : message);
  return { ...turn, messages };
}

/** Whole Turns within `budget.chars`: the opening one, then the newest that fit; the newest always. */
export function fitHandoff(input: ProjectionInput, budget: HandoffBudget): ProjectionInput {
  const turns = trimProjectionTurnsToCompaction(input.turns);
  const costs = turns.map((turn) => turnChars(turn, budget.blockChars ?? contentChars));
  if (costs.reduce((sum, cost) => sum + cost, 0) <= budget.chars) return turns === input.turns ? input : { ...input, turns };
  const last = turns.length - 1;
  let remaining = budget.chars - NOTE_CHARS - (costs[last] ?? 0);
  const opening = last > 0 && (costs[0] ?? 0) <= remaining ? 1 : 0;
  if (opening) remaining -= costs[0] ?? 0;
  let start = last;
  while (start > opening && (costs[start - 1] ?? 0) <= remaining) remaining -= costs[--start] ?? 0;
  const omitted = start - opening;
  const [first, ...rest] = turns.slice(start);
  const recent = first && omitted > 0 ? [withGapNote(first, omitted, input.sessionId), ...rest] : turns.slice(start);
  return { ...input, turns: [...turns.slice(0, opening), ...recent] };
}
