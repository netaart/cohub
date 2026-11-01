import { type DisplayActStep, type DisplayTarget, type DisplayUntil, displayActStepSchema } from "./act.js";
import {
  type DisplayElementAction,
  type DisplayElementRole,
  type DisplayInputEvent,
  type DisplaySystemAction,
  normalizeDisplayPoint,
  splitDisplayText,
} from "./schema.js";

export const DISPLAY_ACTION_TYPES = ["tap", "long_press", "swipe", "scroll", "type", "key", "system", "wait", "launch", "open"] as const;
export type DisplayActionType = (typeof DISPLAY_ACTION_TYPES)[number];

export type DisplayAction = {
  type: DisplayActionType;
  ref?: string;
  name?: string;
  role?: DisplayElementRole;
  nth?: number;
  x?: number;
  y?: number;
  to_x?: number;
  to_y?: number;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  duration_ms?: number;
  count?: number;
  button?: "primary" | "secondary" | "middle";
  text?: string;
  key?: string;
  action?: DisplaySystemAction;
  app?: string;
  url?: string;
  until?: DisplayUntil;
  label?: string;
};

const TAP_MS = 60;
const MULTI_TAP_GAP_MS = 80;
const LONG_PRESS_MS = 800;
const SWIPE_MS = 300;
const MAX_STEP_MS = 10_000;

export class DisplayActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisplayActionError";
  }
}

export const DISPLAY_MODIFIER_KEYS = ["Control", "Alt", "Shift", "Meta"] as const;
export type DisplayModifierKey = (typeof DISPLAY_MODIFIER_KEYS)[number];

const MODIFIER_ALIASES: Record<string, DisplayModifierKey> = {
  control: "Control", ctrl: "Control",
  alt: "Alt", option: "Alt",
  shift: "Shift",
  meta: "Meta", cmd: "Meta", command: "Meta", super: "Meta", win: "Meta",
};

export function displayKeyEvents(key: string, modifiers: readonly DisplayModifierKey[] = [], t?: number): DisplayInputEvent[] {
  const at = t === undefined ? {} : { t };
  return [
    ...modifiers.map((modifier) => ({ type: "key" as const, action: "down" as const, key: modifier, ...at })),
    { type: "key", action: "press", key, ...at },
    ...[...modifiers].reverse().map((modifier) => ({ type: "key" as const, action: "up" as const, key: modifier, ...at })),
  ];
}

export function parseDisplayKeyCombo(combo: string): { key: string; modifiers: DisplayModifierKey[] } {
  const parts = combo.length > 1 && combo.endsWith("++") ? [...combo.slice(0, -2).split("+"), "+"] : combo.length > 1 ? combo.split("+") : [combo];
  const key = parts.pop() ?? "";
  const modifiers = parts.map((part) => MODIFIER_ALIASES[part.trim().toLowerCase()]);
  if (!key || modifiers.some((modifier) => !modifier)) throw new DisplayActionError(`unknown key combo "${combo}"`);
  return { key: MODIFIER_ALIASES[key.toLowerCase()] ?? key, modifiers: [...new Set(modifiers as DisplayModifierKey[])] };
}

function targetOf(action: DisplayAction): DisplayTarget | undefined {
  if (action.ref !== undefined) return { ref: action.ref };
  if (action.name === undefined && action.role === undefined) return undefined;
  return {
    ...(action.name !== undefined ? { name: action.name } : {}),
    ...(action.role !== undefined ? { role: action.role } : {}),
    ...(action.nth !== undefined ? { nth: action.nth } : {}),
  };
}

function elementStep(action: DisplayAction, target: DisplayTarget): DisplayActStep {
  const step = (elementAction: DisplayElementAction, text?: string): DisplayActStep => ({
    type: "element", target, action: elementAction, ...(text === undefined ? {} : { text }),
  });
  switch (action.type) {
    case "tap":
      if ((action.count ?? 1) !== 1 || (action.button ?? "primary") !== "primary") break;
      return step("click");
    case "long_press":
      return step("longPress");
    case "type":
      if (action.text === undefined) throw new DisplayActionError("type into an element needs text");
      return step("setText", action.text);
    case "scroll":
      return step(action.direction === "up" || action.direction === "left" ? "scrollBackward" : "scrollForward");
  }
  throw new DisplayActionError(`${action.type} cannot take an element; use coordinates`);
}

