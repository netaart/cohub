import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { BoardDocument, BoardItem, BoardSettings } from "@cohub/protocol";
import type { Texture } from "pixi.js";
import { buildBoardScene, type BoardScene, type BoardSceneItem } from "../../model/scene.js";
import { type BoardScriptAttachment, boardScriptAttachments } from "../../model/script-index.js";
import {
  boardScriptOf,
  boardScriptScope,
  composeBoardScriptItems,
} from "../../model/script-scene.js";
import { BOARD_SCRIPT_HISTORY_MS } from "../../model/animation.js";
import { BOARD_SCRIPT_EXPORT_CALLS } from "../../model/script-calls.js";
import type { BoardScriptEvent, BoardScriptOutput, BoardScriptSnapshot, BoardScriptView } from "../../model/script.js";
import { BOARD_SCRIPT_EMIT_DEPTH, boardScriptEmit, boardScriptListens, createBoardScriptOutbox, queueBoardScriptEvent } from "../../model/script-events.js";
import {
  loadBoardScriptSources,
  createBoardScriptModuleReader,
  type BoardScriptSources,
} from "../../render/script-modules.js";
import {
  createScriptRuntime,
  type ScriptRuntimeInput,
} from "../../render/script-runtime.js";
import type { BoardScriptHost } from "../../render/renderers/board-renderer-registry.js";
import { boardShaderOwners } from "../../render/shader/layers.js";
import type { BoardScriptHostCallbacks, BoardScriptRuntimeHost } from "../../render/script-host.js";
import type { BoardNodeRenderer } from "./index.js";
import { initializeBoardFonts } from "./fonts.js";

