# Cameras

Point, aim and drive the view camera: `Camera3D` settings, `OrbitCamera`/`FPSCamera` from `@pixi/3d/extras`, orthographic views, clipping planes and following an object.

## Quick Start

```ts
import { CubeGeometry, DirectionalLight, Material3D, Mesh3D, PlaneGeometry, Vector3, View3D } from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application, Point, Text } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: 0x1b1e26, antialias: true });
document.body.appendChild(app.canvas);

const view3d = new View3D({ autoResize: true, environment: { skyColor: 0xbcd0ea, groundColor: 0x3a3226 } });
app.stage.addChild(view3d);

// Every View3D already has a camera. It starts at the origin facing -Z: move it before anything else.
const camera = view3d.camera;
camera.fov = 50; // vertical, degrees
camera.far = 200;
camera.position.set(6, 5, 10);

const player = new Mesh3D({
  geometry: new CubeGeometry({ width: 1, height: 1, depth: 1 }),
  material: new Material3D({ baseColor: 0xff8844, roughness: 0.5 }),
});
player.position.set(6, 0.5, 0);
view3d.root.addChild(player);

// OrbitCamera keeps the camera's current offset from `target` as its starting pose.
const orbit = new OrbitCamera({
  view: view3d,
  target: player.position, // copied, not linked
  enableDamping: true,
  maxPolarAngle: Math.PI / 2 - 0.05, // never dip under the ground
  autoUpdate: false, // updated below, after the player moves, so the label never lags a frame
});

const sun = new DirectionalLight({ intensity: 2.2 });
sun.position.set(5, 10, 4);
sun.lookAt({ x: 0, y: 0, z: 0 }); // lights, like cameras, aim their local -Z
view3d.root.addChild(sun);

// PlaneGeometry lies in XY facing +Z; tip it back to make a floor.
const ground = new Mesh3D({
  geometry: new PlaneGeometry({ width: 40, height: 40 }),
  material: new Material3D({ baseColor: 0x4a5a3c, roughness: 1 }),
});
ground.rotation.x = -Math.PI / 2;
view3d.root.addChild(ground);

const label = new Text({ text: 'player', style: { fill: 0xffffff, fontSize: 14 } });
label.anchor.set(0.5, 1);
app.stage.addChild(label);

const lastPos = new Vector3().copyFrom(player.position);
const delta = new Vector3();
const head = new Vector3();
const screen = new Point();
let time = 0;

app.ticker.add((ticker) => {
  time += ticker.deltaMS / 1000;
  player.position.set(Math.cos(time * 0.5) * 6, 0.5, Math.sin(time * 0.5) * 6);

  // Follow: shift the orbit target AND the camera by how far the player moved,
  // so the user's orbit angle and distance are kept.
  player.position.subtract(lastPos, delta);
  lastPos.copyFrom(player.position);
  orbit.target.add(delta);
  camera.position.add(delta);
  orbit.update(ticker);

  // World -> screen. null means the point is behind the camera.
  const p = view3d.worldToScreen(player.toGlobal(head.set(0, 0.8, 0), head), screen);
  label.visible = p !== null;
  if (p) label.position.copyFrom(p);
});
```

## Facing, lookAt, and who owns the camera

`view3d.camera` always exists and starts at the origin. Cameras and lights face local **-Z**. Meshes and glTF models face local **+Z**. Every `Container3D` has `lookAt(worldPoint, up?)`, which aims the correct axis for its type. `fov` (vertical, in degrees), `near`, `far` and `zoom` can be set at any time and need no updateProjectionMatrix(). `new Camera3D({ fov, near, far, mode, orthographicSize })` takes the same fields. Install it with `view3d.camera = cam`, which adds it to `view3d.root` when it has no parent.

`OrbitCamera` and `FPSCamera` rewrite the camera's position and rotation on every update, which overwrites your own `lookAt` or `position.set`. `enabled = false` gates input only, and an orbit's updates keep turning the camera toward its target, so set `autoUpdate = false` as well, or call `controller.destroy()`, before driving the camera by hand. Use one controller per view. A chase camera with no controller:

```ts
const desired = new Vector3();
app.ticker.add((ticker) => {
  // Meshes face local +Z, so "behind and above" is (0, 3, -6) in the player's space.
  player.toGlobal({ x: 0, y: 3, z: -6 }, desired);
  const k = 1 - Math.exp((-4 * ticker.deltaMS) / 1000); // frame-rate independent smoothing
  camera.position.addScaledVector(desired.subtract(camera.position), k); // Vector3 has no lerp
  camera.lookAt(player.toGlobal({ x: 0, y: 1, z: 0 }));
});
```

## OrbitCamera

