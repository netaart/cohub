---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": patch
---

Board models render with PixiJS 3D in the Board's own canvas. A `.glb`, `.gltf` or `.stl` card shows a still; entering it (its key, double-click or Enter) turns the model in place: drag to orbit, scroll or pinch to zoom, double-click to return, Escape to leave. Models with `autoplay` play their first animation live. `@neta-art/cohub/board/render` exports `loadModelEngine` (`loadModel`, `renderModelStill`, `mountModelViewer`), `boardModelSource` and `setModelDecoders`. OBJ is no longer previewed. The SDK now needs `pixi.js` 8.23 and takes `@pixi/3d` 0.1.0 as an optional peer, loaded only once a model shows.