const WORKER = `
const {parentPort, workerData} = require('node:worker_threads');
const {createContext, Script, SourceTextModule, SyntheticModule} = require('node:vm');
const {createCanvas, GlobalFonts} = require(workerData.canvasModule);
(${initializeBoardFonts.toString()})(GlobalFonts, workerData.fonts);
const instances = new Map();
const graphs = new Map();
const calls = new Map();
let callId = 0;
const update = new Script('__runtime.update(JSON.parse(__inputJson)); for (const event of JSON.parse(__eventsJson)) __runtime.event(event); __runtime.step(__time)');
const draw = new Script('__runtime.draw(__drawing)');
const output = new Script('JSON.stringify(__runtime.output())');
const snapshot = new Script('JSON.stringify(__runtime.snapshot())');
const dispose = new Script('__runtime.destroy()');
function release(id) {
 const entry=instances.get(id);instances.delete(id);
 if(entry) {
  try {dispose.runInContext(entry.context,{timeout:workerData.timeout});} catch {}
  if(entry.canvas) {entry.canvas.width=1;entry.canvas.height=1;}
 }
}
async function create(data) {
 const context = createContext({console:{log(){},warn(){},error(){}},structuredClone},{codeGeneration:{strings:false,wasm:false}});
 new Script("const __name=(value,name)=>Object.defineProperty(value,'name',{value:name,configurable:true})").runInContext(context);
 const sources = graphs.get(data.src);
 if(!sources) throw new Error('Module graph is unavailable.');
 const modules = new Map();
 const resolve = (from,name) => {
  const parts=from.split('/').slice(0,-1);
  for(const part of name.split('/')) { if(part==='..') parts.pop(); else if(part!=='.') parts.push(part); }
  return parts.join('/');
 };
 const link = (name,ref) => load(resolve(ref.identifier,name));
 const json = new Script('(text)=>{const freeze=v=>{if(v&&typeof v==="object"&&!Object.isFrozen(v)){Object.freeze(v);for(const k in v)freeze(v[k]);}return v};return freeze(JSON.parse(text))}').runInContext(context);
 function load(path) {
  if(modules.has(path)) return modules.get(path);
  const source=sources[path];
  if(!source) throw new Error('Module is unavailable: '+path);
  if(path.endsWith('.json')) {
   const module=new SyntheticModule(['default'],function(){this.setExport('default',json(source.code));},{context,identifier:path});
   modules.set(path,module);return module;
  }
  const module=new SourceTextModule(source.code,{context,identifier:path,importModuleDynamically:async name=>{
   const child=load(resolve(path,name));
   if(child.status==='unlinked') await child.link(link);
   if(child.status==='linked') await child.evaluate({timeout:workerData.timeout});
   return child;
  }});
  modules.set(path,module);return module;
 }
 const root=load(data.src);
 await root.link(link);await root.evaluate({timeout:workerData.timeout});
 context.__module=root.namespace;
 context.__inputJson=JSON.stringify(data.input);
 context.__call=(name,input)=>new Promise((resolve,reject)=>{
  const call=++callId;calls.set(call,{resolve,reject});
  parentPort.postMessage({kind:'call',id:data.input.id,call,name,input:JSON.parse(JSON.stringify(input??null))});
 });
 context.__invalidate=()=>parentPort.postMessage({kind:'dirty',id:data.input.id});
 new Script('globalThis.__runtime=('+workerData.runtime+')(__module,JSON.parse(__inputJson),{call:(name,input)=>__call(name,input),invalidate:__invalidate})').runInContext(context,{timeout:workerData.timeout});
 return {context,signature:data.signature,time:-1,draw:!!root.namespace.draw,shader:!!root.namespace.shader,pixelated:root.namespace.pixelated===true,canvas:null};
}
parentPort.on('message',async data=>{
 if(data.kind==='result') {
  const pending=calls.get(data.call);calls.delete(data.call);
  if(data.error) pending?.reject(new Error(data.error)); else pending?.resolve(data.value);
  setImmediate(()=>parentPort.postMessage({kind:'settled',call:data.call}));
  return;
 }
 try {
  if(data.release) {for(const id of data.release) release(id);return;}
  if(data.snapshot) {
   const entry=instances.get(data.snapshot);
   parentPort.postMessage({kind:'sample',snapshot:entry?JSON.parse(snapshot.runInContext(entry.context,{timeout:workerData.timeout})):null});
   return;
  }
  if(data.sources) graphs.set(data.src,data.sources);
  let entry=instances.get(data.input.id);
  if(!entry || entry.signature!==data.signature || data.time<entry.time) {
   release(data.input.id);
   entry=await create(data);instances.set(data.input.id,entry);
  }
  const context=entry.context;
  context.__inputJson=JSON.stringify(data.input);context.__eventsJson=JSON.stringify(data.events??[]);context.__time=data.time;
  update.runInContext(context,{timeout:workerData.timeout});entry.time=data.time;
  await new Promise(resolve=>setImmediate(resolve));
  let png;
  if(entry.draw && data.draw!==false && !(entry.shader && data.shaders)) {
   const area=Math.max(1,data.input.width)*Math.max(1,data.input.height);
   const scale=Math.min(entry.pixelated?1:data.scale,2048/Math.max(1,data.input.width,data.input.height),Math.sqrt(2097152/area));
   const width=Math.max(1,Math.round(data.input.width*scale));
   const height=Math.max(1,Math.round(data.input.height*scale));
   const canvas=entry.canvas??=createCanvas(width,height);
   if(canvas.width!==width || canvas.height!==height) {canvas.width=width;canvas.height=height;}
   const drawing=canvas.getContext('2d');drawing.reset();drawing.scale(scale,scale);
   context.__drawing=drawing;
   try {
    draw.runInContext(context,{timeout:workerData.timeout});
    png=canvas.toBuffer('image/png');
   } finally {
    delete context.__drawing;canvas.width=1;canvas.height=1;
   }
  }
  parentPort.postMessage({kind:'sample',png,output:JSON.parse(output.runInContext(context,{timeout:workerData.timeout}))});
 } catch(error) { release(data.input?.id);parentPort.postMessage({kind:'sample',error:String(error.stack||error)}); }
});
`;

type Sample = { png?: Uint8Array; output: BoardScriptOutput; error?: string };
type Lane = {
  worker: Worker | null;
  tail: Promise<unknown>;
  graphs: Set<string>;
  reject?: (error: Error) => void;
  running: { id: string; since: number } | null;
  waiting: number;
};

