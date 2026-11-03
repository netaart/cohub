# Board scripts

Attach a module to an existing item to add behavior. Create a `custom` item when the
module supplies the content, or attach it to the Board itself under `board.scripts`.
All use the same `script` field and runtime.

```json
{
  "items": {
    "figure": {
      "type": "image",
      "props": { "src": "assets/figure.png" },
      "script": { "src": "scripts/motion.js", "params": { "speed": 40 } }
    },
    "chart": {
      "type": "custom",
      "size": { "width": 480, "height": 320 },
      "script": { "src": "scripts/chart.js" }
    }
  }
}
```

Author modules and attach them through the Agent, CLI or SDK. Scripts always run
and take input, in the editor as for viewers; there is no separate interaction mode.
Selecting a scripted item adds **Interactive settings** to its toolbar: controls for
the module's declared `parameters` (saved to `script.params`), the run status or
error, the source file, and **Restart**, which starts that instance fresh.

CLI and SDK use the ordinary Board patch API. To create a complete drawing example
in the current Space workspace:

```sh
mkdir -p scripts
cohub boards examples custom --module > scripts/wave.js
cohub boards examples custom > custom.json
cohub boards create demo.board -i custom.json
```

Attach a module to an existing item:

```sh
cohub boards schema script
cohub boards apply demo.board '{"items":{"figure":{"script":{"src":"scripts/motion.js","params":{"speed":40}}}}}' --dry-run
cohub boards apply demo.board '{"items":{"figure":{"script":{"src":"scripts/motion.js","params":{"speed":40}}}}}'
```

Modules are `.js` or `.mjs` Space files. Static imports, re-exports and literal dynamic
imports can reference relative modules. Cycles, bare packages, remote imports,
`import.meta` and computed import paths are rejected. Bundle external packages into
Space modules first. A graph is limited to 64 modules and 2 MB of source.

## Draw without setup

```js
export const animated = true;

export const parameters = {
  amplitude: { type: "number", label: "Amplitude", default: 40, min: 0, max: 120 }
};

export function draw(ctx, { t, width, height, params }) {
  ctx.strokeStyle = "#e67845";
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let x = 0; x <= width; x += 2) {
    const y = height / 2 + Math.sin(x / 40 - t / 800) * params.amplitude;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
```

`draw()` is synchronous and gets a Canvas 2D context in item-local units. Its frame
contains `t`, `dt`, `width`, `height`, `seed`, `params`, and `state`. Times use
milliseconds. Static drawings need no `animated` export; they redraw when their
input changes or the instance calls `invalidate()`.

Two exports tune drawing. `frameRate` (1–60) limits how often the instance updates
and redraws; `onFrame()` still advances in 60 Hz steps, so motion stays replayable.
`pixelated: true` draws one canvas pixel per board unit and scales without
smoothing, so pixel art stays crisp at any zoom at a fraction of the cost:

```js
export const frameRate = 12;
export const pixelated = true;
```

`draw()` only renders current state: it may be skipped, repeated, or executed at a
different pixel density. Advance state in frame or event handlers. Use the frame's
`width` and `height` for logical dimensions; `ctx.canvas.width` and `height` are
backing pixels and vary with rendering quality.

Keep drawing inside `width` × `height`. Node script workers use the renderer's
registered fonts; prefer `Geist` or `Geist Mono` for consistent Canvas text. Native
text items remain editable and measurable by `boards inspect`; text and shapes
painted inside a Canvas are not inspected. When combining them, set explicit `z`
values (for example, custom graphics `0`, native labels `10`).

## Add behavior

```js
export default function (ctx) {
  ctx.state.paused ??= false;
  ctx.hitRegions({ owner: { target: "self", label: "Toggle motion" } });
  ctx.on("click", () => { ctx.state.paused = !ctx.state.paused; });
  ctx.onFrame(({ t }) => {
    if (ctx.state.paused) return;
    ctx.self.present({
      position: {
        x: ctx.self.base.position.x + Math.sin(t / 1000) * 80,
        y: ctx.self.base.position.y
      }
    });
  });
}
```