It takes an options object, and `view` is the only required field. The starting pose is the camera's current offset from `target` (default: the origin), so position the camera first. Every option is also a live property. `orbit.target` is a mutable `Vector3`. Moving only the target re-aims the camera and changes its distance; shift both, as the Quick Start does, to follow. Options: `target`, `enableDamping`, `dampingFactor`, `minDistance`/`maxDistance`, `minPolarAngle`/`maxPolarAngle` (radians from straight up), `minAzimuthAngle`/`maxAzimuthAngle` (active only while both are finite), `enableRotate`/`enablePan`/`enableZoom`, `rotateSpeed`/`panSpeed`/`zoomSpeed`, `autoRotate`/`autoRotateSpeed` (rpm), `zoomToCursor`, `screenSpacePanning`, `mouseButtons` (`left`/`middle`/`right`: `'rotate' | 'pan' | 'zoom' | 'none'`), `touches` (`one`/`two`), `preventContextMenu`, `up`, `autoUpdate`.

```ts
orbit.rotate(0.1, 0); // azimuth, polar (radians); works even while enabled is false
orbit.zoom(1.25); // > 1 zooms in
orbit.pan(40, 0); // View pixels
orbit.saveState(); // later: orbit.reset()
console.log(orbit.polarAngle, orbit.azimuthAngle, orbit.distance); // read-only pose
orbit.on('start', () => (view3d.cursor = 'grabbing')); // 'start'/'end' bracket a gesture
orbit.on('end', () => (view3d.cursor = 'grab'));
orbit.on('change', () => app.render()); // every update that moved the camera: render on demand
```

## Orthographic and isometric

`orthographicSize` is **half the view's width** in world units, not the height. In orthographic mode `zoom` divides it, and `OrbitCamera` zooms by changing `camera.zoom` (bounded by `minZoom`/`maxZoom`) instead of moving the camera. Perspective `zoom` narrows the field of view the same way, without moving the camera.

```ts
camera.mode = 'orthographic';
camera.orthographicSize = 12; // 24 world units across at zoom 1
camera.position.set(30, 30, 30); // the (1, 1, 1) diagonal: x, y and z show at equal length
camera.lookAt({ x: 0, y: 0, z: 0 });

// Map-style controls: no rotation, drag pans across the ground, wheel zooms
new OrbitCamera({
  view: view3d,
  enableRotate: false,
  screenSpacePanning: false,
  mouseButtons: { left: 'pan' },
  minZoom: 0.5,
  maxZoom: 4,
});
```

`camera.useOrthographic(size, near, far)` and `camera.usePerspective(fov, near, far)` switch the mode in one call. Any argument you leave out resets to the default (`5` or `60`, `0.1`, `1000`), not to the current value.

## Clipping planes and viewport

The camera draws only what lies between `near` (default `0.1`) and `far` (default `1000`). A mesh crossing a plane is cut open with no cap. Depth precision bunches up just past `near`, so raise `near` and lower `far` as far as the scene allows when distant surfaces flicker. `camera.clippingPlane` (a `Plane` in the camera's view space) adds a third cut at any angle and hides everything on the camera's side of it, which a mirror camera uses to skip what lies behind the glass; `PortalPass` sets its own (see `render-to-texture.md`). `camera.viewport.set(x, y, w, h)` (fractions of the view, default `0, 0, 1, 1`) shrinks the picture to part of the view, as for split screen.

## FPSCamera

```ts
import { FPSCamera } from '@pixi/3d/extras';

const fps = new FPSCamera({
  view: view3d,
  position: { x: 0, y: 1.7, z: 8 }, // eye height
  yaw: 0, // 0 faces -Z; positive turns left
  pitch: -0.1, // radians, clamped to ±maxPitch; positive looks up
  moveSpeed: 5, // units per second; WASD/arrows walk, Space/Shift rise and sink
  pointerLock: true, // click to capture the mouse, Esc releases; dragging looks on touch
  autoUpdate: false,
});
app.ticker.add((ticker) => {
  // Gamepad or joystick: x strafes right, y rises, z walks forward; added to the keys
  const pad = navigator.getGamepads()[0];
  if (pad) fps.move.set(pad.axes[0], 0, -pad.axes[1]);
  // Walking follows the pitch, so looking down sinks: a walker pins its eye height after each step
  if (fps.update(ticker)) fps.camera.position.y = 1.7;
});
```

`update()` returns `true` when the camera moved, which is the place for collision. `keyboard = false` drops the key listeners, for example while a text field has focus. `enabled = false` stops look and movement but does not release pointer lock. Listen for `fps.on('lock', ...)` and `fps.on('unlock', ...)` to hide and show a pause menu.

Screen and world conversions (`worldToScreen` for labels, `screenToWorld` for the pointer on a plane) are on the view: see `2d-and-3d-together.md` and `picking-and-input.md`.