export type BoardScriptLaneStatus = {
  lane: number;
  thread: number | null;
  running: { id: string; ms: number; event?: string; call?: string } | null;
  waiting: number;
  scripts: string[];
};

export function describeBoardScriptLanes(lanes: readonly BoardScriptLaneStatus[]): string[] {
  return lanes.flatMap(({ lane, thread, running, waiting, scripts }) => {
    if (!running && !waiting) return [];
    const where = `lane ${lane}${thread === null ? "" : ` (worker thread ${thread})`}`;
    const what = running
      ? `${running.id} busy for ${(running.ms / 1000).toFixed(1)} s${running.event ? `, last event ${running.event}` : ""}${running.call ? `, last call ${running.call}` : ""}`
      : "idle";
    return [`${where}: ${what}${waiting ? `; ${waiting} more request${waiting === 1 ? "" : "s"} queued` : ""} (runs ${scripts.join(", ")})`];
  });
}

function describeCall(name: string, input: unknown): string {
  const message = input as { target?: unknown; type?: unknown } | null;
  return name === "board.emit" && message && typeof message.target === "string"
    ? `emit(${message.target}, "${String(message.type)}")`
    : name;
}
type SampleRequest = {
  input: ScriptRuntimeInput;
  graph: BoardScriptSources;
  time: number;
  scale: number;
  events?: BoardScriptEvent[];
  draw?: boolean;
  shaders?: boolean;
};

export type BoardNodeScriptOptions = {
  readModule(src: string): Promise<string>;
  concurrency?: number;
  timeoutMs?: number;
  readTimeoutMs?: number;
};