Every attachment has its own module instances and state. `onFrame()` handlers are
synchronous 60 Hz fixed steps; drawing follows the display schedule. The live clock
pauses with the stage and bounds catch-up after a stalled tab. Use `ctx.random()` for seeded randomness.
Native timers, wall-clock time and `Math.random()` are not replayable.

`present()` replaces this instance's current patch for the target, merging that
patch onto the author/animation values. Passing `null` clears it. It never saves.
It accepts `position`, `size`, `rotation`, `scale`, `opacity`, `style`, `props` and
`z`; presenting `z` restacks siblings, e.g. to sort characters by depth. A negative
`scale.x` mirrors. Display order is author values, animation, script effects, then
the user's active editing gesture. Keep separate properties under separate owners
when composing scripts. Current document order determines competing script overrides.

Items can leave a scope at any time: another viewer deletes them, a drag moves them
out of the Frame, an undo removes them. Their presentation is dropped silently;
`ctx.items` and `change` events tell the script. Selection and dragging follow what
is shown: dragging a presented item saves the drag onto its authored value, so
derive presented positions from `ctx.self.base` (or `ctx.items`) for edits to stick.

## Compose temporary content

```js
export default function (ctx) {
  const show = () => {
    ctx.scene({
    action: {
      type: "shape",
      position: { x: 0, y: -44 },
      size: { width: 120, height: 32 },
      props: { text: "Reset" }
    }
    }, { space: "screen" });
    ctx.hitRegions({
      owner: { target: "self", label: "Show controls" },
      action: { item: "action", label: "Reset" }
    });
  };
  ctx.hitRegions({ owner: { target: "self", label: "Show controls" } });
  ctx.on("pointerenter", show);
  ctx.on("focus", show);
  ctx.on("click", ({ target }) => {
    if (target === "action") {
      ctx.self.present(null);
      ctx.scene({});
      ctx.hitRegions({ owner: { target: "self", label: "Show controls" } });
    }
  });
}
```

`scene()` replaces one layer of temporary items using regular Board item
definitions. IDs are local to the instance and unique across its layers; local
parent and arrow references are remapped by the host. Items without `z` stack in
declaration order. Only frames contain children. Temporary items cannot attach
scripts, be selected by the editor, enter clipboard subtrees, or become document
changes implicitly. Each instance is limited to 1000 temporary items and 1000 hit
regions, and a scene to 1 MB.

The world layer (the default) inherits the owner's transform. The screen layer,
`scene(items, { space: "screen" })`, keeps screen-pixel size above every document
item; it is interaction UI and is excluded from image export. Both layers coexist,
e.g. dust in the world and a toolbar on screen.

Menus, tooltips, controllers and characters are ordinary module code. The platform
has no menu or action-list protocol. Use native items and hit regions for controls.
For custom Canvas hotspots:

```js
ctx.hitRegions({
  reset: { x: 12, y: 12, width: 80, height: 32, label: "Reset" }
});
```

`hitRegions()` replaces the instance's input declarations. Use `{ target: "self" }`
for the owner, `{ item: "local-id" }` for a temporary scene item, or a local
rectangle for a Canvas hotspot. Rectangles should lie inside the owner's bounds.
Only declared targets receive script input; attaching a script to a Frame never
captures ordinary descendants. Undeclared temporary decoration is transparent to
input, and ordinary cards remain editable outside declared targets. `{ target:
"self" }` covers the whole box; declare rectangles to cover only the visible parts.

In the editor, a region whose script listens only for `click` takes taps, while a
drag that starts on it moves the item. A region listening for `pointerdown`,
`pointermove` or `pointerup` takes the whole gesture. Holding Shift, Alt, Ctrl or
⌘, or pressing a selection handle, always goes to the editor. Keyboard events reach
a script after a press on one of its regions.

Regions take presses from the select tool and taps from the hand tool (the default
on phones). `tools` opts a region into others, e.g. a canvas you paint into with
the pen; read-only viewers reach every region:

```js
ctx.hitRegions({ canvas: { target: "self", tools: ["select", "hand", "draw"] } });
```

