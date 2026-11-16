# Render to texture

Draw a second camera's view, a live 2D PixiJS container, or a portal onto a 3D surface.

## Quick Start

A fixed security camera filming spinning cubes, shown on a monitor quad. Orbit with the mouse.

```ts
import {
  Camera3D,
  CubeGeometry,
  DirectionalLight,
  FlatMaterial,
  Material3D,
  Mesh3D,
  MeshPass,
  PlaneGeometry,
  View3D,
} from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application, RenderTexture } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: 0x0d1117, antialias: true });
document.body.appendChild(app.canvas);

const view3d = new View3D({ autoResize: true, environment: { skyColor: 0x9fb8d8, groundColor: 0x2b2418 } });
app.stage.addChild(view3d);

const sun = new DirectionalLight({ intensity: 3 });
sun.rotation.set(-0.9, 0.6, 0);
view3d.root.addChild(sun);

// PlaneGeometry lies in XY facing +Z: turn it flat to make a floor.
const ground = new Mesh3D({
  geometry: new PlaneGeometry({ width: 12, height: 12 }),
  material: new Material3D({ baseColor: 0x4a5560, roughness: 0.8 }),
});
ground.rotation.set(-Math.PI / 2, 0, 0);
view3d.root.addChild(ground);

const cubes: Mesh3D[] = [];
for (const [x, color] of [
  [-2, 0xd2544b],
  [0, 0x4fae5b],
  [2, 0x4a76d2],
] as const) {
  const cube = new Mesh3D({ geometry: new CubeGeometry(), material: new Material3D({ baseColor: color }) });
  cube.position.set(x, 0.5, 0);
  view3d.root.addChild(cube);
  cubes.push(cube);
}

// The feed. Without `antialias` the camera draws it with jagged edges, whatever the canvas has.
const feed = RenderTexture.create({ width: 512, height: 288, antialias: true });

// A second camera with a renderTexture draws into it, not the screen. Add it to the scene.
const feedCamera = new Camera3D({ fov: 50, near: 0.1, far: 50, renderTexture: feed });
feedCamera.position.set(4, 4, 5);
feedCamera.lookAt({ x: 0, y: 0.5, z: 0 });
view3d.root.addChild(feedCamera);

// Only passes that name the camera draw it; one without `camera` repeats the view's own pass and throws
// ("used twice"). These run before the main scene draws.
view3d.passes = [
  new MeshPass({ name: 'opaque', camera: feedCamera }),
  new MeshPass({ name: 'transparent', camera: feedCamera, sort: 'distance' }),
];

// The monitor: unlit and unfogged, so it shows the picture as the camera drew it.
// flipV because a RenderTexture is stored top-down like an image.
const screen = new Mesh3D({
  geometry: new PlaneGeometry({ width: 3.2, height: 1.8, flipV: true }),
  material: new FlatMaterial({ baseColorTexture: feed, fog: false }),
});
screen.position.set(0, 2.2, -3);
view3d.root.addChild(screen);

view3d.camera.position.set(0, 2.5, 7);
new OrbitCamera({ view: view3d, enableDamping: true });

app.ticker.add((ticker) => {
  for (const cube of cubes) cube.rotation.y += ticker.deltaMS * 0.001;
});
```

How it works: a `Camera3D` given `renderTexture` draws only in passes that name it via `camera`. The view runs those passes before its own scene, so the screen that samples `feed` sees this frame's picture. The projection takes the texture's aspect ratio. Resize the texture (`feed.resize(w, h)`) and the camera follows next frame.

- Without `view3d.passes` naming the camera, the texture stays empty. Use `'opaque'` plus `'transparent'` (with `sort: 'distance'`) to film everything the main camera sees. A pass's `enabled` turns that camera off; the texture keeps its last picture.
- Cameras and lights face local -Z (meshes +Z). `lookAt({ x, y, z })` on any `Container3D` aims the right axis, so use it instead of hand-computed Euler angles.
- The view's own camera (`view3d.camera`) always draws the view. Giving it a `renderTexture` throws.
- A monitor the feed camera can see shows last frame's picture of itself: it recurses one frame late. That's expected.
- The feed is stored top-down like an image. On a `PlaneGeometry` use `flipV: true`. On other geometry flip the material's UVs (`Matrix` from `pixi.js`):

```ts
const material = new FlatMaterial({ baseColorTexture: feed, uvTransform: new Matrix(1, 0, 0, -1, 0, 1) });
```

Use `FlatMaterial` (unlit) for screens: under the default `toneMapping: 'none'` it shows the feed as drawn. A lit `Material3D` relights the picture and reads as a painting.

## Feeds in a view with bloom or other effects