function createNodeScriptLanes(
  renderer: Pick<BoardNodeRenderer, "fonts">,
  options: BoardNodeScriptOptions & {
    call?: (id: string, name: string, input: unknown) => Promise<unknown>;
    onDirty?: (id: string) => void;
    onFault?: (id: string, message: string) => void;
  },
) {
  const calls = new Map<string, () => void>();
  const settled = new Set<Promise<void>>();
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Script concurrency must be an integer between 1 and 4.");
  const lanes: Lane[] = Array.from({ length: concurrency }, () => ({ worker: null, tail: Promise.resolve(), graphs: new Set(), running: null, waiting: 0 }));
  const activity = new Map<string, { event?: string; call?: string }>();
  const assignments = new Map<string, Lane>();
  const sources = new Map<string, Promise<BoardScriptSources>>();
  const modules = createBoardScriptModuleReader(options.readModule, options.readTimeoutMs);
  const timeout = options.timeoutMs ?? 2_000;
  let nextLane = 0;
  let disposed = false;
  function stop(lane: Lane) {
    const worker = lane.worker;
    lane.worker = null;
    lane.graphs.clear();
    if (!worker) return;
    for (const [key, resolve] of calls)
      if (key.startsWith(`${worker.threadId}:`)) {
        resolve();
        calls.delete(key);
      }
    void worker.terminate();
  }
  function laneOf(id: string): Lane {
    let lane = assignments.get(id);
    if (!lane) {
      lane = lanes[nextLane++ % lanes.length] as Lane;
      assignments.set(id, lane);
    }
    return lane;
  }
  function start(lane: Lane): Worker {
    if (lane.worker) return lane.worker;
    const worker = new Worker(WORKER, {
      eval: true,
      execArgv: ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning"],
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 128 },
      workerData: {
        runtime: createScriptRuntime.toString(),
        timeout,
        fonts: renderer.fonts ?? [],
        canvasModule: fileURLToPath(import.meta.resolve("@napi-rs/canvas")),
      },
    });
    lane.worker = worker;
    const stopped = (error: Error) => {
      if (lane.worker !== worker) return;
      if (lane.reject) lane.reject(error);
      else stop(lane);
    };
    worker.on("error", stopped);
    worker.on("exit", () => stopped(new Error("Script worker stopped.")));
    worker.on("message", (message: { kind: string; id?: string; call?: number; name?: string; input?: unknown }) => {
      const key = `${worker.threadId}:${message.call}`;
      if (message.kind === "dirty") options.onDirty?.(message.id ?? "");
      if (message.kind === "settled") {
        calls.get(key)?.();
        calls.delete(key);
      }
      if (message.kind !== "call") return;
      activity.set(message.id ?? "", { ...activity.get(message.id ?? ""), call: describeCall(message.name ?? "", message.input) });
      const answer = (value: unknown, error?: string) => {
        if (lane.worker !== worker) return;
        const done = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!calls.has(key)) return;
            options.onFault?.(message.id ?? "", "Script timed out.");
            if (lane.reject) lane.reject(new Error("Script timed out."));
            else stop(lane);
          }, timeout);
          calls.set(key, () => {
            clearTimeout(timer);
            resolve();
          });
        });
        settled.add(done);
        void done.then(() => settled.delete(done));
        worker.postMessage({ kind: "result", call: message.call, value, error });
      };
      void Promise.resolve()
        .then(() => {
          const name = message.name ?? "";
          if (options.call) return options.call(message.id ?? "", name, message.input);
          const call = BOARD_SCRIPT_EXPORT_CALLS[name];
          if (!call) throw new Error("Capabilities are unavailable during export.");
          return call(message.input);
        })
        .then((value) => answer(value), (error: unknown) => answer(undefined, error instanceof Error ? error.message : String(error)));
    });
    return worker;
  }
  function request<T>(lane: Lane, message: unknown, register?: () => void, id?: string): Promise<T> {
    lane.waiting++;
    const task = lane.tail.then(() => new Promise<T>((resolve, reject) => {
      lane.waiting--;
      if (disposed) return reject(new Error("Script host is disposed."));
      const worker = start(lane);
      if (id) lane.running = { id, since: performance.now() };
      const cleanup = () => {
        clearTimeout(timer);
        worker.off("message", reply);
        lane.reject = undefined;
        lane.running = null;
      };
      const reply = (value: { kind: string } & Sample) => {
        if (value.kind !== "sample") return;
        cleanup();
        if (value.error) reject(new Error(value.error));
        else resolve(value as T);
      };
      const timer = setTimeout(() => {
        cleanup();
        stop(lane);
        reject(new Error("Script timed out."));
      }, Math.max(timeout, 15_000));
      lane.reject = (error) => {
        cleanup();
        stop(lane);
        reject(error);
      };
      worker.on("message", reply);
      register?.();
      worker.postMessage(message);
    }));
    lane.tail = task.catch(() => undefined);
    return task;
  }
  return {
    graph(src: string): Promise<BoardScriptSources> {
      let graph = sources.get(src);
      if (!graph) {
        graph = loadBoardScriptSources(src, modules.read, options.readTimeoutMs);
        sources.set(src, graph);
      }
      return graph;
    },
    sample({ input, graph, time, scale, events, draw, shaders }: SampleRequest): Promise<Sample> {
      if (!Number.isFinite(time) || time < 0 || time > 600_000)
        return Promise.reject(new Error("Script time must be between 0 and 600000 ms."));
      const lane = laneOf(input.id);
      const src = input.script.src;
      if (events?.length) activity.set(input.id, { ...activity.get(input.id), event: events.map((event) => event.type).join(", ") });
      return request<Sample>(lane, {
        input, src, signature: JSON.stringify({ ...input.script, params: undefined }), time, scale, events, draw, shaders,
        sources: lane.graphs.has(src) ? undefined : graph,
      }, () => lane.graphs.add(src), input.id);
    },
    status(): BoardScriptLaneStatus[] {
      const now = performance.now();
      return lanes.map((lane, index) => ({
        lane: index + 1,
        thread: lane.worker?.threadId ?? null,
        running: lane.running && { id: lane.running.id, ms: now - lane.running.since, ...activity.get(lane.running.id) },
        waiting: lane.waiting,
        scripts: [...assignments].flatMap(([id, assigned]) => (assigned === lane ? [id] : [])),
      }));
    },
    async snapshot(id: string): Promise<BoardScriptSnapshot | null> {
      const lane = assignments.get(id);
      if (!lane?.worker) return null;
      return (await request<{ snapshot: BoardScriptSnapshot | null }>(lane, { snapshot: id })).snapshot;
    },
    release(id: string) {
      const lane = assignments.get(id);
      assignments.delete(id);
      activity.delete(id);
      if (lane) lane.tail = lane.tail.then(() => lane.worker?.postMessage({ release: [id] }));
    },
    assigned: () => assignments.keys(),
    async idle() {
      while (settled.size) await Promise.all(settled);
    },
    invalidate(path?: string) {
      modules.invalidate(path);
      sources.clear();
      for (const lane of lanes) lane.graphs.clear();
    },
    destroy() {
      disposed = true;
      for (const lane of lanes) {
        lane.reject?.(new Error("Script host is disposed."));
        stop(lane);
      }
      sources.clear();
      modules.destroy();
      assignments.clear();
    },
  };
}

