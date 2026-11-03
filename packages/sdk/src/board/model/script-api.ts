import type {
  BoardScriptContext,
  BoardScriptFrame,
  BoardScriptHostEvents,
  BoardScriptModule,
  BoardScriptSceneOptions,
  BoardScriptView,
} from "./script.js";
import { BOARD_SHADER_API } from "./shader-api.js";

/**
 * A compact reference for Board script authors, printed by `cohub boards schema script`.
 * Each group is checked against its type, so a new member fails to compile until it is described.
 */
export const BOARD_SCRIPT_API = {
  runtime: [
    "Modules are .js or .mjs Space files that import only literal relative paths (at most 64 modules, 2 MB).",
    "They run in a worker with no DOM or network. Use Apps for HTML content.",
    "Exports replay deterministically from ctx.onFrame, the frame clock, ctx.random(), Math.random() (seeded like ctx.random while script code runs) and ctx.state; timers and Date.now() do not.",
  ],
  module: {
    draw: "draw(ctx, frame): synchronous Canvas 2D drawing in item-local units.",
    animated: "true redraws every frame; otherwise draw runs when its inputs change or after invalidate().",
    frameRate: "Updates and redraws at most this many times a second (1–60); onFrame still steps at 60 Hz.",
    pixelated: "true draws one canvas pixel per board unit and scales without smoothing, for crisp pixel art.",
    parameters: "Declares params as { name: { type: number | boolean | string | color, label?, default?, min?, max?, step? } }.",
    default: "Setup function (ctx) for behavior; may return a cleanup function.",
    shader: "GPU passes drawn with the owner: { layer?, inputs?, uniforms?, state?, passes: [{ glsl, sprites?, blend? }] }. See shader.",
  } satisfies Record<keyof BoardScriptModule, string>,
  frame: {
    t: "Clock time in milliseconds.",
    dt: "Milliseconds since the previous frame.",
    width: "Item width in board units.",
    height: "Item height in board units.",
    seed: "script.seed, or the item id.",
    params: "script.params merged over parameter defaults.",
    state: "ctx.state.",
  } satisfies Record<keyof BoardScriptFrame, string>,
  context: {
    self: "The owner: id, base (its authored item) and present(patch | null).",
    params: "script.params merged over parameter defaults.",
    targets: "script.targets: names mapped to item ids.",
    items: "Every item in scope, as authored, by id; current after each change event.",
    state: "Mutable state kept across frames and restored in exports.",
    frame: "The latest frame.",
    view: "Camera, width, height and safeRect in screen pixels; null until a viewchange. Exports and profiles send the area they draw, at the output's pixels.",
    random: "random(): a seeded number in [0, 1); Math.random() draws from the same sequence.",
    on: "on(type, handler): input and host events; returns an unsubscribe function.",
    onFrame: "onFrame(handler): a synchronous 60 Hz fixed step; returns an unsubscribe function.",
    onDispose: "onDispose(handler): cleanup when the instance stops.",
    invalidate: "invalidate(): redraw a non-animated draw().",
    get: "get(id): an item in scope, as authored.",
    present: "present(id, patch | null): temporarily override position, size, rotation, scale, opacity, style, props or z of an item in scope; never saved. Items that leave the scope drop their override.",
    scene: "scene(items, options?): replace this instance's world or screen layer of temporary Board items; never saved. IDs are unique across both layers.",
    hitRegions: "hitRegions(regions): replace the input declarations.",
    emit: "emit(id, type, data?): send a custom event to another scripted item in scope, or to any Board script by its key. Exports deliver it within the same moment, in document order. A handler may answer with emits; past 16 in a row the emit rejects, so emit from onFrame() to send on the next step.",
    commit: "commit(patch): save a Board patch; resolves true once written here. Within 5 s of this viewer's input, outside onFrame steps, it saves undoably; otherwise one live editor saves it and others resolve false. It may edit items in scope, add children to a scoped frame, and attach modules already running in scope.",
    layoutText: "layoutText({ text, fontSize?, fontWeight?, font?, lineHeight?, width? }): the size a native text item would take.",
    uniforms: "uniforms(values): set the shader's declared uniforms from numbers or number arrays; kept until changed.",
    passes: "passes({ name: on }): switch named shader passes on or off; kept until changed. Turn heavy passes, such as a full-view filter, on only while they show.",
    capabilities: "has(name) and call(name, input?) for adapters the host provides.",
  } satisfies Record<keyof BoardScriptContext, string>,
  scope: "The owner, a Frame owner's descendants, and script.targets. A Board script (board.scripts) reaches every item.",
  board: "A script in board.scripts has no box: ctx.self.base is null, frame width and height are 0, and it draws with shader passes or scene(). Its world scene sits over every item; its screen scene starts at the view's top-left. It takes input only on its scene items, and may commit new top-level items.",
  shader: BOARD_SHADER_API,
  hitRegions: {
    forms: [
      "{ target: \"self\" }: the owner.",
      "{ item: id }: a scene item.",
      "{ x, y, width, height }: a rectangle in owner coordinates.",
    ],
    options: "label (also a keyboard focus target), cursor, tools: the tools whose presses it takes (default select and hand; hand only taps), and over: true to take presses even where items lie over the region, such as a deck under its cards.",
    rule: "Only declared regions receive input; everything else passes through to the Board. Event target is the region's key. Modifier keys and selection handles always go to the editor.",
  },
  sceneOptions: {
    space: "world (default) follows the owner's transform; screen keeps screen-pixel size and is left out of exports.",
    anchor: "{ item, point }: pin a screen scene to an item, point in 0–1 box coordinates.",
  } satisfies Record<keyof BoardScriptSceneOptions, string>,
  events: {
    input: "pointerenter, pointerleave, pointerdown, pointermove, pointerup, pointercancel, click, focus, blur, keydown, keyup. Pointer events carry point in owner coordinates; key events carry key.",
    host: {
      selectionchange: "data.ids: selected items in scope; data.total: all selected items.",
      transformend: "data.ids, data.operation (move | resize | rotate | arrow), data.cancelled.",
      viewchange: "data: the view; also stored in ctx.view.",
      change: "data.added, data.changed, data.removed: item ids in scope; data.source: user, script or remote.",
      gesture: "data: this viewer's draw, shape, frame or arrow gesture over the owner: id, tool, phase (start | update | end | cancel), points in owner coordinates, and on end the item it created.",
    } satisfies Record<keyof BoardScriptHostEvents, string>,
  },
  view: {
    camera: "x, y and zoom.",
    width: "Viewport width in screen pixels.",
    height: "Viewport height in screen pixels.",
    safeRect: "The viewport area not covered by editor chrome.",
  } satisfies Record<keyof BoardScriptView, string>,
} as const;
