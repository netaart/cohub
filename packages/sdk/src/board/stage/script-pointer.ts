import type { BoardPointerEvent } from "../editor/index.js";
import type { BoardScriptTool } from "../model/script.js";

export type BoardScriptPointerTarget = { owner: string; target: string };
type Gesture = {
  target: BoardScriptPointerTarget | null;
  x: number;
  y: number;
  cancelled?: boolean;
};

export function createBoardScriptPointerRouter() {
  const gestures = new Map<number, Gesture>();
  return {
    needsRouting(pointerId: number, scriptsEnabled: boolean): boolean {
      return scriptsEnabled || gestures.has(pointerId);
    },
    owner(pointerId: number): "editor" | "script" | null {
      const gesture = gestures.get(pointerId);
      return gesture ? (gesture.target ? "script" : "editor") : null;
    },
    route(
      phase: "down" | "move" | "up" | "leave",
      pointerId: number,
      target: BoardScriptPointerTarget | null,
      point: { x: number; y: number },
      cancelled = false,
    ): {
      recipient: BoardScriptPointerTarget | null;
      click: BoardScriptPointerTarget | null;
    } {
      if (phase === "down") gestures.set(pointerId, { target, ...point });
      const gesture = gestures.get(pointerId);
      const recipient = gesture
        ? gesture.cancelled ? null : gesture.target
        : phase === "move"
          ? target
          : null;
      let click: BoardScriptPointerTarget | null = null;
      if (phase === "up") {
        gestures.delete(pointerId);
        if (
          !cancelled && !gesture?.cancelled &&
          gesture?.target &&
          target?.owner === gesture.target.owner &&
          target.target === gesture.target.target &&
          Math.hypot(point.x - gesture.x, point.y - gesture.y) < 5
        )
          click = gesture.target;
      }
      return { recipient, click };
    },
    cancelScripts(cancel: (pointerId: number, target: BoardScriptPointerTarget) => void, owner?: string, retained?: Readonly<Record<string, unknown>>) {
      for (const [pointerId, gesture] of gestures) {
        if (!gesture.cancelled && gesture.target && (!owner || gesture.target.owner === owner) &&
            (!retained || !Object.hasOwn(retained, gesture.target.target))) {
          gesture.cancelled = true;
          cancel(pointerId, gesture.target);
        }
      }
    },
    clear() {
      gestures.clear();
    },
  };
}

const DRAG_EVENTS = ["pointerdown", "pointermove", "pointerup"];

/**
 * What a press on a script region does: `drag` gives the script the whole gesture, `tap` a click on
 * release while a drag goes to the editor, and `pass` leaves it to the editor. Under the hand tool
 * a region only takes taps, so dragging always pans.
 */
export function boardScriptPress(listens: readonly string[], tapsOnly = false): "drag" | "tap" | "pass" {
  if (!tapsOnly && DRAG_EVENTS.some((type) => listens.includes(type))) return "drag";
  return listens.includes("click") ? "tap" : "pass";
}

export function boardScriptsMayTakeInput(
  event: Pick<BoardPointerEvent, "button" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  editor: { busy: boolean; onHandle: () => boolean },
): boolean {
  if (editor.busy || event.button === 1 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
  return !editor.onHandle();
}

export function boardScriptTakesTool(tools: readonly BoardScriptTool[] | undefined, tool: string, readonly: boolean): boolean {
  return readonly || tool === "play" || (tools ?? DEFAULT_TOOLS).includes(tool as BoardScriptTool);
}

const DEFAULT_TOOLS: readonly BoardScriptTool[] = ["select", "hand"];
