import type { AgentTurnAbortEvent } from "@cohub/protocol";

export type ActiveAbortHandle = {
  id: string;
  kind: "turn" | "tool";
  toolName?: string;
  abort: () => void | Promise<void>;
};

/** `round` stops before the next LLM round, `steer` stops on a steer at once, no mode stops only on an explicit abort. */
export type ActiveStopMode = "round" | "steer";

const ABORT_EVENT_TTL_MS = 10 * 60 * 1000;
const activeAbortControllers = new Map<string, Map<AbortController, ActiveStopMode | undefined>>();
const activeAbortHandles = new Map<string, Map<string, ActiveAbortHandle>>();
const activeAbortEvents = new Map<string, AgentTurnAbortEvent>();
const activeAbortEventTimers = new Map<string, ReturnType<typeof setTimeout>>();
const roundBoundaryAbortEvents = new Map<string, AgentTurnAbortEvent>();

const reaches = (mode: ActiveStopMode | undefined, event: AgentTurnAbortEvent) =>
  event.reason === "abort" || mode === "round" || (mode === "steer" && event.reason === "interrupt");

function abortController(controller: AbortController) {
  if (controller.signal.aborted) return false;
  controller.abort();
  return true;
}

function abortHandle(handle: ActiveAbortHandle) {
  void Promise.resolve(handle.abort()).catch(() => undefined);
}

export function setActiveAbortController(turnId: string, controller: AbortController, mode?: ActiveStopMode) {
  const controllers = activeAbortControllers.get(turnId) ?? new Map<AbortController, ActiveStopMode | undefined>();
  controllers.set(controller, mode);
  activeAbortControllers.set(turnId, controllers);
  const event = activeAbortEvents.get(turnId);
  if (event && reaches(mode, event)) abortController(controller);
}

export function clearActiveAbortController(turnId: string, controller: AbortController) {
  const controllers = activeAbortControllers.get(turnId);
  if (!controllers) return;
  controllers.delete(controller);
  if (controllers.size > 0) return;
  activeAbortControllers.delete(turnId);
  roundBoundaryAbortEvents.delete(turnId);
}

export function registerActiveAbortHandle(turnId: string, handle: ActiveAbortHandle) {
  const handles = activeAbortHandles.get(turnId) ?? new Map<string, ActiveAbortHandle>();
  handles.set(handle.id, handle);
  activeAbortHandles.set(turnId, handles);
  if (activeAbortEvents.get(turnId)?.reason === "abort") abortHandle(handle);
  return () => {
    const current = activeAbortHandles.get(turnId);
    if (!current) return;
    current.delete(handle.id);
    if (current.size === 0) activeAbortHandles.delete(turnId);
  };
}

export function clearActiveAbortEvent(turnId: string) {
  activeAbortEvents.delete(turnId);
  const timer = activeAbortEventTimers.get(turnId);
  if (timer) clearTimeout(timer);
  activeAbortEventTimers.delete(turnId);
}

export function setActiveAbortEvent(event: AgentTurnAbortEvent) {
  if (activeAbortEvents.get(event.turnId)?.reason === "abort" && event.reason !== "abort") return;
  clearActiveAbortEvent(event.turnId);
  activeAbortEvents.set(event.turnId, event);
  activeAbortEventTimers.set(event.turnId, setTimeout(() => clearActiveAbortEvent(event.turnId), ABORT_EVENT_TTL_MS));
}

export function abortActiveTurnExecutions(event: AgentTurnAbortEvent) {
  setActiveAbortEvent(event);
  let controllersAborted = 0;
  let handlesAborted = 0;

  for (const [controller, mode] of activeAbortControllers.get(event.turnId) ?? []) {
    if (reaches(mode, event) && abortController(controller)) controllersAborted += 1;
  }

  if (event.reason === "abort") {
    for (const handle of activeAbortHandles.get(event.turnId)?.values() ?? []) {
      abortHandle(handle);
      handlesAborted += 1;
    }
  }

  return { controllersAborted, handlesAborted };
}

function deferToRoundBoundary(event: AgentTurnAbortEvent) {
  const controllers = activeAbortControllers.get(event.turnId);
  if (!controllers || ![...controllers.values()].includes("round") || activeAbortEvents.has(event.turnId)) return false;
  const pending = roundBoundaryAbortEvents.get(event.turnId);
  if (!pending || pending.reason === "billing") roundBoundaryAbortEvents.set(event.turnId, event);
  return true;
}

export function requestActiveTurnStop(event: AgentTurnAbortEvent) {
  if (event.reason !== "abort" && deferToRoundBoundary(event)) return { deferred: true, controllersAborted: 0, handlesAborted: 0 };
  if (event.reason === "billing") return { deferred: false, controllersAborted: 0, handlesAborted: 0 };
  return { deferred: false, ...abortActiveTurnExecutions(event) };
}

export function applyRoundBoundaryAbort(turnId: string) {
  const event = roundBoundaryAbortEvents.get(turnId);
  if (!event) return false;
  roundBoundaryAbortEvents.delete(turnId);
  if (activeAbortEvents.has(turnId)) return false;
  abortActiveTurnExecutions(event);
  return true;
}

export function getActiveAbortEvent(turnId: string) {
  return activeAbortEvents.get(turnId) ?? null;
}