A region normally yields to items drawn over it; `over: true` takes presses there too,
such as a deck the drawn cards sit on.

Labels create keyboard focus targets from the same declarations; there is no
implicit focus target for the owner. Event `target` is the declaration's key.

Events include `pointerenter`, `pointerleave`, `pointerdown`,
`pointermove`, `pointerup`, `pointercancel`, `click`, `focus`, `blur`, `keydown`,
and `keyup`. Pointer events carry `point` in the script owner's local coordinates
(including events from anchored screen controls), pointer identity and modifiers;
keyboard events carry `key`. Captured drags continue receiving pointer input.
Pausing scripts or removing a captured hit declaration cancels that script
drag without transferring its remaining input to the editor.

## Observe the host

Subscribe through the same `ctx.on()` API. These events do not capture input:

```js
ctx.on("selectionchange", ({ data }) => {
  ctx.state.selected = data.ids;
});
ctx.on("transformend", ({ data }) => {
  if (!data.cancelled) ctx.state.lastMoved = data.ids;
});
ctx.on("viewchange", ({ data: view }) => {
  // The payload is typed; ctx.view also holds this latest snapshot.
  const { camera, width, height, safeRect } = view;
});
```

Built-in host event payloads are inferred from the event name in TypeScript;
custom event payloads remain `unknown`. View dimensions, camera translation and
safe rectangles use screen pixels; document coordinates remain world units.

Selection events contain the IDs in the script scope and `total`, the size of the
whole selection, so per-item controls can step aside for a multi-selection.
Transform events contain `ids`, `operation` (`move`, `resize`, `rotate`, `arrow`)
and `cancelled`; only local pointer gestures produce them, not remote writes or
animation. Cancellation restores the editor draft. Subscriptions receive an initial
selection/view and then changes. View and selection updates coalesce while a
worker is busy. There is no per-frame geometry request or whole-Board broadcast.

`ctx.items` holds every item in scope as authored. `change` reports what changed
in it, grouped by who changed it: `user` (this viewer), `script` (a script commit)
or `remote` (another client). Duplicates made with ⌘D, strokes drawn into a Frame
and collaborators' edits all arrive this way. React with commits to `user` changes
only: the client that made a `remote` change already handled it, and answering it
again would save twice.

```js
ctx.on("change", ({ data: { added, changed, removed, source } }) => { /* … */ });
```

`gesture` observes this viewer's drawing tools over the owner without taking their
input: `tool` (`draw`, `shape`, `frame`, `arrow`), `phase` (`start`, `update`,
`end`, `cancel`), `points` in owner coordinates, and on `end` the `item` it created
when that item is in scope. Draw a circle with the pen over a Frame and its script
can turn the stroke into something alive:

```js
ctx.on("gesture", ({ data }) => {
  if (data.tool !== "draw" || data.phase !== "end" || !data.item) return;
  ctx.commit({ items: {
    [data.item]: null,
    [`sheep-${data.id}`]: { type: "custom", parent: ctx.self.id, script: { src: "scripts/sheep.js" } },
  } });
});
```

`ctx.view` is null until a view event arrives. Exports and `boards profile` send the
area they draw: the animation camera for camera exports, otherwise the region at the
output's pixels, so code that switches passes by zoom or view draws there as it does
live. They have no user events. The embedding stage may provide a `safeRect` callback to
exclude its chrome, then call `stage.invalidate()` when that area changes. Without
an override, the safe rectangle is the stage surface. Neither view state nor
selection enters the document, history, or shared playback.

## Anchor screen UI

Screen scenes default to the owner's origin. An explicit anchor follows another
scoped document item, including parent transforms and editing gestures:

```js
ctx.scene({
  hint: { type: "text", position: { x: 12, y: 0 }, props: { text: "Ready" } }
}, {
  space: "screen",
  anchor: { item: ctx.targets.card, point: { x: 1, y: 0 } }
});
```