function scopedInput(document: BoardDocument, { id, script, item }: BoardScriptAttachment, size: { width: number; height: number }): ScriptRuntimeInput {
  const items: Record<string, BoardItem> = {};
  for (const scoped of boardScriptScope(document, id)) {
    const value = document.items[scoped];
    if (value) items[scoped] = value;
  }
  return { id, script, item, items, width: size.width, height: size.height };
}

export function createNodeBoardScriptHost(
  renderer: BoardNodeRenderer,
  options: BoardNodeScriptOptions,
): BoardScriptHost & {
  prepare(
    items: readonly BoardSceneItem[],
    times: readonly number[],
    zoom: number,
    board?: Pick<BoardSettings, "scripts">,
    options?: { shaders?: boolean; history?: (time: number) => BoardDocument; view?: BoardScriptView },
  ): Promise<void>;
  clearFrames(): void;
  readonly emitFailures: ReadonlyMap<string, string>;
  status(): BoardScriptLaneStatus[];
  destroy(): void;
} {
  let current: BoardDocument | null = null;
  let ranks = new Map<string, number>();
  const outbox = createBoardScriptOutbox(() => ranks);
  const emitFailures = new Map<string, string>();
  const lanes = createNodeScriptLanes(renderer, {
    ...options,
    async call(id, name, input) {
      if (name === "board.emit" && current) {
        try {
          const { target, event } = boardScriptEmit(current, id, input);
          outbox.push(id, target, event);
        } catch (error) {
          emitFailures.set(id, error instanceof Error ? error.message : String(error));
          throw error;
        }
        return undefined;
      }
      const call = BOARD_SCRIPT_EXPORT_CALLS[name];
      if (!call) throw new Error("Capabilities are unavailable during export.");
      return call(input);
    },
  });
  const textures = new Map<string, Texture>();
  const outputs = new Map<number, Map<string, BoardScriptOutput>>();
  const errors = new Map<string, string>();
  const sampled = new Map<string, number>();
  const views = new Map<string, string>();
  const key = (id: string, time: number) => `${id}|${time}`;
  let disposed = false;
  return {
    ready: (id) => [...outputs.values()].some((at) => at.has(id)),
    frame: (item, time) => textures.get(key(item.id, time)) ?? null,
    error: (id) => errors.get(id) ?? null,
    release() {},
    emitFailures,
    status: () => lanes.status(),
    shaders: (document, time) => boardShaderOwners(document, outputs.get(time) ?? [], () => time),
    document(document, time) {
      const at = outputs.get(time);
      if (!at?.size) return document;
      const items = { ...document.items };
      for (const [id, item] of composeBoardScriptItems(document, buildBoardScene(document), at))
        items[id] = item;
      return { ...document, items };
    },
    clearFrames() {
      for (const texture of textures.values()) texture.destroy(true);
      textures.clear();
      outputs.clear();
      errors.clear();
    },
    async prepare(items, times, zoom, board, options) {
      const documentOf = (list: readonly BoardSceneItem[]) =>
        ({ board: { scripts: board?.scripts }, items: Object.fromEntries(list.map(({ id, frame: _frame, ...item }) => [id, item as BoardItem])) }) as BoardDocument;
      const document = documentOf(items);
      current = document;
      emitFailures.clear();
      const scripted = boardScriptAttachments(document);
      ranks = new Map(scripted.map(({ id }, index) => [id, index]));
      const alive = new Set(scripted.map(({ id }) => id));
      for (const id of [...lanes.assigned()])
        if (!alive.has(id)) {
          lanes.release(id);
          views.delete(id);
          sampled.delete(id);
        }
      if (!scripted.length) return;
      const frames = new Map(items.map((item) => [item.id, item.frame]));
      const viewKey = options?.view ? JSON.stringify(options.view) : null;
      type Prepared = { attachment: BoardScriptAttachment; graph: BoardScriptSources; input: ScriptRuntimeInput; width: number; height: number; scale: number };
      const prepared = new Map<string, Prepared>();
      await Promise.all(scripted.map(async (attachment) => {
        const { id, item } = attachment;
        try {
          const graph = await lanes.graph(attachment.script.src);
          const frame = frames.get(id);
          const width = item ? ("size" in item ? item.size.width : (frame?.width ?? 0)) : 0;
          const height = item ? ("size" in item ? item.size.height : (frame?.height ?? 0)) : 0;
          const scale = Math.min(4, Math.max(0.25, zoom), 2048 / Math.max(1, width, height));
          prepared.set(id, { attachment, graph, input: scopedInput(document, attachment, { width, height }), width, height, scale });
        } catch (error) {
          errors.set(id, error instanceof Error ? error.message : String(error));
        }
      }));
      const keep = async (id: string, time: number, events: BoardScriptEvent[]) => {
        const entry = prepared.get(id);
        if (!entry || errors.has(id)) return;
        const { attachment, graph, input, scale } = entry;
        try {
          const result = await lanes.sample({ input, graph, time, scale, events, draw: Boolean(attachment.item), shaders: options?.shaders });
          if (disposed) return;
          if (result.png) {
            const frameKey = key(id, time);
            textures.get(frameKey)?.destroy(true);
            const texture = (await renderer.decodeImage(result.png)) as unknown as Texture;
            if (result.output.pixelated) texture.source.scaleMode = "nearest";
            textures.set(frameKey, texture);
          }
          let at = outputs.get(time);
          if (!at) {
            at = new Map();
            outputs.set(time, at);
          }
          at.set(id, result.output);
        } catch (error) {
          errors.set(id, error instanceof Error ? error.message : String(error));
        }
      };
      for (const time of times) {
        await Promise.all([...prepared].map(async ([id, { attachment, graph, input, width, height, scale }]) => {
          try {
            const last = sampled.get(id) ?? 0;
            if (time < last) views.delete(id);
            if (options?.history) {
              const from = last <= time ? last : 0;
              const run = async (at: number, document: BoardDocument) => {
                const script = boardScriptOf(document, id);
                if (script) await lanes.sample({ input: scopedInput(document, { ...attachment, script }, { width, height }), graph, time: at, scale, draw: false, shaders: options.shaders });
              };
              let before = { at: from, document: options.history(from) };
              let previous = JSON.stringify(boardScriptOf(before.document, id)?.params);
              let ran = from;
              if (from === 0) await run(from, before.document);
              for (let at = from + BOARD_SCRIPT_HISTORY_MS; at < time; at += BOARD_SCRIPT_HISTORY_MS) {
                const sample = options.history(at);
                const key = JSON.stringify(boardScriptOf(sample, id)?.params);
                if (key !== previous) {
                  if (before.at > ran) await run(before.at, before.document);
                  await run(at, sample);
                  previous = key;
                  ran = at;
                  if (disposed) return;
                }
                before = { at, document: sample };
              }
              if (JSON.stringify(input.script.params) !== previous && before.at > ran) await run(before.at, before.document);
            }
          } catch (error) {
            errors.set(id, error instanceof Error ? error.message : String(error));
            return;
          }
          sampled.set(id, time);
          const events: BoardScriptEvent[] = [];
          const shown = viewKey && `${JSON.stringify({ ...attachment.script, params: undefined })}|${viewKey}`;
          if (shown && views.get(id) !== shown) {
            views.set(id, shown);
            events.push({ type: "viewchange", data: options?.view });
          }
          await keep(id, time, events);
        }));
        for (let round = 0; outbox.size && round <= BOARD_SCRIPT_EMIT_DEPTH && !disposed; round++) {
          const delivered = [...outbox.take()].flatMap(([id, events]) => {
            const output = outputs.get(time)?.get(id);
            const wanted = events.filter((event) => boardScriptListens(output, event));
            return wanted.length ? [keep(id, time, wanted)] : [];
          });
          await Promise.all(delivered);
        }
        outbox.take();
      }
      await lanes.idle();
    },
    destroy() {
      disposed = true;
      lanes.destroy();
      for (const texture of textures.values()) texture.destroy(true);
      textures.clear();
      outputs.clear();
    },
  };
}

