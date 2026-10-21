# Board scripts

Attach a module to an existing item to add behavior. Create a `custom` item when the
module supplies the content. Both use the same `script` field and runtime.

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

Author modules and attach them through the Agent, CLI or SDK. The web editor only
shows a compact script indicator and runtime controls. **Interact** routes input
to scripts, **Pause** stops the host clock, and **Reset** starts fresh instances.
Editing retains normal selection and transform gestures. Viewers enter interaction
mode automatically. The indicator's tooltip shows the selected script path or error.

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

Every attachment has its own module realm and state. `onFrame()` uses a 60 Hz fixed
step; drawing follows the display schedule. The live clock pauses with the stage
and bounds catch-up after a stalled tab. Use `ctx.random()` for seeded randomness.
Native timers, wall-clock time and `Math.random()` are not replayable.

`present()` replaces this instance's current patch for the target, merging that
patch onto the author/animation values. Passing `null` clears it. It never saves.
Display order is author values, animation, script effects, then the user's active
editing gesture. Keep separate properties under separate owners when composing
scripts. Current document order determines competing script overrides.

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

`scene()` replaces a temporary scene using regular Board item definitions. IDs are
local to the instance, and local parent and arrow references are remapped by the
host. Only frames contain children. Temporary items cannot attach more scripts,
be selected by the editor, enter clipboard subtrees, or become document changes
implicitly. Each instance is limited to 1000 temporary items and 1000 hit regions.

World-space scenes inherit the target's transform. Screen-space scenes anchor at
the target's local origin while preserving screen size; they are interaction UI
and are excluded from image export. An instance can choose one scene space.

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
input. In **Interact**, ordinary cards remain editable outside declared targets.
Labels create keyboard focus targets from the same declarations; there is no
implicit focus target for the owner. Event `target` is the declaration's key.

Events include `pointerenter`, `pointerleave`, `pointerdown`,
`pointermove`, `pointerup`, `pointercancel`, `click`, `focus`, `blur`, `keydown`,
and `keyup`. Pointer events carry `point` in the script owner's local coordinates
(including events from anchored screen controls), pointer identity and modifiers;
keyboard events carry `key`. Captured drags continue receiving pointer input.
Disabling interaction or removing a captured hit declaration cancels that script
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

Selection events contain only IDs in the script scope. Transform events contain
`ids`, `operation` (`move`, `resize`, `rotate`, `arrow`) and `cancelled`; only local
pointer gestures produce them, not remote writes or animation. Cancellation
restores the editor draft. Subscriptions receive an initial selection/view and
then changes. View and selection updates coalesce while a worker is busy. There
is no per-frame geometry request or whole-Board broadcast. Removing the last
subscriber removes the transform listener.

`ctx.view` is null until a view event arrives; Node exports have no interactive
view or user events. The embedding stage may provide a `safeRect` callback to
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

`get(id)` reads author values in scope. Custom events are local to the viewer.
Missing references grant no access. Duplicating items remaps references when the
referenced item is included in the copy. Copy, cut and duplicate exclude local script
presentation effects and temporary items, including effects on parent transforms
and arrow targets; animation editing keeps its existing copy behavior.

Persist through an explicit, user-triggered commit:

```js
ctx.on("click", async () => {
  await ctx.commit({ items: { [ctx.self.id]: { opacity: 0.5 } } });
});
```

Commits use the normal Board write and undo path, are subject to write permission,
and can only modify existing scoped items or create children of scoped frames.
They cannot attach scripts, change existing item types, or reparent existing items.
Other clients receive document changes; hover, simulation state and temporary
scenes stay local. Read-only viewers have no `board.commit` capability.

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
the drawing and native scene from those values.

The runtime and browser host expose snapshot/restore interfaces. `await stage.snapshotScripts()`
captures state on demand; frame messages do not stream complete state. Complete interaction
recording, shared simulation sessions and historical source pinning are separate
follow-up work. Source files are resolved from their current
Space contents. Export times are limited to ten minutes, textures to a 2048 px edge,
and concurrent Node samples to four workers.

Node samples use bounded worker threads and VM contexts. They execute Space code
locally; VM contexts are not an OS security boundary. A Board uses one opaque
sandboxed iframe to host its ordinary script workers. Each instance keeps its own
worker so a timeout terminates only that instance. User code never runs in the
broker iframe. Offscreen Canvas content stops rasterizing;
behavior continues so visibility does not change simulation results. Large scenes
should coordinate related elements with a Frame script instead of attaching an
independent runtime to every primitive.

Boards with no enabled scripts skip the script runtime entirely. Native animation,
input and export do not prepare script effects. Attaching the first script starts
the host; disabling or removing the last one disposes it and its temporary output.