The anchor point uses normalized local box coordinates (0–1); scene positions
remain screen-pixel offsets. Missing anchors hide the scene, and references
outside scope are rejected. Screen UI stays excluded from image export. The SDK's
`placeBoardOverlay({ anchor, size, safeRect, placements?, gap? })` is a pure helper
for choosing a side and clamping position. It returns `position`, `placement`, and
`availableSize`; it never changes the camera or resizes content automatically.


## Coordinate items and save deliberately

Frame scripts can read and present their descendants. Explicit references expand
the scope without granting access to the whole Board:

```json
{"script":{"src":"scripts/controller.js","targets":{"label":"caption"}}}
```

```js
ctx.present(ctx.targets.label, { props: { text: "Ready" } });
await ctx.emit(ctx.targets.label, "refresh", { value: 42 });
```

`get(id)` reads author values in scope. `emit` also reaches any Board script by its
key, so a Frame can hand a cast or a hit to a script drawing over the whole view.
Custom events are local to the viewer. Exports deliver them too, in the same host and
in document order, and finish handling them before time moves on, so a hand-off shows in
the exported frame.

A handler may answer an emitted event with emits of its own, back to the sender
included. Each such answer counts one deeper; past 16 in a row the `emit` rejects and
says so, rather than letting two scripts that keep answering each other stall the
Board. Emit from `onFrame()` to send on the next step instead. An instance holds at most
128 waiting events; an emit to a full queue rejects as well. `boards simulate` lists
rejected emits under `warnings`.
Missing references grant no access. Duplicating items remaps references when the
referenced item is included in the copy. Copy, cut and duplicate exclude local script
presentation effects and temporary items, including effects on parent transforms
and arrow targets; animation editing keeps its existing copy behavior.

Persist with `commit()`:

```js
ctx.on("click", async () => {
  await ctx.commit({ items: { [ctx.self.id]: { opacity: 0.5 } } });
});
```

Commits can modify existing scoped items or create children of scoped frames.
They cannot change existing item types or reparent existing items. They may attach
a module that already runs in their scope, so a script can spawn living copies of
itself or its siblings but never introduce new code.

Every editor runs the scripts, so commits are routed by what caused them. A commit
made within 5 seconds of this viewer's input to the instance (a press, a key, a
drag it ended, an edit or stroke it observed, or an `emit` from a script that had such
input) saves right away on this client and enters its undo history. Any other
commit, including every commit made in an `onFrame()` step, is autonomous: one live editor writes it, outside the undo history, and the
others resolve `false`. Commits coalesce into at most ten writes a second for
input and one for autonomous work, and wait while the user is mid-gesture or
editing text. Present every frame, commit when things settle. Other
clients receive document changes; hover, simulation state and temporary scenes
stay local. Read-only viewers cannot commit.

`layoutText({ text, fontSize?, fontWeight?, font?, lineHeight?, width? })` resolves
to the size a native text item would take, for laying out controls.

## Script the whole Board

A module can also belong to the Board itself, under `board.scripts`. It reaches every
item, sees every change and draws over the whole view, so weather, lighting or a
game loop needs no frame around everything:

```json
{"board":{"scripts":{"rain":{"src":"scripts/rain.js","params":{"density":0.8}}}}}
```

Keys share the id space of items and animations, and a Board takes at most 32 of
its own scripts. A track whose `target` is the script's id animates its params, so a
storm can build through a chapter; on an item, the property is `script.params.<name>`:

```json
{"target": "rain", "property": "params.density", "keyframes": [{"at": 0, "value": 0.1}, {"at": 4000, "value": 1}]}
{"target": "swamp", "property": "script.params.depth", "keyframes": [{"at": 0, "value": 0}, {"at": 4000, "value": 1}]}
```

Removing the script needs `--cascade` to drop such tracks too. Params, whether edited
or animated, reach a running instance without restarting it. They run before item scripts, so an item's own script has the last
word on what it presents. The Board has no box, so `ctx.self.base` is null, the
frame's `width` and `height` are 0, and the module draws with `shader` passes or
`scene()` rather than `draw()`. Its world scene sits over every item; its screen
scene starts at the view's top-left unless anchored. It takes input only on its
scene items, never on `self`, and may commit new top-level items. The web app lists
these scripts under **Board appearance**, where they can be added, paused, tuned
and restarted.

