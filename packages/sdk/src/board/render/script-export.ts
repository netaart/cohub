import type { BoardDocument } from "@cohub/protocol";
import { buildBoardScene } from "../model/scene.js";
import { composeBoardScriptItems } from "../model/script-scene.js";
import type {
  BoardScriptOutput,
  BoardScriptSnapshot,
} from "../model/script.js";
import { boardScriptAttachments } from "../model/script-index.js";
import { type BrowserBoardScriptHost, createBoardScriptHost } from "./script-host.js";
import { boardShaderOwners } from "./shader/layers.js";
import type { BoardScriptHost } from "./renderers/board-renderer-registry.js";

export type BrowserBoardScriptExport = {
  at(document: BoardDocument, time: number): Promise<BoardScriptHost>;
  dispose(): void;
};

type Run = {
  host: BrowserBoardScriptHost;
  element: HTMLElement;
  outputs: Map<string, BoardScriptOutput>;
  time: number;
  wake(): void;
};

export function createBrowserBoardScriptExport(
  readModule: (path: string) => Promise<string>,
  options: { snapshots?: Readonly<Record<string, BoardScriptSnapshot>>; shaders?: boolean } = {},
): BrowserBoardScriptExport {
  let run: Run | null = null;

  function start(): Run {
    const element = globalThis.document.createElement("div");
    element.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
    globalThis.document.body.appendChild(element);
    const outputs = new Map<string, BoardScriptOutput>();
    const started: Run = {
      element,
      outputs,
      time: 0,
      wake: () => {},
      host: createBoardScriptHost({
        host: element,
        readModule,
        export: true,
        shaders: options.shaders ?? true,
        snapshots: options.snapshots,
        timeoutMs: 15_000,
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

  return {
    async at(document, time) {
      if (!Number.isFinite(time) || time < 0 || time > 600_000)
        throw new Error("Script export time must be between 0 and 600000 ms.");
      if (run && time < run.time) stop();
      const current = run ?? start();
      run = current;
      current.time = time;
      const { host, outputs } = current;
      const scene = buildBoardScene(document);
      const ids = boardScriptAttachments(document).map(({ id }) => id);
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timer);
          current.wake = () => {};
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => finish(new Error("Script export preparation timed out.")), 20_000);
        let queued = false;
        const sync = () => {
          queued = false;
          try {
            host.sync(document, scene, { x: 0, y: 0, zoom: 1 }, time, false);
            for (const id of ids) {
              const error = host.error(id);
              if (error) throw new Error(error);
            }
            if (ids.every((id) => host.settled(id))) finish();
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
  options: { shaders?: boolean } = {},
): Promise<{ host: BoardScriptHost; dispose(): void }> {
  const session = createBrowserBoardScriptExport(readModule, { snapshots, ...options });
  try {
    return { host: await session.at(document, time), dispose: session.dispose };
  } catch (error) {
    session.dispose();
    throw error;
  }
}
