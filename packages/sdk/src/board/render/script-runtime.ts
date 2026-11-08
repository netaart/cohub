import type { BoardItem, BoardScript } from "@cohub/protocol";
import type {
  BoardScriptContext,
  BoardScriptEnv,
  BoardScriptEvent,
  BoardScriptEventOf,
  BoardScriptFrame,
  BoardScriptModule,
  BoardScriptOutput,
  BoardScriptSnapshot,
  BoardScriptView,
} from "../model/script.js";

export type ScriptRuntimeInput = {
  id: string;
  script: BoardScript;
  item: BoardItem | null;
  items: Record<string, BoardItem>;
  width: number;
  height: number;
  env: BoardScriptEnv;
  capabilities?: string[];
  snapshot?: BoardScriptSnapshot;
};

export type ScriptRuntimeInputDelta = Partial<Pick<ScriptRuntimeInput, "script" | "item" | "width" | "height" | "env">> & {
  items?: Record<string, BoardItem | null>;
};

export function applyScriptInputDelta(input: ScriptRuntimeInput, delta: ScriptRuntimeInputDelta): ScriptRuntimeInput {
  const items = { ...input.items };
  for (const [id, item] of Object.entries(delta.items ?? {})) {
    if (item) items[id] = item;
    else delete items[id];
  }
  const { items: _items, ...fields } = delta;
  return { ...input, ...fields, items };
}

