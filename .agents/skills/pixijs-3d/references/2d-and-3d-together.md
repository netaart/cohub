# 2D and 3D together

A `View3D` is a pixi 2D display object, so HUDs, labels, filters, masks and layout use the normal pixi 2D API around it.

## Quick Start

A full-screen 3D scene with a HUD panel on top and 2D labels that follow 3D objects.

```ts
import { CubeGeometry, DirectionalLight, Material3D, Mesh3D, Vector3, View3D } from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application, Container, Graphics, Point, Text } from 'pixi.js';

const app = new Application();
await app.init({
  resizeTo: window,
  resolution: Math.min(window.devicePixelRatio, 2), // sharp on HiDPI, capped for fill rate
  autoDensity: true, // CSS size stays = window, so app.screen and pointers use CSS pixels
  antialias: true,
  backgroundColor: 0x14161c,
});
document.body.appendChild(app.canvas);

// A View3D is a 2D display object. Added first, so everything added after draws over it.
const view3d = new View3D({ autoResize: true, environment: { skyColor: 0x8899bb, groundColor: 0x221a14 } });
app.stage.addChild(view3d);

view3d.camera.position.set(0, 3, 8);
new OrbitCamera({ view: view3d, target: { x: 0, y: 0.5, z: 0 }, enableDamping: true });

const sun = new DirectionalLight({ intensity: 2.2 });
sun.position.set(4, 8, 3);
sun.lookAt({ x: 0, y: 0, z: 0 }); // lights shine down their local -Z
view3d.root.addChild(sun);

const cubes = [0xff6c88, 0x7fe08a, 0x6cb8ff].map((color, i) => {
  const cube = new Mesh3D({
    geometry: new CubeGeometry({ width: 1, height: 1, depth: 1 }),
    material: new Material3D({ baseColor: color, roughness: 0.4 }),
  });
  cube.position.set((i - 1) * 3, 0.5, 0);
  view3d.root.addChild(cube);
  return cube;
});

// HUD: ordinary pixi objects on the stage, above the view.
const panel = new Container();
const fps = new Text({ text: 'FPS', style: { fill: 0xffffff, fontSize: 18 } });
fps.position.set(12, 9);
panel.addChild(new Graphics().roundRect(0, 0, 160, 40, 8).fill({ color: 0x000000, alpha: 0.5 }), fps);
app.stage.addChild(panel);

// One 2D label per cube, placed every frame from the cube's 3D position.
const labels = cubes.map((_, i) => {
  const label = new Text({ text: `cube ${i + 1}`, style: { fill: 0xffffff, fontSize: 14 } });
  label.anchor.set(0.5, 1);
  app.stage.addChild(label);
  return label;
});

// Lay out 2D from app.screen (CSS pixels) on every canvas resize.
const layout = (): void => {
  panel.position.set(app.screen.width - 176, 16);
};
layout();
app.renderer.on('resize', layout);

const anchor = new Vector3();
const screen = new Point();
let time = 0;

app.ticker.add((ticker) => {
  time += ticker.deltaMS / 1000;
  cubes.forEach((cube, i) => {
    cube.rotation.y = time * (0.5 + i * 0.3);
    cube.position.y = 0.6 + Math.sin(time * 2 + i) * 0.3;
    cube.toGlobal(anchor.set(0, 0.9, 0), anchor); // local point above the cube -> world space
    const p = view3d.worldToScreen(anchor, screen); // world -> stage coords; null = behind camera
    labels[i].visible = p !== null;
    if (p) labels[i].position.copyFrom(p);
  });
  fps.text = `FPS: ${Math.round(ticker.FPS)}`;
});
```

Draw order is stage order: a child added after the view draws on top of it, and one added before it draws behind it. 2D and 3D share no depth buffer, so a 2D object is never hidden behind a 3D mesh; for a picture that 3D can hide, use a `Sprite3D` (below). 3D nodes go under `view3d.root` and 2D objects go beside the view on the stage: the view takes no 2D children.

## Sizing views, insets and several views

`autoResize: true` makes the view track `app.screen` on every render, and the camera aspect follows it. Leave it off and the view keeps a fixed pixel size (default 256×256) that you position like a sprite:

```ts
const inset = new View3D({ width: 320, height: 240, anchor: 0.5 });
inset.position.set(app.screen.width - 180, app.screen.height - 140);
app.stage.addChild(inset);

inset.setSize(400, 300); // or inset.width = 400; changes the viewport, it does not scale
inset.autoResize = true; // setting width/height/setSize turns autoResize off; this turns it back on
```

Use `scale` on the view, or on a parent `Container`, to stretch it on screen without changing its render size. Each view has its own `camera`, `root`, lights and `environment`. A node has one parent, so it lives in one view; to show a model in two views, build a second `Mesh3D` or `Model3D` from the same geometry, material or source. Every view renders its whole scene each frame, so keep many small views cheap (one light, no shadows). To remove one, `orbit.destroy()` its controller, then `view.destroy({ children: true })`.

## 2D filters and masks on a view

Any pixi `Filter` or `mask` works on the view itself or on a 2D container around it, like any sprite. Filter the view itself when crisp 2D (a label or a frame) in the same container must stay sharp:

```ts
import { BlurFilter, ColorMatrixFilter, Container, Graphics } from 'pixi.js';

const card = new Container();
card.addChild(inset);
app.stage.addChild(card);

const mono = new ColorMatrixFilter();
mono.blackAndWhite(true);
inset.filters = [mono, new BlurFilter({ strength: 2 })];

// The mask goes beside the view in the same parent, so it moves with it.
const corners = new Graphics().roundRect(-200, -150, 400, 300, 24).fill(0xffffff); // the inset's rect, anchor 0.5
corners.position.copyFrom(inset.position);
card.addChild(corners);
inset.mask = corners;
```

These are 2D filters on the finished image. For 3D post-processing (bloom, SSAO, outlines), use `view3d.passes` with effects from `@pixi/3d/extras`. Empty parts of a view with no `background` are transparent, so 2D content behind it shows through. 3D glass (`transmission`) refracts that 2D too; on WebGL, init the app with `webgl: { useBackBuffer: true }` for it.

## Labels at 3D positions

`view3d.worldToScreen(point, out)` takes a **world-space** point (the space of `view3d.root`) and returns pixi global coordinates, the same space as `event.global`. It returns `null` when the point is behind the camera; hide the label then. Call it every frame in the ticker, reusing `Vector3` and `Point` scratch objects:

```ts
const worldPos = new Vector3();
const screenPos = new Point();
mesh.getGlobalPosition(worldPos); // world position of a nested node; mesh.position is local
mesh.toGlobal(offset.set(0, 1, 0), worldPos); // or a point 1 unit above it in its own space
const p = view3d.worldToScreen(worldPos, screenPos);
label.visible = p !== null;
if (p) labelLayer.toLocal(p, undefined, label.position); // only if labelLayer is moved/scaled
```

The reverse, `view3d.screenToWorld(e.global, plane)`, is in `picking-and-input.md`. Both work in CSS pixels whatever the view's or the app's `resolution`.

## Pictures in the scene: Sprite3D

A `Sprite3D` is a textured quad in the 3D scene: walls hide it, it shrinks with distance and it turns to the camera. It takes one options object, the `Mesh3D` options included:

```ts
import { Sprite3D } from '@pixi/3d';
import { Assets, Texture } from 'pixi.js';

const icon = await Assets.load<Texture>('marker.png'); // await it: a still-loading texture has no size
const marker = new Sprite3D({
  texture: icon,
  height: 0.6, // world units, width follows the image; or pixelSize (default 0.01 units per texture px)
  anchor: { x: 0.5, y: 1 }, // y runs down the image, so 1 stands its bottom edge on position
  billboardMode: 'cylindrical', // stays upright; 'spherical' (default) faces the lens, 'none' stays as placed
  tint: 0xffcc33,
  position: { x: 0, y: 1.2, z: 0 },
  parent: view3d.root,
});
```

- It makes its own unlit, double-sided `FlatMaterial` with `alphaMode: 'blend'`, and draws its colours as authored under the default `toneMapping: 'none'`. `alphaMode: 'mask'` cuts out foliage with depth writes and no sorting.
- `material: shared` shares one material across sprites, and any `texture`, `tint` or `alpha` you also pass is written into that shared material, changing every sprite that uses it.
- Pass a `position` (or `scale`/`anchor`) when you create it: a `Sprite3D` whose transform is never set currently draws 1×1 units instead of its texture size.
- `castShadow` stays off: the shadow pass doesn't turn billboards. Turn it on only with `billboardMode: 'none'`.
- **Sprite sheets batch.** Sprites batch by shader (billboard mode, blending), geometry and image _source_, not by material, so sprites showing frames of one sheet draw together, past 16 of them as one instanced draw. Animate with `sprite.texture = sheet.textures['walk-02.png']`: a frame of the same source uploads only that sprite's values. Sprites from separate images draw separately, and blended ones interleaving in depth cost close to a draw per sprite, so give each blended effect one sheet and one `billboardMode`. For tens of thousands of static sprites, use `BatchedMesh3D` slots with `PlaneGeometry.spriteQuad`.

## Pointer events, resolution and resize

- A view hit-tests its whole rectangle, so empty 3D space still targets it. A full-screen view therefore blocks clicks to 2D objects added _before_ it. Put interactive 2D above the view, limit the view with `view3d.hitArea = new Rectangle(...)`, or set `view3d.eventMode = 'none'` to let everything through (3D picking and the orbit camera stop too).
- Interactive HUD objects (`eventMode: 'static'`) above the view catch pointers first. Plain `Text` and `Graphics` don't block 3D picking.
- Only `Container`s should have children: `Graphics.addChild` and `Text.addChild` log a v8 deprecation warning. Group a panel background and its text in a `Container`.
- `resolution: Math.min(devicePixelRatio, 2)` plus `autoDensity: true` renders the 3D and the 2D sharply on HiDPI screens. `app.screen`, `worldToScreen` and `event.global` all stay in CSS pixels.
- For a heavy scene, lower only the 3D with `view3d.resolution = 1` (texels per CSS pixel, default `'inherit'`): the HUD stays sharp and no coordinate changes. A view whose resolution differs from the renderer's draws into its own texture first, and crossing between the two rebuilds the render graph, so a dynamic-resolution loop also sets `composite: true`.
- `resizeTo: window` resizes the canvas. Re-run 2D layout in `app.renderer.on('resize', layout)`; an `autoResize` view needs no code.