Every script, whatever its scope, receives document changes incrementally: an
edit costs the worker what it changed, not the size of the Board.

## Draw on the GPU

`shader` puts WebGL 2 passes next to an item, or over the whole view for a Board
script. A module that only declares a shader is evaluated once; from then on it
runs entirely on the GPU, with no message per frame:

```js
export const animated = true;
export const parameters = { tint: { type: "color", default: "teal" } };

export const shader = {
  layer: "above",
  passes: [{ glsl: `
    #include "cohub:noise"
    vec4 effect(Fragment f) {
      float glow = fbm(f.local * 0.02 + board.time * 0.3, 4);
      return vec4(params.tint.rgb, glow * 0.6);
    }` }],
};
```

`layer` places the passes, up to 16, `above` (the default) or `below` the owner and its
contents, or makes them a `filter` that transforms the owner's pixels, which each
pass reads with `scene(uv)`. A Board script's filter transforms every item, across the
whole view. A pass may set its own `layer`, so one script can paint a background below
and bend the picture above. Passes draw one quad over the box; with `sprites: n` a
pass draws `n` instanced quads that `Sprite sprite(int id)` places, for particles,
rain or confetti without a draw call each.

A Frame's own passes follow its `props.clip`: a clipping Frame (the default) keeps
below, above and filter output inside its box, as it does its children, so rain stays
in its world; with `clip: false` sprites may fall past its edges. A filter covers the
Frame's bounding box.

A pass with a `name` can be switched from setup code; `enabled: false` starts it off.
A pass that is off costs nothing, so keep heavy effects, above all a full-view
filter, off until they show:

```js
export const shader = {
  passes: [
    { layer: "below", glsl: GROUND },
    { layer: "filter", name: "shatter", enabled: false, glsl: SHATTER },
  ],
};
export default function (ctx) {
  ctx.on("click", () => ctx.passes({ shatter: true }));
}
```

Shaders are written in GLSL ES 3.00 as functions; Cohub owns every declaration:

| Name | What it is |
|---|---|
| `vec4 effect(Fragment f)` | A pass's color, unpremultiplied. `f.uv` is 0–1 across the box or sprite, `f.local` the position in owner units (world units for a Board script), `f.color` and `f.data` come from the sprite. |
| `Sprite sprite(int id)` | Where sprite `id` goes: `position`, `size`, `rotation` (radians), `color`, `data` and `visible`, in local units. `makeSprite(position, size)` fills the rest. |
| `board` | `time` and `delta` in seconds on the script clock, `frame` (60 Hz steps), `size` (the box; the view for a Board script), `view` (the visible rectangle in local units), `resolution`, `zoom`, `seed`, `quality` and `dark`. |
| `params.*` | Number and boolean parameters as `float`, colors as `vec4` resolved for the viewer's theme. |
| `uniforms.*` | Values declared in `shader.uniforms`, such as `{ drops: "vec4[32]" }`, and set from setup code with `ctx.uniforms({ drops })`. At most 128 vectors. |
| `#include "cohub:…"` | `hash` (identical on every GPU), `noise`, `shapes` (signed distances) and `color`. |

The same source compiles for both stages; guard stage-only code with
`#ifdef COHUB_FRAGMENT`. Uniform, input and output declarations, `#version`,
`#extension`, and `while` or `do` loops are rejected; every `for` loop shares a
budget of 65536 iterations per invocation, so no shader can hang the GPU. Compile
errors name the pass and the line in your source.

### Surfaces

`surfaces: true` provides `surface(local)`: the `distance` to the nearest edge of
the Board's items (negative inside), the outward `normal` and whether the point is
`inside`. Frames, arrows, drawings, effects, text and items that blend as light
(`screen` or `add`) are left out, as is the owner. Shapes keep their outline. The
field follows animation and edits, so motion can collide with cards:

```glsl
// March a falling drop down to the first card below it.
float travelled = 0.0;
for (int i = 0; i < 40; i++) {
  float gap = surface(start + vec2(0.0, travelled)).distance;
  if (gap < 1.0 / board.zoom) break;
  travelled += gap;
}
```

