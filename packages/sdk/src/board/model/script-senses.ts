import {
  BOARD_SCRIPT_SENSES,
  type BoardScriptAudio,
  type BoardScriptEnv,
  type BoardScriptEvent,
  type BoardScriptMotion,
  type BoardScriptSense,
  type BoardScriptSenseState,
} from "./script.js";

export const BOARD_SCRIPT_MOTION_SAMPLES = 64;

const senses = new Set<string>(BOARD_SCRIPT_SENSES);
export const isBoardScriptSense = (type: string): type is BoardScriptSense => senses.has(type);

export function boardScriptSenseStates(state: BoardScriptSenseState): Record<BoardScriptSense, BoardScriptSenseState> {
  return Object.fromEntries(BOARD_SCRIPT_SENSES.map((sense) => [sense, state])) as Record<BoardScriptSense, BoardScriptSenseState>;
}

export const BOARD_SCRIPT_EXPORT_ENV: BoardScriptEnv = {
  mode: "export",
  pointer: "fine",
  orientation: "landscape",
  reducedMotion: false,
  locale: null,
  senses: boardScriptSenseStates("unavailable"),
};

export function sameBoardScriptEnv(a: BoardScriptEnv, b: BoardScriptEnv): boolean {
  if (a === b) return true;
  if (a.mode !== b.mode || a.pointer !== b.pointer || a.orientation !== b.orientation || a.reducedMotion !== b.reducedMotion || a.locale !== b.locale)
    return false;
  return BOARD_SCRIPT_SENSES.every((sense) => a.senses[sense] === b.senses[sense]);
}

export function mergeBoardScriptSense(pending: BoardScriptEvent, next: BoardScriptEvent): BoardScriptEvent {
  if (next.type === "motion") {
    const a = pending.data as BoardScriptMotion;
    const b = next.data as BoardScriptMotion;
    return { ...next, data: { ...b, samples: [...a.samples, ...b.samples].slice(-BOARD_SCRIPT_MOTION_SAMPLES) } };
  }
  if (next.type === "audio") {
    const a = pending.data as BoardScriptAudio;
    const b = next.data as BoardScriptAudio;
    return a.onset && !b.onset ? { ...next, data: { ...b, onset: true } } : next;
  }
  return next;
}