function inputEvents(action: DisplayAction, width: number, height: number): DisplayInputEvent[] {
  const point = (xKey: "x" | "to_x" = "x", yKey: "y" | "to_y" = "y") => {
    const x = action[xKey];
    const y = action[yKey];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new DisplayActionError(`${action.type} needs ${xKey} and ${yKey}, or an element`);
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      throw new DisplayActionError(`${action.type} at (${x}, ${y}) is outside the ${width}×${height} image`);
    }
    return normalizeDisplayPoint(x, y, width, height);
  };
  const duration = (fallback: number) => Math.round(Math.min(MAX_STEP_MS, Math.max(1, action.duration_ms ?? fallback)));
  switch (action.type) {
    case "tap": {
      const at = { ...point(), ...(action.button && action.button !== "primary" ? { button: action.button } : {}) };
      const events: DisplayInputEvent[] = [];
      const count = Math.round(Math.min(3, Math.max(1, action.count ?? 1)));
      for (let tap = 0, t = 0; tap < count; tap++, t += TAP_MS + MULTI_TAP_GAP_MS) {
        events.push({ type: "pointer", action: "down", ...at, t }, { type: "pointer", action: "up", ...at, t: t + TAP_MS });
      }
      return events;
    }
    case "long_press": {
      const at = point();
      return [{ type: "pointer", action: "down", ...at, t: 0 }, { type: "pointer", action: "up", ...at, t: duration(LONG_PRESS_MS) }];
    }
    case "swipe": {
      const from = point();
      const to = point("to_x", "to_y");
      const length = duration(SWIPE_MS);
      return [
        { type: "pointer", action: "down", ...from, t: 0 },
        { type: "pointer", action: "move", x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, t: Math.round(length / 2) },
        { type: "pointer", action: "up", ...to, t: length },
      ];
    }
    case "scroll": {
      const at = typeof action.x === "number" || typeof action.y === "number" ? point() : { x: 0.5, y: 0.5 };
      const amount = Math.min(1, Math.max(0.1, action.amount ?? 0.5));
      const direction = action.direction ?? "down";
      const dx = direction === "right" ? amount : direction === "left" ? -amount : 0;
      const dy = direction === "down" ? amount : direction === "up" ? -amount : 0;
      return [{ type: "scroll", ...at, dx, dy }];
    }
    case "type":
      if (!action.text) throw new DisplayActionError("type needs text");
      return splitDisplayText(action.text).map((text) => ({ type: "text", text }));
    case "key": {
      if (!action.key) throw new DisplayActionError("key needs a key");
      const { key, modifiers } = parseDisplayKeyCombo(action.key);
      return displayKeyEvents(key, modifiers);
    }
    case "system":
      if (!action.action) throw new DisplayActionError("system needs an action");
      return [{ type: "system", action: action.action }];
  }
  throw new DisplayActionError(`unknown action ${String((action as { type?: unknown }).type)}`);
}

function stepOf(action: DisplayAction, width: number, height: number): DisplayActStep {
  switch (action.type) {
    case "launch":
      if (!action.app) throw new DisplayActionError("launch needs an app");
      return { type: "launch", app: action.app };
    case "open":
      if (!action.url) throw new DisplayActionError("open needs a url");
      return { type: "open", url: action.url };
    case "wait":
      return { type: "wait", ...(action.duration_ms !== undefined ? { ms: Math.round(action.duration_ms) } : {}) };
  }
  const target = targetOf(action);
  return target ? elementStep(action, target) : { type: "input", events: inputEvents(action, width, height) };
}

export function compileDisplayPlan(actions: readonly DisplayAction[], width: number, height: number): DisplayActStep[] {
  return actions.map((action, index) => {
    const step = {
      ...stepOf(action, width, height),
      ...(action.until ? { until: action.until } : {}),
      ...(action.label ? { label: action.label } : {}),
    };
    const parsed = displayActStepSchema.safeParse(step);
    if (!parsed.success) throw new DisplayActionError(`action ${index + 1}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return parsed.data;
  });
}