`cohub boards examples rain --module` prints a complete Board script: rain over the
whole view whose drops splash and bounce off the top of every card.

### State

`state: { width, height, glsl }` keeps a texture that `vec4 simulate(Fragment f)`
advances in fixed 60 Hz steps from its previous value, `state(uv)`. Every pass reads
it too, by texture coordinate with `state(uv)` or by position with `stateAt(f.local)`:
ripples, trails, fluids, cellular automata. It covers the owner's box; a Board
script's state covers the view, like glass in front of it. Give `bounds: { x, y,
width, height }` in owner units (world units for a Board script) to pin it to an
area instead, such as puddles that stay where they fell. `precision: "byte"` stores
8 bits per channel instead of half floats.

Seeking backwards or exporting a single frame replays the steps from the start (at
most ten minutes of them) with that moment's inputs, so results are the same
everywhere; replays keep checkpoints, so a later replay with the same inputs resumes
from the nearest one. A frame sequence or video continues each frame's simulation from
the last, so when params are animated the state carries their history, as on the live
Board.

### Performance and fallbacks

Shaders render only while their owner is drawn and on screen; `board.quality`
(lower on phones, and lowered while frames fall behind what the display shows)
scales sprite counts and the resolution of full-box passes, which shade at most 1.5
device pixels per CSS pixel and scale up; reduced motion holds the clock and stops
redrawing. Programs compile in the background where the browser allows, and a
changed shader keeps drawing its previous version until the new one is ready.
Uniforms and pass switches reach the GPU without recomposing the Board, so drive
motion with them rather than presenting items every frame where you can; each item
presented with a shadow, blur or color filter draws in its own offscreen pass.
`sprite(id)` runs once per sprite per frame, not per corner, so shared work such as
tracing a drop belongs in it; trace only as far as the sprite needs. A
shader that was running when the GPU reset is paused for the rest of the session
until it is restarted. Where shaders cannot run, a module's `draw()` is its
fallback: when shaders run, `draw()` is not called, and a shader that fails to
compile reports its error rather than falling back.

The web export draws shaders like the live Board. `cohub boards export` draws in
Node and moves to a local Chrome, Chromium or Edge (headless, software WebGL when
there is no GPU) once a script draws with a shader; `--renderer canvas` stays in
Node and names the shaders it drew with `draw()` or left out, and `--renderer gpu`
always uses the browser. Set `COHUB_CHROME` to choose the browser. The browser is
shared by consecutive commands and exits after a few idle minutes, so only the first
pays for starting it and compiling shaders; `COHUB_BOARD_GPU_DAEMON=0` starts one per
command. Boards without shaders never start it.
`cohub boards simulate <board>` compiles every shader the scripts declare with that
browser before it runs the steps, and stops at once with the errors, such as a pass
that reads a uniform its shader does not declare; without a browser it checks the
source but cannot compile it. With `-o` it draws the shaders too, resumed from where
the simulated scripts stand, and warns about any it did not draw, and why.
`cohub boards profile <board>` times a frame, and what each shader owner adds to it,
and says what to change. It says whether the browser draws with software WebGL or a
GPU, measures each owner over `--rounds` (3) and reports the median and range, and
keeps within `--budget` (60 s): past it, it times fewer frames at a smaller size and
says which.

## Execution boundary and capabilities

Board modules execute in workers and can render Canvas or native scene items.
They have no DOM, browsing context or navigation API. `mount()` exports are rejected
in both browser and CLI, even if the module also exports `draw()`. Use Apps for
HTML/JavaScript content; Board does not execute arbitrary module code in an iframe.
The shared broker iframe executes only the host's fixed routing code.

Browser modules have no Space credentials or direct network access. The embedding
host can provide typed application adapters through `scriptCapabilities`:

```js
if (ctx.capabilities.has("example.lookup")) {
  const result = await ctx.capabilities.call("example.lookup", { query: "value" });
}
```

Unavailable calls reject. These are extension points, not built-in business
operations. Register listeners and frame callbacks through the context; subscriptions
return disposal functions, and `onDispose()` registers instance cleanup. An error
or timeout terminates the affected instance. Abrupt termination cannot guarantee
user cleanup callbacks.

## Export and reproducibility

Publishing a Board as an App captures script entries and their transitive relative
ESM dependencies, including literal dynamic imports and disabled attachments.
The published snapshot loads these immutable assets without accessing the source
Space. Publishing uses the runtime's module limits and import policy; unavailable
or invalid dependencies fail publication. Source changes between hashing and upload
also fail publication, so the captured graph matches the uploaded code.

Web and CLI exports share the runtime kernel, native ESM modules, seed and fixed
time steps. Sequential CLI exports reuse isolated instances in a pool of at most
four workers; seeking backwards or changing script configuration recreates the
corresponding instance. Draw-only modules sample time directly. Side-effecting host
capabilities are unavailable.
Drawing modules export synchronous `draw()`; native scene output uses existing
renderers. Failures are reported instead of silently exporting an empty result.

A timed sample exports the initial state advanced to the requested time. An untimed
web export captures the stage's managed state and presentation effects. Module-local
variables cannot be serialized: keep restorable values in `ctx.state` and derive
the drawing and native scene from those values. While script code runs, `Math.random()`
draws from the same seeded sequence as `ctx.random()`. When an animation drives script
params, a timed sample replays them as they change along the way, so a counter or a
threshold crossed by a param fires in a single-frame export as it does in a video.

The runtime and browser host expose snapshot/restore interfaces. `await stage.snapshotScripts()`
captures state on demand; frame messages do not stream complete state. Complete interaction
recording, shared simulation sessions and historical source pinning are separate
follow-up work. Source files are resolved from their current
Space contents. Export times are limited to ten minutes, textures to a 2048 px edge,
and concurrent Node samples to four workers.

Node samples use bounded worker threads and VM contexts. They execute Space code
locally; VM contexts are not an OS security boundary. A Board uses one opaque
sandboxed iframe hosting a pool of up to four workers shared by all its instances;
each instance imports its own copy of its modules, so module state stays isolated.
Instances on one worker share its global object, so the scripts of a Board form one
trust domain. Scope keeps scripts from stepping on each other by mistake; it is not a
security boundary between their authors, who can edit the Board anyway.
A worker that stops answering is replaced: the instance it was running fails and
the others on it start over. A Board runs at most 1000 instances. User
code never runs in the broker iframe. Offscreen Canvas content stops rasterizing;
behavior continues so visibility does not change simulation results.

## Test and simulate

`@neta-art/cohub/board/testing` runs a Board's scripts headlessly with the app's
editor, input routing, commit rules and runtime, on a virtual clock:

```js
import { createBoardScriptHarness } from "@neta-art/cohub/board/testing";

