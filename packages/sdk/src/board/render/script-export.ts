import type { BoardDocument } from "@cohub/protocol";
import { BOARD_SCRIPT_HISTORY_MS, boardScriptParamsKey } from "../model/animation.js";
import { buildBoardScene } from "../model/scene.js";
import { BOARD_SCRIPT_EXPORT_CALLS } from "../model/script-calls.js";
import { composeBoardScriptItems } from "../model/script-scene.js";
import type {
  BoardScriptOutput,
  BoardScriptSnapshot,
  BoardScriptView,
} from "../model/script.js";
import { boardScriptAttachments } from "../model/script-index.js";
import { BOARD_SCRIPT_EMIT_DEPTH, BOARD_SCRIPT_EVENT_QUEUE, boardScriptEmit, createBoardScriptOutbox } from "../model/script-events.js";
import { type BoardScriptInputLog, boardScriptInputsBetween } from "../model/script-senses.js";
import { type BrowserBoardScriptHost, createBoardScriptHost } from "./script-host.js";
import { boardShaderOwners } from "./shader/layers.js";
import type { BoardScriptHost } from "./renderers/board-renderer-registry.js";

export type BrowserBoardScriptExport = {
  at(document: BoardDocument, time: number, view?: BoardScriptView): Promise<BoardScriptHost>;
  dispose(): void;
};

type Run = {
  host: BrowserBoardScriptHost;
  element: HTMLElement;
  outputs: Map<string, BoardScriptOutput>;
  time: number;
  document: BoardDocument | null;
  ranks: Map<string, number>;
  outbox: ReturnType<typeof createBoardScriptOutbox>;
  views: Map<string, string>;
  last: Map<string, string>;
  inputsAt: number;
  wake(): void;
};