An 8-bit feed (the default format) holds a finished picture with the view's tone curve applied, which is right for a 2D `Sprite`. Shown on a mesh under a filmic curve (`'aces'`), that picture goes through the curve again and looks washed out. When the view has a `'beforeToneMapping'` effect (`BloomEffect`, `SsaoEffect`, `TiltShiftEffect`, `MotionBlurEffect`), the documented fix is `format: 'rgba16float'`, which holds linear light, and `PortalMaterial` is built for it. On a `FlatMaterial` monitor a float feed currently draws much darker than the scene (measured 176/41/13 against 214/145/70), so compare the screen with the scene by eye, or show the feed through a 2D `Sprite`.

```ts
const feed = RenderTexture.create({ width: 512, height: 288, antialias: true, format: 'rgba16float' });
```

## Showing the feed in 2D

A camera feed is a regular pixi `RenderTexture`, so a 2D `Sprite` can show it directly, for example a picture-in-picture over the 3D view. Add the sprite after the `View3D` so it draws on top. Create the texture with `dynamic: true` if you resize it, so the sprite follows the new size.

```ts
const pip = new Sprite({ texture: feed, eventMode: 'static' }); // eventMode: a drag on it doesn't orbit
pip.position.set(16, 16);
pip.scale.set(0.5);
app.stage.addChild(pip);
```

## A live 2D container on a 3D surface

`ContainerTexture` (from `@pixi/3d`) renders a pixi `Container` (Graphics, Text, Sprites, whole UIs) into a texture any material can use. The container moves out of its current parent, so it no longer draws on the stage.

```ts
const panel = new Container();
const score = new Text({ text: '0', style: { fill: 0xffffff, fontSize: 96 } });
panel.addChild(new Graphics().roundRect(0, 0, 512, 256, 32).fill(0x1f6feb), score);

// With `renderer` it renders once now, and render() needs no argument later.
const label = new ContainerTexture({
  container: panel,
  width: 512,
  height: 256,
  resolution: 2,
  renderer: app.renderer,
});
const sign = new Mesh3D({
  geometry: new PlaneGeometry({ width: 2, height: 1 }),
  material: new FlatMaterial({ baseColorTexture: label, fog: false }),
});

app.ticker.add(() => {
  score.text = `${Math.floor(performance.now() / 1000)}`;
  label.render(); // before the frame draws, so the mesh shows this frame's picture
});
```

- Nothing redraws it for you: call `render()` in the ticker after each change, or every tick for animation. `autoUpdate: true` renders from `Ticker.shared`, which a default `Application` doesn't draw from, so it shows the previous frame's capture.
- Each render clears to transparent. The default `alphaMode: 'opaque'` ignores alpha, so empty parts draw black with hard edges next to them. Fill the container with a backdrop, pass `clearColor: 'black'`, or use `alphaMode: 'blend'` to see through.
- Give `width` and `height` for a fixed window from (0, 0); without them it measures the container's bounds once at construction. `resolution: 2` gives sharper text.
- It is stored upright for 3D geometry: no `flipV` on the plane. On a 2D `Sprite` or a `Sprite3D` it shows upside down; set `sprite.scale.y = -1` on the 2D sprite.
- Scroll or zoom the capture with `label.transform = new Matrix().translate(-scrollX, 0)`, then render again.

## Portals

`PortalPass` and `PortalMaterial` come from `@pixi/3d/extras`. The pass renders the far side from a camera mirrored through the pair into a texture. The material samples that texture at each fragment's screen position, so the opening parallaxes like a real doorway.

```ts
const feed = RenderTexture.create({
  width: app.screen.width,
  height: app.screen.height,
  resolution: app.renderer.resolution,
});
app.renderer.on('resize', () => feed.resize(app.screen.width, app.screen.height, app.renderer.resolution));

const door = new PlaneGeometry({ width: 3, height: 4 });
const entry = new Mesh3D({ geometry: door, material: new PortalMaterial({ texture: feed }) });
entry.position.set(0, 2, -10);
const exit = new Mesh3D({ geometry: door, material: new FlatMaterial() });
exit.position.set(60, 2, -6);
view3d.root.addChild(entry, exit);

view3d.passes = [new PortalPass({ entry, exit, texture: feed })];
```

- Size the feed to the view and keep it resized, or the far side stretches and blurs.
- Both quads are plain `PlaneGeometry`, front +Z, no rotation needed. The entry's +Z faces the viewer. The exit's +Z faces into the room it shows. The exit itself is clipped away, so any material works on it.
- The feed draws scene geometry and no sky: enclose the far room.
- `PortalMaterial` is unlit and single-sided: the portal is invisible from behind. With a `'beforeToneMapping'` effect on the view, give the feed `format: 'rgba16float'`.