const board = await createBoardScriptHarness({ document, readModule });
board.tool = "draw";
await board.drag(circle, { pointerType: "pen" });
await board.advance(500);
board.document;            // commits applied, never saved
await board.render();      // PNG with screen UI
board.destroy();
```

`tap()` and `drag()` resolve to where the press landed (`down`: a script's hit region,
a selection `handle`, an `item`, or `empty` board) and what `taken` it: the script, or
what the editor did (`move`, `resize`, `rotate`, `select box`, `draw`, `pan`). Moving,
resizing and rotating save the authored item: what a script presents, such as a lift
on the selected card, never reaches the document or the undo history.
`board.emitFailures` holds rejected emits by sender, and `board.status()` what each
worker lane is running.

`cohub boards simulate <board>` does the same against a Space Board without saving,
reports changes, script errors and, per step, `presses`, and renders the result with
`-o`. `{"move": [[x, y], …]}` hovers through points with no button held, for umbrellas,
lanterns and other effects that follow the pointer. A run longer than `--timeout`
(2 minutes) stops and names the scripts still running, their worker lane, and the last
event or call each got.

Boards with no enabled scripts skip the script runtime entirely. Native animation,
input and export do not prepare script effects. Attaching the first script starts
the host; disabling or removing the last one disposes it and its temporary output.
