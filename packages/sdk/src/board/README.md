# Board

How the Board code is organized, for people changing it. The document format
itself is described in [`docs/board.md`](../../../../docs/board.md); the public
API in the [SDK README](../../README.md#boards).

## Layers

Each directory is one layer and one subpath. A layer imports only the layers
below it; `tests/board/layers.test.ts` fails on anything else.

```
client   ──► replica, model                 (space.board(id), part of the root entry)
stage    ──► editor, player, render, model  (pixi.js, DOM)
export/node ──► export ──► render ──► model (pixi.js; export/node adds Node.js)
editor   ──► model                          (no framework, no pixi.js)
replica  ──► model
player   ──► model
model    ──► @cohub/protocol                (runs anywhere)
```

| Layer | Owns |
|---|---|
| `model` | Document helpers, geometry, scene, animation, item definitions and factories |
| `replica` | The local copy of a Board: pending writes, remote merge, retry |
| `editor` | Everything a user does to a Board, minus pixels |
| `player` | Playback frames and timing |
| `render` | One canvas renderer per item type |
| `stage` | The PixiJS scene, textures, input and DOM views for a live editor |
| `export` | Images of a document, given a renderer |
| `client` | HTTP and realtime transport; the only layer that knows about Spaces |

Cohub's own UI (toolbars, menus, i18n, generation, collaboration cursors) stays
in `apps/web` and talks to these layers through their public entries.

## The editor

`editor/editor.ts` assembles the editor from one module per concern, sharing an
`EditorContext` (`editor/context.ts`):

| Module | Concern |
|---|---|
| `document` | Base document → animation overlay → gesture draft → scene; commit, undo |
| `query` | Hit tests, bounds, spatial index, tree walks |
| `camera` | Viewport, zoom, focus, wheel |
| `selection` | Selection and edits applied to it |
| `creation` | New items, text editing |
| `deletion`, `copy` | Removing, duplicating, clipboard |
| `interaction` | The pointer state machine |
| `animation` | Playhead and keyframes |
| `snapshots` | Facts learned outside the document (file metadata, media sizes, task progress) |
| `remote` | Documents arriving from the server |

State lives in `state` fields grouped into channels (`STATE_CHANNELS`).
Assigning a field announces its channel; never mutate a value in place —
replace it, so views can compare by identity. Derived values use `memo` for the
same reason.

## Adding an item type

1. Define it in `model/items/builtin.ts` with `defineBoardItem`: capabilities,
   and `hitTest`/`bounds` if the frame is too coarse. Extension types
   (`vendor.kind`) need no protocol change; built-in types also need a schema
   in `@cohub/protocol` (`board-model.ts`).
2. Give it a factory in `model/items/create.ts` if the default `registry.create`
   placement is not enough.
3. Draw it: a renderer in `render/renderers/`, listed in
   `board-renderer-registry.ts`, or a DOM view passed to the stage.
4. Cover it in `tests/board/`.

Never drop or rewrite fields of an item the client does not understand: write
patches with only what changed, and treat unknown types as plain boxes.