type RuntimeEntry = {
  signature: string;
  input?: ScriptRuntimeInput;
  inputKey: string;
  output: BoardScriptOutput | null;
  error: string | null;
  events: BoardScriptEvent[];
  texture: Texture | null;
  startedAt: number;
  time: number;
  busy: boolean;
  dirty: boolean;
};

export function createNodeBoardScriptRuntime(
  renderer: BoardNodeRenderer,
  options: BoardNodeScriptOptions & { callbacks: BoardScriptHostCallbacks },
): BoardScriptRuntimeHost & {
  settle(): Promise<void>;
  draw(scale?: number): Promise<void>;
  readonly queued: boolean;
  status(): BoardScriptLaneStatus[];
  document(document: BoardDocument, scene?: BoardScene): BoardDocument;
} {
  const { callbacks } = options;
  const capabilities = Object.keys(callbacks.capabilities);
  const lanes = createNodeScriptLanes(renderer, {
    ...options,
    call: (id, name, input) => {
      const capability = Object.hasOwn(callbacks.capabilities, name) ? callbacks.capabilities[name] : undefined;
      if (!capability) return Promise.reject(new Error(`Capability unavailable: ${name}`));
      return capability(id, input);
    },
    onDirty(id) {
      const entry = entries.get(id);
      if (!entry) return;
      entry.dirty = true;
      callbacks.onFrame();
    },
    onFault(id, message) {
      const entry = entries.get(id);
      if (entry) fail(id, entry, message);
    },
  });
  const entries = new Map<string, RuntimeEntry>();
  const revisions = new Map<string, number>();
  let syncedAt = 0;
  const pending = new Set<Promise<unknown>>();
  let disposed = false;
  const bump = (id: string) => revisions.set(id, (revisions.get(id) ?? 0) + 1);
  function track<T>(promise: Promise<T>) {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => undefined);
  }
  function fail(id: string, entry: RuntimeEntry, error: unknown) {
    entry.error = error instanceof Error ? error.message : String(error);
    entry.output = null;
    lanes.release(id);
    bump(id);
    callbacks.onOutput(id, null);
  }
  function drop(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    entry.texture?.destroy(true);
    lanes.release(id);
    bump(id);
    if (entry.output) callbacks.onOutput(id, null);
  }
  async function step(id: string, entry: RuntimeEntry, input: ScriptRuntimeInput, time: number, scale?: number) {
    const src = input.script.src;
    try {
      const graph = await lanes.graph(src);
      const events = entry.events.splice(0);
      const result = await lanes.sample({ input, graph, time, scale: scale ?? 1, events, draw: scale !== undefined });
      if (disposed || entries.get(id) !== entry || entry.error) return;
      if (result.png) {
        entry.texture?.destroy(true);
        entry.texture = (await renderer.decodeImage(result.png)) as unknown as Texture;
        if (result.output.pixelated) entry.texture.source.scaleMode = "nearest";
      }
      bump(id);
      entry.output = result.output;
      try {
        callbacks.onOutput(id, result.output);
      } catch (error) {
        fail(id, entry, error);
      }
    } catch (error) {
      if (!disposed && entries.get(id) === entry) fail(id, entry, error);
    }
  }
  return {
    revision: (id) => revisions.get(id) ?? 0,
    ready: (id) => Boolean(entries.get(id)?.output),
    frame: (item) => entries.get(item.id)?.texture ?? null,
    error: (id) => entries.get(id)?.error ?? null,
    release() {},
    get animated() {
      for (const entry of entries.values()) if (!entry.error && (entry.events.length || entry.output?.updating || entry.output?.animated)) return true;
      return false;
    },
    clock: (id) => syncedAt - (entries.get(id)?.startedAt ?? syncedAt),
    settled: (id) => {
      const entry = entries.get(id);
      return Boolean(entry?.output && !entry.busy && !entry.dirty);
    },
    sync(document, scene, _camera, time) {
      syncedAt = time;
      const alive = new Set<string>();
      for (const attachment of boardScriptAttachments(document)) {
        const { id, script, item } = attachment;
        alive.add(id);
        const signature = JSON.stringify({ ...script, params: undefined });
        let entry = entries.get(id);
        if (entry && entry.signature !== signature) {
          drop(id);
          entry = undefined;
        }
        if (!entry) {
          entry = { signature, inputKey: "", output: null, error: null, events: [], texture: null, startedAt: time, time: -1, busy: false, dirty: false };
          entries.set(id, entry);
        }
        if (entry.error || entry.busy) continue;
        const input = { ...scopedInput(document, attachment, item ? scene.layout.box(id) : { width: 0, height: 0 }), capabilities };
        const inputKey = JSON.stringify(input);
        const changed = inputKey !== entry.inputKey;
        const waiting = changed || entry.dirty || entry.events.length > 0;
        if (!waiting && entry.output && (entry.time === time || (!entry.output.animated && !entry.output.updating))) continue;
        entry.dirty = false;
        entry.inputKey = inputKey;
        entry.input = input;
        entry.time = time;
        entry.busy = true;
        const current = entry;
        track(step(id, entry, input, time - entry.startedAt).finally(() => {
          current.busy = false;
          if (current.events.length || current.dirty) callbacks.onFrame();
        }));
      }
      for (const id of [...entries.keys()]) if (!alive.has(id)) drop(id);
    },
    async draw(scale = 1) {
      for (const [id, entry] of entries)
        if (entry.input && entry.output && !entry.error && !entry.busy)
          track(step(id, entry, entry.input, entry.time - entry.startedAt, scale));
      await this.settle();
    },
    event(id, event) {
      const entry = entries.get(id);
      if (!entry || entry.error || !boardScriptListens(entry.output, event)) return true;
      if (!queueBoardScriptEvent(entry.events, event)) return false;
      callbacks.onFrame();
      return true;
    },
    status: () => lanes.status(),
    output: (id) => entries.get(id)?.output ?? null,
    snapshot: (id) => lanes.snapshot(id),
    restore() {
      throw new Error("Snapshots cannot be restored into the Node runtime.");
    },
    fault(id, message) {
      const entry = entries.get(id);
      if (entry) fail(id, entry, message);
    },
    restart: drop,
    invalidate(path) {
      lanes.invalidate(path);
      for (const id of [...entries.keys()]) drop(id);
    },
    async settle() {
      while (pending.size) {
        await Promise.allSettled([...pending]);
        await lanes.idle();
      }
      await lanes.idle();
    },
    get queued() {
      for (const entry of entries.values()) if ((entry.events.length || entry.dirty) && !entry.error) return true;
      return false;
    },
    document(document, scene = buildBoardScene(document)) {
      const outputs = new Map<string, BoardScriptOutput>();
      for (const [id, entry] of entries) if (entry.output) outputs.set(id, entry.output);
      if (!outputs.size) return document;
      const items = { ...document.items };
      for (const [id, item] of composeBoardScriptItems(document, scene, outputs, new Map(), { zoom: 1 })) items[id] = item;
      return { ...document, items };
    },
    destroy() {
      disposed = true;
      lanes.destroy();
      for (const entry of entries.values()) entry.texture?.destroy(true);
      entries.clear();
    },
  };
}
