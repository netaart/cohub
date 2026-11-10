import type { BoardDocument } from "@cohub/protocol";
import { BOARD_SCRIPT_BROADCAST_JSON_LENGTH } from "@cohub/protocol/realtime";
import type { BoardScriptEvent, BoardScriptOutput } from "./script.js";
import { isBoardRootScript } from "./script-index.js";
import { boardScriptScope } from "./script-scope.js";
import { isBoardScriptLatestInput, releaseBoardScriptEvent } from "./script-senses.js";

export const BOARD_SCRIPT_EVENT_QUEUE = 128;
export const BOARD_SCRIPT_EMIT_DEPTH = 16;

function supersedes(pending: BoardScriptEvent, event: BoardScriptEvent): boolean {
  if (pending.type !== event.type) return false;
  if (event.type === "viewchange" || event.type === "selectionchange" || event.type === "peerschange" || isBoardScriptLatestInput(event.type)) return true;
  if (event.type === "pointermove") return pending.pointerId === event.pointerId;
  if (event.type !== "gesture") return false;
  const a = pending.data as { id: string; phase: string };
  const b = event.data as { id: string; phase: string };
  return a.id === b.id && a.phase === "update" && b.phase === "update";
}

export function boardScriptListens(output: BoardScriptOutput | null | undefined, event: BoardScriptEvent): boolean {
  return !output || event.type === "viewchange" || output.listens.includes(event.type);
}

export function queueBoardScriptEvent(queue: BoardScriptEvent[], event: BoardScriptEvent): boolean {
  let queued = queue.length - 1;
  while (queued >= 0 && !supersedes(queue[queued] as BoardScriptEvent, event)) queued--;
  if (queued >= 0 && (event.type !== "pointermove" || queued === queue.length - 1))
    releaseBoardScriptEvent(queue.splice(queued, 1)[0] as BoardScriptEvent);
  if (queue.length >= BOARD_SCRIPT_EVENT_QUEUE) {
    releaseBoardScriptEvent(event);
    return false;
  }
  queue.push(event);
  return true;
}

export type BoardScriptEmit = { target: string; event: BoardScriptEvent };

export function boardScriptEmit(document: Pick<BoardDocument, "items" | "board">, sender: string, input: unknown): BoardScriptEmit {
  const message = input as { target?: unknown; type?: unknown; data?: unknown; depth?: unknown; remote?: unknown } | null;
  if (!message || typeof message.target !== "string" || typeof message.type !== "string" || !message.type)
    throw new Error("emit() takes a target id and an event type.");
  const { target, type } = message;
  if (!isBoardRootScript(document, target) && !boardScriptScope(document, sender).has(target))
    throw new Error(`emit() from ${sender} cannot reach ${target}: it is neither in scope nor a Board script.`);
  const depth = typeof message.depth === "number" && Number.isSafeInteger(message.depth) && message.depth > 0 ? message.depth : 1;
  if (depth > BOARD_SCRIPT_EMIT_DEPTH)
    throw new Error(`emit(${target}, "${type}") from ${sender} is ${depth} handlers deep, past the limit of ${BOARD_SCRIPT_EMIT_DEPTH}: handlers keep answering each other. Emit from onFrame() to send it on the next step.`);
  return { target, event: { type, data: message.data, depth, ...(message.remote === true ? { remote: true } : {}) } };
}

const RESERVED = /^(pointer|key|browser:)|^(click|focus|blur|change|selectionchange|transformend|viewchange|envchange|gesture|peerschange)$/;

export function boardScriptBroadcast(input: unknown): BoardScriptEvent & { data: unknown } {
  const message = input as { type?: unknown; data?: unknown; depth?: unknown } | null;
  const type = message?.type;
  if (typeof type !== "string" || !type || type.length > 64) throw new Error("broadcast() takes an event type of 1–64 characters.");
  if (RESERVED.test(type)) throw new Error(`broadcast("${type}"): input and host event types are reserved.`);
  let json: string | undefined;
  try {
    json = JSON.stringify(message?.data ?? null);
  } catch {}
  if (json === undefined) throw new Error(`broadcast("${type}") data must be JSON.`);
  if (json.length > BOARD_SCRIPT_BROADCAST_JSON_LENGTH)
    throw new Error(`broadcast("${type}") data exceeds ${BOARD_SCRIPT_BROADCAST_JSON_LENGTH} characters of JSON.`);
  const depth = typeof message?.depth === "number" && Number.isSafeInteger(message.depth) && message.depth > 0 ? message.depth : 1;
  if (depth > BOARD_SCRIPT_EMIT_DEPTH)
    throw new Error(`broadcast("${type}") is ${depth} handlers deep, past the limit of ${BOARD_SCRIPT_EMIT_DEPTH}: handlers keep answering each other. Broadcast from onFrame() to send it on the next step.`);
  return { type, data: JSON.parse(json), depth, peer: null };
}

export function createBoardScriptOutbox(order: () => ReadonlyMap<string, number>) {
  let queued: Array<{ rank: number; seq: number; target: string; event: BoardScriptEvent }> = [];
  let seq = 0;
  const waiting = new Map<string, number>();
  return {
    get size() { return queued.length; },
    push(sender: string, target: string, event: BoardScriptEvent) {
      const count = waiting.get(target) ?? 0;
      if (count >= BOARD_SCRIPT_EVENT_QUEUE)
        throw new Error(`emit(${target}, "${event.type}") from ${sender}: ${target} already has ${BOARD_SCRIPT_EVENT_QUEUE} events waiting.`);
      waiting.set(target, count + 1);
      queued.push({ rank: order().get(sender) ?? Number.MAX_SAFE_INTEGER, seq: seq++, target, event });
    },
    take(): Map<string, BoardScriptEvent[]> {
      const batch = queued.sort((a, b) => a.rank - b.rank || a.seq - b.seq);
      queued = [];
      waiting.clear();
      const byTarget = new Map<string, BoardScriptEvent[]>();
      for (const { target, event } of batch) byTarget.set(target, [...(byTarget.get(target) ?? []), event]);
      return byTarget;
    },
  };
}
