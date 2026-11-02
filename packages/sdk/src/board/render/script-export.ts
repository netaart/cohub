import type { BoardDocument } from "@cohub/protocol";
import { buildBoardScene } from "../model/scene.js";
import { composeBoardScriptItems } from "../model/script-scene.js";
import type {
  BoardScriptOutput,
  BoardScriptSnapshot,
} from "../model/script.js";
import { boardScriptAttachments } from "../model/script-index.js";
import { createBoardScriptHost } from "./script-host.js";
import { boardShaderOwners } from "./shader/layers.js";
import type { BoardScriptHost } from "./renderers/board-renderer-registry.js";

export async function prepareBrowserBoardScripts(
  document: BoardDocument,
  time: number,
  readModule: (path: string) => Promise<string>,
  snapshots?: Readonly<Record<string, BoardScriptSnapshot>>,
  options: { shaders?: boolean } = {},
): Promise<{ host: BoardScriptHost; dispose(): void }> {
  if (!Number.isFinite(time) || time < 0 || time > 600_000)
    throw new Error("Script export time must be between 0 and 600000 ms.");
  const element = globalThis.document.createElement("div");
  element.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none";
  globalThis.document.body.appendChild(element);
  const outputs = new Map<string, BoardScriptOutput>();
  const scene = buildBoardScene(document);
  const ids = boardScriptAttachments(document).map(({ id }) => id);
  let schedule = () => {};
  const host = createBoardScriptHost({
    host: element,
    readModule,
    export: true,
    shaders: options.shaders ?? true,
    snapshots,
    timeoutMs: 15_000,
    onFrame: () => schedule(),
    onOutput(id, output) {
      if (output) outputs.set(id, output);
      else outputs.delete(id);
    },
  });
  const dispose = () => {
    schedule = () => {};
    host.destroy();
    element.remove();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Script export preparation timed out.")),
        20_000,
      );
      let queued = false;
      const sync = () => {
        queued = false;
        try {
          host.sync(document, scene, { x: 0, y: 0, zoom: 1 }, time, false);
          for (const id of ids) {
            const error = host.error(id);
            if (error) throw new Error(error);
          }
          if (ids.every((id) => host.ready?.(id))) {
            clearTimeout(timer);
            schedule = () => {};
            resolve();
          }
        } catch (error) {
          clearTimeout(timer);
          schedule = () => {};
          reject(error);
        }
      };
      schedule = () => {
        if (!queued) {
          queued = true;
          queueMicrotask(sync);
        }
      };
      schedule();
    });
    return {
      host: {
        ...host,
        shaders: (input) => boardShaderOwners(input, outputs, () => time),
        document(input) {
          const items = { ...input.items };
          for (const [id, item] of composeBoardScriptItems(
            input,
            buildBoardScene(input),
            outputs,
          ))
            items[id] = item;
          return { ...input, items };
        },
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