export function createBrowserBoardScriptExport(
  readModule: (path: string) => Promise<string>,
  options: {
    snapshots?: Readonly<Record<string, BoardScriptSnapshot>>;
    shaders?: boolean;
    documentAt?: (time: number) => BoardDocument;
    inputs?: BoardScriptInputLog;
  } = {},
): BrowserBoardScriptExport {
  let run: Run | null = null;

  function start(): Run {
    const element = globalThis.document.createElement("div");
    element.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
    globalThis.document.body.appendChild(element);
    const outputs = new Map<string, BoardScriptOutput>();
    const ranks = new Map<string, number>();
    const last = new Map<string, string>();
    const started: Run = {
      element,
      outputs,
      time: 0,
      document: null,
      ranks,
      outbox: createBoardScriptOutbox(() => ranks),
      views: new Map(),
      last,
      inputsAt: -1,
      wake: () => {},
      host: createBoardScriptHost({
        host: element,
        readModule,
        export: true,
        shaders: options.shaders ?? true,
        snapshots: options.snapshots,
        timeoutMs: 15_000,
        capabilities: {
          ...Object.fromEntries(Object.entries(BOARD_SCRIPT_EXPORT_CALLS).map(([name, call]) => [name, async (_id: string, input: unknown) => call(input)])),
          "board.emit": async (id, input) => {
            if (!started.document) return;
            const { target, event } = boardScriptEmit(started.document, id, input);
            last.set(id, `emit(${target}, "${event.type}")`);
            started.outbox.push(id, target, event);
          },
        },
        onFrame: () => started.wake(),
        onOutput(id, output) {
          if (output) outputs.set(id, output);
          else outputs.delete(id);
        },
      }),
    };
    return started;
  }

  function stop() {
    if (!run) return;
    run.wake = () => {};
    run.host.destroy();
    run.element.remove();
    run = null;
  }

  function settle(current: Run, document: BoardDocument, time: number, view?: BoardScriptView): Promise<void> {
    current.time = time;
    current.document = document;
    const { host } = current;
    const scene = buildBoardScene(document);
    const ids = boardScriptAttachments(document).map(({ id }) => id);
    current.ranks.clear();
    for (const [index, id] of ids.entries()) current.ranks.set(id, index);
    const viewKey = view ? JSON.stringify(view) : null;
    let viewed = false;
    let rounds = 0;
    const inputs = current.inputsAt < time ? boardScriptInputsBetween(options.inputs, current.inputsAt, time) : [];
    current.inputsAt = Math.max(current.inputsAt, time);
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        current.wake = () => {};
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error(["Scripts did not settle in 20 s.", ...status(current, ids)].join(" "))), 20_000);
      let queued = false;
      const deliver = () => {
        for (const event of inputs.splice(0, BOARD_SCRIPT_EVENT_QUEUE >> 1))
          for (const id of ids) host.event(id, event);
      };
      if (ids.every((id) => host.output(id))) deliver();
      const sync = () => {
        queued = false;
        try {
          host.sync(document, scene, { x: 0, y: 0, zoom: 1 }, time, false);
          if (viewKey && !viewed) {
            viewed = true;
            for (const id of ids)
              if (current.views.get(id) !== viewKey) {
                current.views.set(id, viewKey);
                host.event(id, { type: "viewchange", data: view });
              }
          }
          for (const id of ids) {
            const error = host.error(id);
            if (error) throw new Error(error);
          }
          if (!ids.every((id) => host.settled(id))) return;
          if (inputs.length) {
            deliver();
            current.wake();
            return;
          }
          if (current.outbox.size && rounds++ <= BOARD_SCRIPT_EMIT_DEPTH) {
            for (const [target, events] of current.outbox.take()) {
              current.last.set(target, `event ${events.map((event) => event.type).join(", ")}`);
              for (const event of events) host.event(target, event);
            }
            current.wake();
            return;
          }
          current.outbox.take();
          finish();
        } catch (error) {
          finish(error);
        }
      };
      current.wake = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(sync);
      };
      current.wake();
    });
  }

  function status(current: Run, ids: readonly string[]): string[] {
    return ids.flatMap((id) => {
      if (current.host.settled(id)) return [];
      const state = current.host.output(id) ? "is still running" : "has not started";
      const last = current.last.get(id);
      return [`${id} ${state}${last ? `; last ${last}` : ""}.`];
    });
  }

  return {
    async at(document, time, view) {
      if (!Number.isFinite(time) || time < 0 || time > 600_000)
        throw new Error("Script export time must be between 0 and 600000 ms.");
      if (run && time < run.time) stop();
      const fresh = !run;
      const current = run ?? start();
      run = current;
      const { host, outputs } = current;
      if (options.documentAt) {
        let before = { at: current.time, document: options.documentAt(current.time) };
        let previous = boardScriptParamsKey(before.document);
        let ran = current.time;
        if (fresh) await settle(current, before.document, before.at);
        for (let at = current.time + BOARD_SCRIPT_HISTORY_MS; at < time; at += BOARD_SCRIPT_HISTORY_MS) {
          const sample = options.documentAt(at);
          const key = boardScriptParamsKey(sample);
          if (key !== previous) {
            if (before.at > ran) await settle(current, before.document, before.at);
            await settle(current, sample, at);
            previous = key;
            ran = at;
          }
          before = { at, document: sample };
        }
        if (boardScriptParamsKey(document) !== previous && before.at > ran) await settle(current, before.document, before.at);
      }
      await settle(current, document, time, view);
      return {
        ...host,
        shaders: (input) => boardShaderOwners(input, outputs, (id) => host.clock(id)),
        document(input) {
          const items = { ...input.items };
          for (const [id, item] of composeBoardScriptItems(input, buildBoardScene(input), outputs))
            items[id] = item;
          return { ...input, items };
        },
      };
    },
    dispose: stop,
  };
}

export async function prepareBrowserBoardScripts(
  document: BoardDocument,
  time: number,
  readModule: (path: string) => Promise<string>,
  snapshots?: Readonly<Record<string, BoardScriptSnapshot>>,
  options: { shaders?: boolean; documentAt?: (time: number) => BoardDocument; inputs?: BoardScriptInputLog } = {},
): Promise<{ host: BoardScriptHost; dispose(): void }> {
  const session = createBrowserBoardScriptExport(readModule, { snapshots, ...options });
  try {
    return { host: await session.at(document, time), dispose: session.dispose };
  } catch (error) {
    session.dispose();
    throw error;
  }
}
