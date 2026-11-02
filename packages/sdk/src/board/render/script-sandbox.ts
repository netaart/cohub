import type { BoardScriptEvent, BoardScriptModule } from "../model/script.js";
import {
  applyScriptInputDelta,
  createScriptRuntime,
  type ScriptRuntimeInput,
  type ScriptRuntimeInputDelta,
} from "./script-runtime.js";
import { scriptModuleUrls, type BoardScriptSources } from "./script-modules.js";

type Message = {
  token?: number;
  kind?: string;
  request?: number;
  input?: ScriptRuntimeInput;
  delta?: ScriptRuntimeInputDelta;
  graph?: string;
  key?: string;
  sources?: BoardScriptSources;
  t?: number;
  scale?: number;
  draw?: boolean;
  shaders?: boolean;
  events?: BoardScriptEvent[];
  call?: number;
  value?: unknown;
  error?: string;
};

function scriptAgent(
  runtimeFactory: typeof createScriptRuntime,
  applyDelta: typeof applyScriptInputDelta,
  moduleUrls: typeof scriptModuleUrls,
  load: (url: string) => Promise<BoardScriptModule>,
) {
  type Instance = {
    runtime: ReturnType<typeof createScriptRuntime> | null;
    input: ScriptRuntimeInput | null;
    module: BoardScriptModule | null;
    urls: ReturnType<typeof scriptModuleUrls> | null;
    canvas: OffscreenCanvas | null;
    outputVersion: number;
  };
  const graphs = new Map<string, BoardScriptSources>();
  const instances = new Map<number, Instance>();
  const calls = new Map<number, { token: number; resolve(value: unknown): void; reject(error: Error): void }>();
  let callId = 0;
  let current: number | null = null;
  // Only this agent talks to the broker: modules lose postMessage and dispatched messages are
  // ignored. This keeps scripts from tripping over each other; it is not a security boundary.
  const post = (self as unknown as Worker).postMessage.bind(self);
  for (let scope: object | null = self; scope; scope = Object.getPrototypeOf(scope))
    if (Object.hasOwn(scope, "postMessage")) delete (scope as { postMessage?: unknown }).postMessage;
  const send = (data: unknown, transfer: Transferable[] = []) => post(data, transfer);
  let announced = false;
  const settle = () => {
    if (!announced) return;
    announced = false;
    send({ kind: "idle" });
  };
  const describe = (error: unknown) =>
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  function destroy(token: number) {
    const instance = instances.get(token);
    instances.delete(token);
    try {
      instance?.runtime?.destroy();
    } finally {
      instance?.urls?.dispose();
    }
  }
  async function process(token: number, data: Message) {
    settle();
    let instance = instances.get(token);
    if (!instance) {
      instance = { runtime: null, input: null, module: null, urls: null, canvas: null, outputVersion: -1 };
      instances.set(token, instance);
    }
    current = token;
    try {
      if (data.input) instance.input = data.input;
      else if (data.delta && instance.input) instance.input = applyDelta(instance.input, data.delta);
      const input = instance.input;
      if (!input) throw new Error("Missing script input.");
      if (!instance.runtime) {
        const sources = data.graph ? graphs.get(data.graph) : undefined;
        if (!sources) throw new Error("Missing script modules.");
        instance.urls = moduleUrls(sources);
        const src = input.script.src;
        const url = src ? instance.urls.urls[src] : undefined;
        if (!url) throw new Error("Missing entry module.");
        instance.module = await load(url);
        if (instances.get(token) !== instance) throw new Error("Script stopped.");
        current = token;
        instance.runtime = runtimeFactory(instance.module, input, {
          call: (name, value) =>
            new Promise<unknown>((resolve, reject) => {
              const id = ++callId;
              calls.set(id, { token, resolve, reject });
              send({ token, kind: "call", call: id, name, input: value });
            }),
          invalidate: () => {
            if (current !== token) send({ token, kind: "dirty" });
          },
        });
      }
      const runtime = instance.runtime;
      if (data.input || data.delta) runtime.update(input);
      for (const event of data.events ?? []) runtime.event(event);
      runtime.step(data.t ?? 0);
      let bitmap: ImageBitmap | undefined;
      if (instance.module?.draw && data.draw !== false && !(data.shaders && instance.module.shader)) {
        const scale = data.scale ?? 1;
        const width = Math.max(1, Math.round(input.width * scale));
        const height = Math.max(1, Math.round(input.height * scale));
        instance.canvas ??= new OffscreenCanvas(width, height);
        const canvas = instance.canvas;
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D is unavailable.");
        context.reset();
        context.scale(scale, scale);
        runtime.draw(context as unknown as CanvasRenderingContext2D);
        bitmap = canvas.transferToImageBitmap();
      }
      const output = runtime.output();
      const changed = output.version !== instance.outputVersion;
      instance.outputVersion = output.version;
      send(
        { token, kind: "frame", request: data.request, output: changed ? output : undefined, bitmap },
        bitmap ? [bitmap] : [],
      );
    } catch (error) {
      destroy(token);
      send({ token, kind: "error", request: data.request, error: describe(error) });
    } finally {
      current = null;
    }
  }
  const queue: Array<[number, Message]> = [];
  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const [token, data] = queue.shift() as [number, Message];
      await process(token, data);
    }
    draining = false;
  }
  self.addEventListener("message", (event: MessageEvent<Message>) => {
    if (!event.isTrusted) return;
    const data = event.data;
    if (data.kind === "graph" && data.key && data.sources) {
      graphs.set(data.key, data.sources);
      return;
    }
    if (data.kind === "graph.release" && data.key) {
      graphs.delete(data.key);
      return;
    }
    if (data.kind === "result" && data.call !== undefined) {
      const pending = calls.get(data.call);
      calls.delete(data.call);
      if (!pending) return;
      announced = true;
      send({ token: pending.token, kind: "busy" });
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.value);
      setTimeout(settle);
      return;
    }
    const token = data.token;
    if (token === undefined) return;
    if (data.kind === "terminate" || data.kind === "dispose") {
      for (let index = queue.length - 1; index >= 0; index--)
        if (queue[index]?.[0] === token) {
          send({ token, kind: "error", request: queue[index]?.[1].request, error: "Script stopped." });
          queue.splice(index, 1);
        }
    }
    if (data.kind === "terminate") {
      destroy(token);
      return;
    }
    if (data.kind === "dispose") {
      try {
        destroy(token);
      } finally {
        send({ token, kind: "disposed" });
      }
      return;
    }
    if (data.kind === "snapshot") {
      try {
        const runtime = instances.get(token)?.runtime;
        for (const pending of data.events ?? []) runtime?.event(pending);
        send({ token, kind: "snapshot", snapshot: runtime?.snapshot(true, false) ?? null });
      } catch (error) {
        send({ token, kind: "snapshot", error: String(error) });
      }
      return;
    }
    queue.push([token, data]);
    void drain();
  });
  self.addEventListener("unhandledrejection", (event) => {
    console.error("Board script:", (event as PromiseRejectionEvent).reason);
  });
}

