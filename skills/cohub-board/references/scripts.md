# Board scripts

`cohub boards schema script` is the full module API. This page covers how to use it well.

## Attach

`script: { src, params, targets, modes }` attaches a JavaScript module (a Space file) to
any item; a `custom` item is an empty box whose content the module draws.
`board.scripts.<id>` attaches one to the Board itself: it reaches every item and draws
over the whole view.

```bash
mkdir -p scripts
cohub boards examples custom --module > scripts/sparks.js
cohub boards examples custom | cohub boards apply <board> -i -
```

## Modules

- Export `draw(ctx, frame)` to paint Canvas 2D in item-local units within
  `width` × `height`, a default setup function for behavior, or both. Export
  `pixelated` and `frameRate` for pixel art.
- `parameters` declares params that people can tune in the app. Animate them with tracks on
  `script.params.<name>` for an item's script, or `params.<name>` targeting a Board
  script's id.
- `script.time` drives `frame.t` from a timeline, for a film or anything that is a
  function of time; `boards place --targets <item>` adds the track.
- Output is local: `present()` and `scene()` show temporary changes that are never saved,
  even when the user drags a presented card. Only `commit()` saves.
- Input reaches a script only through its declared `hitRegions`. `change` and `gesture`
  events observe edits and pen strokes without taking input.
- Prefer native text items for labels people read or edit; Canvas text can use `Geist`
  or `Geist Mono`. For any other font, `import hand from "./hand.woff2" with { type: "bytes" }`
  and `self.fonts.add(await new FontFace("Hand", hand).load())`. Subset fonts to the
  characters drawn: every viewer downloads them.
- Scripts run in the same browser worker live, in exports and in simulations, so code
  bundled for the browser runs as is.
- Exports replay from `onFrame`, `ctx.random()`, `ctx.state` and recorded input; timers,
  `Date.now()` and the network do not replay.

## Structure

- Design a playful Board as one world. One controller script (on the Board or one
  Frame), with regions kept as data, reads as a whole and can move cards across regions;
  a script per Frame turns into separate mini-games. Confirm the direction with the
  user before building out every region.
- One Frame script can drive all its descendants, and a commit may spawn items that run
  modules already in its scope.
- Scripts talk through `emit`: a Frame hands a cast to a Board script, which can answer.
  A chain of handlers answering each other rejects after 16 hops, so send follow-ups
  from `onFrame()`.
- Give game and director scripts `"modes": ["play", "view", "export"]` so editing stays
  still.

## Multiplayer

Every viewer runs the scripts on their own screen, so local effects stay local. When an
effect answers input, such as sparks on a click, `ctx.broadcast(type, data)` it and draw
it in an `on(type)` handler. Every viewer receives it, this one included, and `peer` names
the sender (`null` here). `peerschange` and `ctx.peers` give the other viewers' cursors.

Save with `commit()` from your own input only. A handler of another viewer's broadcast
cannot commit, and a commit after an `await` there may save twice. `examples custom`
shows both patterns.

## Device input and network

Scripts sense the viewer through `ctx.env` (mode, pointer, orientation, angle, senses)
and `browser:*` events: device motion and orientation (device axes; turn them by
`ctx.env.angle` for screen axes), gamepads, microphone samples, camera frames and
position. A source runs only while a script listens. Check `ctx.env.senses` and offer a
fallback when a source is unavailable.
`capabilities.call("navigator.vibrate" | "haptics" | "fullscreen")` answers back.

Live scripts may `fetch()` and open WebSockets; exports and simulations have no network.
Record input from the Board's Scripts panel, then replay it with `export --inputs` or a
simulate `{"inputs": "…"}` step.

## Directing the camera

`ctx.present("camera", { focus | center, zoom, shake, pitch, bearing })` directs the
camera like a camera track. Play and read-only views follow it until the viewer pans,
`--camera` exports follow it, and editing never does. `examples arena` follows a
character with a low camera.

## Board Apps

Published as an App, a Board opens in play. Every visitor gets a local copy where drags
move unlocked items and script regions take every press, saved per App version. Lock
what visitors should not move, and keep progress in the document, since `ctx.state`
starts over. Check the visitor's view with `simulate --mode play`.

## Verify with simulate

`simulate` runs the scripts through input steps without saving. It reports script
errors, broadcasts and `console` lines, and `-o` draws the result.

```bash
cohub boards simulate <board> -i steps.json --json
cohub boards simulate <board> -i steps.json --mode play --viewport 390x844 --pointer coarse --camera -o /tmp/phone.png
cohub boards simulate <board> -i steps.json --mode play --camera --at 0:6s --fps 24 -o /tmp/take.mp4
```

```json
{"steps": [{"tool": "play"}, {"tap": [320, 200]}, {"drag": [[100, 100], [300, 140]]}, {"move": [[0, 0], [200, 80]]}, {"key": "Enter"}, {"wait": "500ms"}]}
```

- `simulate -h` lists every step, including peers, broadcasts and browser input.
- With `--json`, `presses` reports where each tap and drag landed (a hit region, a
  selection handle, an item, empty board) and what took it. That catches a stroke that
  started on a caption or a drag that grabbed a resize handle.
- `--camera` draws the screen, including the scripts' HUDs and buttons (`--no-screen`
  leaves them out). `export --inputs steps.json` renders the same steps, but leaves
  screen layers out unless `--screen`.
- A run gives up after `--timeout` (2m) and names the scripts still busy.
