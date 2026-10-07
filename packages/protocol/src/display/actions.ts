import { DISPLAY_INPUT_MAX_SCHEDULE_MS, type DisplayInputEvent, type DisplaySystemAction, normalizeDisplayPoint, splitDisplayText } from "./index.js";

export const DISPLAY_ACTION_TYPES = ["tap", "long_press", "swipe", "scroll", "type", "key", "system", "wait"] as const;
export type DisplayActionType = (typeof DISPLAY_ACTION_TYPES)[number];

export type DisplayAction = {
  type: DisplayActionType;
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
};

const ACTION_GAP_MS = 150;
const TAP_MS = 60;
const MULTI_TAP_GAP_MS = 80;
const LONG_PRESS_MS = 800;
const SWIPE_MS = 300;
const SCROLL_MS = 400;
const WAIT_MS = 500;
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

export function compileDisplayActions(actions: readonly DisplayAction[], width: number, height: number): DisplayInputEvent[] {
  const events: DisplayInputEvent[] = [];
  let t = 0;
  const point = (action: DisplayAction, xKey: "x" | "to_x" = "x", yKey: "y" | "to_y" = "y") => {
    const x = action[xKey];
    const y = action[yKey];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new DisplayActionError(`${action.type} needs ${xKey} and ${yKey}`);
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      throw new DisplayActionError(`${action.type} at (${x}, ${y}) is outside the ${width}×${height} image`);
    }
    return normalizeDisplayPoint(x, y, width, height);
  };
  const duration = (action: DisplayAction, fallback: number) =>
    Math.round(Math.min(MAX_STEP_MS, Math.max(1, action.duration_ms ?? fallback)));

  for (const action of actions) {
    switch (action.type) {
      case "tap": {
        const at = { ...point(action), ...(action.button && action.button !== "primary" ? { button: action.button } : {}) };
        const count = Math.round(Math.min(3, Math.max(1, action.count ?? 1)));
        for (let tap = 0; tap < count; tap++) {
          if (tap > 0) t += MULTI_TAP_GAP_MS;
          events.push({ type: "pointer", action: "down", ...at, t }, { type: "pointer", action: "up", ...at, t: t + TAP_MS });
          t += TAP_MS;
        }
        break;
      }
      case "long_press": {
        const at = point(action);
        const hold = duration(action, LONG_PRESS_MS);
        events.push({ type: "pointer", action: "down", ...at, t }, { type: "pointer", action: "up", ...at, t: t + hold });
        t += hold;
        break;
      }
      case "swipe": {
        const from = point(action);
        const to = point(action, "to_x", "to_y");
        const length = duration(action, SWIPE_MS);
        events.push(
          { type: "pointer", action: "down", ...from, t },
          { type: "pointer", action: "move", x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, t: t + Math.round(length / 2) },
          { type: "pointer", action: "up", ...to, t: t + length },
        );
        t += length;
        break;
      }
      case "scroll": {
        const at = typeof action.x === "number" || typeof action.y === "number" ? point(action) : { x: 0.5, y: 0.5 };
        const amount = Math.min(1, Math.max(0.1, action.amount ?? 0.5));
        const direction = action.direction ?? "down";
        const dx = direction === "right" ? amount : direction === "left" ? -amount : 0;
        const dy = direction === "down" ? amount : direction === "up" ? -amount : 0;
        events.push({ type: "scroll", ...at, dx, dy, t });
        t += SCROLL_MS;
        break;
      }
      case "type":
        if (!action.text) throw new DisplayActionError("type needs text");
        for (const text of splitDisplayText(action.text)) events.push({ type: "text", text, t });
        break;
      case "key": {
        if (!action.key) throw new DisplayActionError("key needs a key");
        const { key, modifiers } = parseDisplayKeyCombo(action.key);
        events.push(...displayKeyEvents(key, modifiers, t));
        break;
      }
      case "system":
        if (!action.action) throw new DisplayActionError("system needs an action");
        events.push({ type: "system", action: action.action, t });
        break;
      case "wait":
        t += duration(action, WAIT_MS);
        break;
      default:
        throw new DisplayActionError(`unknown action ${String((action as { type?: unknown }).type)}`);
    }
    t += ACTION_GAP_MS;
    if (t > DISPLAY_INPUT_MAX_SCHEDULE_MS) throw new DisplayActionError("the actions take longer than a minute; split them up");
  }
  if (events.length === 0) throw new DisplayActionError("no action touches the display");
  return events;
}
