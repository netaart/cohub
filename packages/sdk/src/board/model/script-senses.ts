import {
  BOARD_SCRIPT_SENSES,
  type BoardScriptBrowserEvent,
  type BoardScriptEnv,
  type BoardScriptEvent,
  type BoardScriptSense,
  type BoardScriptSenseState,
} from "./script.js";

export const BOARD_SCRIPT_BROWSER_EVENTS: Readonly<Record<BoardScriptBrowserEvent, BoardScriptSense>> = {
  "browser:devicemotion": "motion",
  "browser:deviceorientation": "motion",
  "browser:deviceorientationabsolute": "motion",
  "browser:gamepads": "gamepad",
  "browser:audio": "microphone",
  "browser:video": "camera",
  "browser:position": "location",
};

export const boardScriptSenseOf = (type: string): BoardScriptSense | undefined =>
  Object.hasOwn(BOARD_SCRIPT_BROWSER_EVENTS, type) ? BOARD_SCRIPT_BROWSER_EVENTS[type as BoardScriptBrowserEvent] : undefined;

const LATEST = new Set<string>(["browser:gamepads", "browser:position", "browser:video"]);
export const isBoardScriptLatestInput = (type: string) => LATEST.has(type);

export function boardScriptSenseStates(state: BoardScriptSenseState): Record<BoardScriptSense, BoardScriptSenseState> {
  return Object.fromEntries(BOARD_SCRIPT_SENSES.map((sense) => [sense, state])) as Record<BoardScriptSense, BoardScriptSenseState>;
}

export const BOARD_SCRIPT_EXPORT_ENV: BoardScriptEnv = {
  mode: "export",
  pointer: "fine",
  orientation: "landscape",
  angle: 0,
  reducedMotion: false,
  locale: null,
  senses: boardScriptSenseStates("unavailable"),
};

export function sameBoardScriptEnv(a: BoardScriptEnv, b: BoardScriptEnv): boolean {
  if (a === b) return true;
  if (a.mode !== b.mode || a.pointer !== b.pointer || a.orientation !== b.orientation || a.angle !== b.angle || a.reducedMotion !== b.reducedMotion || a.locale !== b.locale)
    return false;
  return BOARD_SCRIPT_SENSES.every((sense) => a.senses[sense] === b.senses[sense]);
}

export function releaseBoardScriptEvent(event: BoardScriptEvent) {
  if (event.type === "browser:video") (event.data as { frame?: { close?(): void } }).frame?.close?.();
}

export type BoardScriptInputLog = { version: 1; inputs: Array<{ t: number; type: string; data: unknown }> };

export const BOARD_SCRIPT_INPUT_LOG_BYTES = 9 * 1024 * 1024;

export const boardScriptInputBytes = (data: unknown) =>
  data && typeof data === "object" && (data as { samples?: unknown }).samples instanceof Float32Array
    ? Math.ceil(((data as { samples: Float32Array }).samples.byteLength * 4) / 3) + 96
    : JSON.stringify(data).length + 48;

const F32 = "$f32";

function encodeFloats(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function decodeFloats(text: string): Float32Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function stringifyBoardScriptInputs(log: BoardScriptInputLog): string {
  return JSON.stringify(log, (_key, value) => (value instanceof Float32Array ? { [F32]: encodeFloats(value) } : value));
}

export function parseBoardScriptInputs(text: string): BoardScriptInputLog {
  const log = JSON.parse(text, (_key, value) =>
    value && typeof value === "object" && typeof value[F32] === "string" && Object.keys(value).length === 1 ? decodeFloats(value[F32]) : value) as unknown;
  const inputs = (log as Partial<BoardScriptInputLog> | null)?.inputs;
  if ((log as Partial<BoardScriptInputLog> | null)?.version !== 1 || !Array.isArray(inputs))
    throw new Error("Not a Board input recording: expected { version: 1, inputs: [...] }.");
  let last = 0;
  for (const [index, input] of inputs.entries()) {
    if (!input || typeof input.t !== "number" || !(input.t >= last) || typeof input.type !== "string" || !boardScriptSenseOf(input.type) || input.type === "browser:video")
      throw new Error(`inputs[${index}] needs a t no earlier than the one before and a browser event type other than browser:video.`);
    last = input.t;
  }
  return log as BoardScriptInputLog;
}

export function boardScriptInputsBetween(log: BoardScriptInputLog | undefined, after: number, until: number): BoardScriptEvent[] {
  if (!log) return [];
  const events: BoardScriptEvent[] = [];
  for (const { t, type, data } of log.inputs) {
    if (t > until) break;
    if (t > after) events.push({ type, data });
  }
  return events;
}