/** Self-contained so browser workers and Node execute exactly the same kernel. */
export function createScriptRuntime(
  module: BoardScriptModule,
  initial: ScriptRuntimeInput,
  host: {
    call(name: string, input: unknown): Promise<unknown>;
    invalidate(): void;
  },
) {
  if ("mount" in module)
    throw new Error(
      "Board scripts do not support DOM mount(). Use draw() or native scene items.",
    );
  if (module.frameRate !== undefined && !(Number.isFinite(module.frameRate) && module.frameRate >= 1 && module.frameRate <= 60))
    throw new Error("frameRate must be a number from 1 to 60.");
  if (module.pixelated !== undefined && typeof module.pixelated !== "boolean")
    throw new Error("pixelated must be a boolean.");
  if (!initial.item && module.draw)
    throw new Error("A Board script has no box to draw(); use shader passes or scene().");
  const DISPLAY = ["position", "size", "rotation", "scale", "opacity", "style", "props", "z"];
  let input = initial;
  let disposed = false;
  let stepping = false;
  let depth = 0;
  let revision = 0;
  let sceneRevision = 0;
  let randomState = 2166136261;
  for (const char of initial.script.seed ?? initial.id)
    randomState = Math.imul(randomState ^ char.charCodeAt(0), 16777619) >>> 0;
  const parameterDefaults = Object.fromEntries(
    Object.entries(module.parameters ?? {})
      .filter(([, spec]) => spec.default !== undefined)
      .map(([key, spec]) => [key, spec.default]),
  );
  let params = {
    ...parameterDefaults,
    ...initial.script.params,
  } as BoardScriptFrame["params"];
  const state = structuredClone(initial.snapshot?.state ?? {});
  if (initial.snapshot) randomState = initial.snapshot.random;
  let time = initial.snapshot?.time ?? 0;
  let started = Boolean(initial.snapshot);
  const stepMs = 1000 / 60;
  let frame: BoardScriptFrame = {
    t: time,
    dt: 0,
    width: initial.width,
    height: initial.height,
    seed: initial.script.seed ?? initial.id,
    params,
    state,
  };
  const handlers = new Map<string, Set<(event: BoardScriptEvent) => void>>();
  const frames = new Set<(frame: BoardScriptFrame) => void>();
  const cleanups: Array<() => void> = [];
  const effects = structuredClone(initial.snapshot?.effects);
  let patches: BoardScriptOutput["patches"] = effects?.patches ?? {};
  const layers: Record<"world" | "screen", Record<string, unknown>> = {
    world: effects?.world ?? {},
    screen: effects?.screen ?? {},
  };
  let anchor = effects?.anchor;
  let view: BoardScriptView | null = null;
  let hits: BoardScriptOutput["hits"] = effects?.hits ?? {};
  let uniforms: BoardScriptOutput["uniforms"] = effects?.uniforms;
  let passes: BoardScriptOutput["passes"] = effects?.passes;
  const invalidate = (scene = true) => {
    if (disposed) return;
    revision++;
    if (scene) sceneRevision++;
    host.invalidate();
  };
  const present: BoardScriptContext["present"] = (id, patch) => {
    if (patch === null) {
      if (!(id in patches)) return;
      delete patches[id];
    } else {
      if (!patch || typeof patch !== "object" || Object.keys(patch).some((key) => !DISPLAY.includes(key)))
        throw new Error(`present() only changes ${DISPLAY.join(", ")}.`);
      if (!input.items[id]) return;
      patches[id] = structuredClone(patch) as Record<string, unknown>;
    }
    invalidate();
  };
  const context: BoardScriptContext = {
    self: {
      id: initial.id,
      get base() {
        return input.item;
      },
      present: (patch) => {
        if (!input.item) throw new Error("A Board script has no item to present; present() items in scope instead.");
        present(initial.id, patch);
      },
    },
    get params() {
      return params;
    },
    get targets() {
      return input.script.targets ?? {};
    },
    async emit(target, type, data) {
      await host.call("board.emit", { target, type, data, depth: depth + 1 });
    },
    get items() {
      return input.items;
    },
    state,
    get frame() {
      return frame;
    },
    get view() { return view; },
    get env() { return input.env; },
    random() {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 4294967296;
    },
    on(type, handler) {
      let listeners = handlers.get(type);
      if (!listeners) {
        listeners = new Set();
        handlers.set(type, listeners);
      }
      const listener = (event: BoardScriptEvent) => handler(event as BoardScriptEventOf<typeof type>);
      listeners.add(listener);
      invalidate();
      return () => {
        listeners.delete(listener);
        invalidate();
      };
    },
    onFrame(handler) {
      frames.add(handler);
      invalidate();
      return () => {
        frames.delete(handler);
        invalidate();
      };
    },
    onDispose: (handler) => cleanups.push(handler),
    invalidate: () => invalidate(),
    get: (id) => input.items[id],
    present,
    scene(next, options) {
      const space = options?.space ?? "world";
      if (space !== "world" && space !== "screen") throw new Error("Scene space must be world or screen.");
      if (options?.anchor && space !== "screen") throw new Error("Only screen scenes take an anchor.");
      if (!next || typeof next !== "object") throw new Error("scene() takes a record of items.");
      const other = layers[space === "world" ? "screen" : "world"];
      for (const id of Object.keys(next))
        if (Object.hasOwn(other, id)) throw new Error(`Temporary item IDs must be unique across scenes: ${id}`);
      if (JSON.stringify(next).length > 1_000_000) throw new Error("A temporary scene exceeds 1 MB.");
      layers[space] = structuredClone(next);
      if (space === "screen") anchor = options?.anchor ? structuredClone(options.anchor) : undefined;
      invalidate();
    },
    hitRegions(next) {
      hits = structuredClone(next);
      invalidate();
    },
    uniforms(next) {
      if (!next || typeof next !== "object") throw new Error("uniforms() takes a record of numbers and number arrays.");
      const values: Record<string, number | number[]> = {};
      for (const [name, value] of Object.entries(next)) {
        const list: unknown[] = typeof value === "number" ? [value] : Array.isArray(value) ? value : [Number.NaN];
        if (!list.every((entry) => typeof entry === "number" && Number.isFinite(entry)))
          throw new Error(`Uniform ${name} must be a finite number or an array of them.`);
        values[name] = typeof value === "number" ? value : [...(list as number[])];
      }
      uniforms = { ...uniforms, ...values };
      invalidate(false);
    },
    passes(next) {
      if (!next || typeof next !== "object" || Object.values(next).some((on) => typeof on !== "boolean"))
        throw new Error("passes() takes a record of pass names and booleans.");
      if (Object.entries(next).every(([name, on]) => passes?.[name] === on)) return;
      passes = { ...passes, ...next };
      invalidate(false);
    },
    async commit(patch) {
      if (input.capabilities && !input.capabilities.includes("board.commit")) throw new Error("This viewer cannot edit the Board.");
      return (await host.call("board.commit", { patch, frame: stepping })) === true;
    },
    async layoutText(text) {
      return (await host.call("board.layoutText", text)) as { width: number; height: number };
    },
    capabilities: {
      has: (name) => (input.capabilities ?? []).includes(name),
      call: (name, value) => host.call(name, value),
    },
  };
  // Instances share a worker's globals, so Math.random follows the instance seed only while its code runs.
  const seeded = <T>(run: () => T): T => {
    const random = Math.random;
    Math.random = context.random;
    try {
      return run();
    } finally {
      Math.random = random;
    }
  };
  const setup = seeded(() => module.default?.(context));
  if (typeof setup === "function") cleanups.push(setup);
  return {
    get animated() {
      return frames.size > 0 || module.animated === true;
    },
    update(next: ScriptRuntimeInput) {
      const env = JSON.stringify(input.env) === JSON.stringify(next.env) ? null : next.env;
      input = next;
      if (env) this.event({ type: "envchange", data: env });
      for (const id of Object.keys(patches))
        if (!next.items[id]) {
          delete patches[id];
          revision++;
          sceneRevision++;
        }
      params = {
        ...parameterDefaults,
        ...next.script.params,
      } as BoardScriptFrame["params"];
    },
    step(t: number) {
      if (disposed) return;
      if (!Number.isFinite(t) || t < time - 0.001)
        throw new Error("Reset the instance before seeking backwards.");
      const update = (at: number, dt: number) => {
        frame = {
          ...frame,
          t: at,
          dt,
          width: input.width,
          height: input.height,
          params: context.params,
        };
        stepping = true;
        try {
          seeded(() => {
            for (const handler of frames) {
              const result: unknown = handler(frame);
              if (result && typeof (result as { then?: unknown }).then === "function")
                throw new Error("onFrame() handlers must be synchronous.");
            }
          });
        } finally {
          stepping = false;
        }
      };
      if (!started) {
        started = true;
        update(time, 0);
      }
      if (frames.size) {
        while (time + stepMs <= t + 0.000001) {
          time += stepMs;
          update(time, stepMs);
        }
      } else time = t;
      frame = {
        ...frame,
        t,
        dt: 0,
        width: input.width,
        height: input.height,
        params: context.params,
      };
    },
    event(event: BoardScriptEvent) {
      if (disposed) return;
      if (event.type === "viewchange") view = event.data as BoardScriptView;
      const listeners = handlers.get(event.type);
      if (!listeners?.size) return;
      const outer = depth;
      depth = event.depth ?? 0;
      try {
        seeded(() => {
          for (const handler of listeners) handler(event);
        });
      } finally {
        depth = outer;
      }
      invalidate();
    },
    draw(canvas: CanvasRenderingContext2D) {
      const result: unknown = seeded(() => module.draw?.(canvas, frame));
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("draw() must be synchronous.");
    },
    output(): BoardScriptOutput {
      return {
        parameters: module.parameters,
        patches,
        world: layers.world,
        screen: layers.screen,
        anchor,
        hits,
        shader: module.shader,
        uniforms,
        passes,
        listens: [...handlers]
          .filter(([, callbacks]) => callbacks.size)
          .map(([type]) => type),
        animated: this.animated,
        draws: typeof module.draw === "function",
        updating: frames.size > 0,
        frameRate: module.frameRate,
        pixelated: module.pixelated,
        version: revision,
        sceneVersion: sceneRevision,
      };
    },
    snapshot(includeEffects = true, clone = true): BoardScriptSnapshot {
      const snapshot = {
        state,
        time,
        random: randomState,
        effects: includeEffects ? { patches, world: layers.world, screen: layers.screen, anchor, hits, uniforms, passes } : undefined,
      };
      return clone ? structuredClone(snapshot) : snapshot;
    },
    destroy() {
      disposed = true;
      for (const cleanup of cleanups.reverse()) cleanup();
      handlers.clear();
      frames.clear();
      patches = {};
      layers.world = {};
      layers.screen = {};
      hits = {};
      uniforms = undefined;
      passes = undefined;
    },
  };
}