function scriptBroker(workerUrl: string, poolSize: number, timeoutMs: number) {
  type Slot = { worker: Worker; tokens: Set<number>; graphs: Set<string>; owed: number[]; seen: number; busy: number | null };
  const slots: Slot[] = [];
  const owners = new Map<number, Slot>();
  const graphs = new Map<string, unknown>();
  const toParent = (data: unknown, transfer: Transferable[] = []) => parent.postMessage(data, "*", transfer);
  function retire(slot: Slot, culprit: number | undefined) {
    slot.worker.terminate();
    slots.splice(slots.indexOf(slot), 1);
    for (const token of slot.tokens) {
      owners.delete(token);
      toParent(token === culprit
        ? { token, kind: "error", error: "Script execution timed out." }
        : { token, kind: "crashed" });
    }
  }
  function spawn(): Slot {
    const slot: Slot = { worker: new Worker(workerUrl), tokens: new Set(), graphs: new Set(), owed: [], seen: performance.now(), busy: null };
    slot.worker.onmessage = (event) => {
      const data = event.data;
      slot.seen = performance.now();
      if (data.kind === "busy" || data.kind === "idle") {
        slot.busy = data.kind === "busy" ? data.token : null;
        return;
      }
      if (data.kind === "frame" || data.kind === "error" || data.kind === "snapshot" || data.kind === "disposed") {
        const index = slot.owed.indexOf(data.token);
        if (index >= 0) slot.owed.splice(index, 1);
      }
      if (!slot.tokens.has(data.token)) {
        data.bitmap?.close();
        return;
      }
      if (data.kind === "disposed") {
        slot.tokens.delete(data.token);
        owners.delete(data.token);
      }
      toParent(data, data.bitmap ? [data.bitmap] : []);
    };
    slot.worker.onerror = (event) => console.error("Board script:", event.message);
    slots.push(slot);
    return slot;
  }
  function assign(token: number): Slot {
    const slot = slots.length < poolSize ? spawn() : slots.reduce((a, b) => (b.tokens.size < a.tokens.size ? b : a));
    slot.tokens.add(token);
    owners.set(token, slot);
    return slot;
  }
  setInterval(() => {
    const now = performance.now();
    for (const slot of [...slots])
      if ((slot.owed.length || slot.busy !== null) && now - slot.seen > timeoutMs) retire(slot, slot.busy ?? slot.owed[0]);
  }, Math.min(250, timeoutMs / 4));
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const { token, data } = event.data ?? {};
    if (!data) return;
    if (data.kind === "graph") {
      graphs.set(data.key, data.sources);
      return;
    }
    if (data.kind === "graph.release") {
      graphs.delete(data.key);
      for (const slot of slots)
        if (slot.graphs.delete(data.key)) slot.worker.postMessage(data);
      return;
    }
    if (typeof token !== "number") return;
    if (data.kind === "terminate") {
      const slot = owners.get(token);
      if (!slot) return;
      slot.tokens.delete(token);
      owners.delete(token);
      slot.worker.postMessage({ token, kind: "terminate" });
      return;
    }
    const slot = owners.get(token) ?? (data.request !== undefined ? assign(token) : null);
    if (!slot) return;
    if (data.graph && !slot.graphs.has(data.graph)) {
      const sources = graphs.get(data.graph);
      if (sources) {
        slot.worker.postMessage({ kind: "graph", key: data.graph, sources });
        slot.graphs.add(data.graph);
      }
    }
    if (data.request !== undefined || data.kind === "snapshot" || data.kind === "dispose") {
      if (!slot.owed.length) slot.seen = performance.now();
      slot.owed.push(token);
    }
    slot.worker.postMessage({ ...data, token });
  });
  toParent({ kind: "ready" });
}

export function boardScriptFrameSource(options: { timeoutMs?: number; poolSize?: number } = {}): string {
  const prelude =
    "const __name = (value, name) => Object.defineProperty(value, 'name', { value: name, configurable: true });";
  const worker = `${prelude} (${scriptAgent.toString()})(${createScriptRuntime.toString()}, ${applyScriptInputDelta.toString()}, ${scriptModuleUrls.toString()}, url => import(url));`;
  const cores = typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency || 4;
  const poolSize = options.poolSize ?? Math.max(1, Math.min(4, cores - 1));
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><script>
${prelude}
(${scriptBroker.toString()})(URL.createObjectURL(new Blob([${JSON.stringify(worker)}], {type:'text/javascript'})), ${poolSize}, ${options.timeoutMs ?? 2_000});
</script>`;
}
