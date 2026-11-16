# Picking and Input

Click, hover and drag 3D meshes with pixi's federated events, cast rays yourself, convert between screen and world, and read the keyboard.

## Quick Start

```ts
import { CubeGeometry, DirectionalLight, Material3D, Mesh3D, Plane, PlaneGeometry } from '@pixi/3d';
import { SphereGeometry, TorusGeometry, Vector3, View3D } from '@pixi/3d';
import type { Pointer3DEvent } from '@pixi/3d';
import { Application } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: 0x10131a, antialias: true });
document.body.appendChild(app.canvas);

const view3d = new View3D({ autoResize: true, environment: { skyColor: 0x334466, groundColor: 0x1a1a14 } });
app.stage.addChild(view3d);
view3d.camera.position.set(0, 6, 10);
view3d.camera.lookAt({ x: 0, y: 0, z: 0 });

const sun = new DirectionalLight({ intensity: 2.2, castShadow: true });
sun.position.set(5, 10, 4);
sun.lookAt({ x: 0, y: 0, z: 0 });
view3d.root.addChild(sun);

// PlaneGeometry lies in XY facing +Z: rotate it flat to make a floor.
const ground = new Mesh3D({
  geometry: new PlaneGeometry({ width: 20, height: 20 }),
  material: new Material3D({ baseColor: 0x262b38, roughness: 1 }),
  receiveShadow: true,
  parent: view3d.root,
});
ground.rotation.set(-Math.PI / 2, 0, 0);

// Clickable shapes. 3D nodes default to eventMode 'passive': set 'static' or nothing picks.
const colors = [0xd96c4f, 0x4f9ed9, 0x6fbf5c];
const shapes = colors.map((color, i) => {
  const material = new Material3D({ baseColor: color, roughness: 0.5 }); // one per mesh, so highlights stay separate
  const geometry =
    i === 1 ? new SphereGeometry({ radius: 0.7 }) : new CubeGeometry({ width: 1.2, height: 1.2, depth: 1.2 });
  const mesh = new Mesh3D({ geometry, material, castShadow: true, eventMode: 'static', cursor: 'pointer' });
  mesh.position.set((i - 1) * 3, 0.7, 0);
  mesh.on('pointerover', () => (material.baseColor = 0xffffff));
  mesh.on('pointerout', () => (material.baseColor = color));
  mesh.on('pointertap', (e: Pointer3DEvent) => {
    if (e.button !== 0) return; // pointertap fires for every button, right click included
    selected = mesh;
    if (e.hit3D) console.log('hit', i, e.hit3D.point.x, e.hit3D.point.y, e.hit3D.point.z);
  });
  view3d.root.addChild(mesh);
  return mesh;
});
let selected: Mesh3D = shapes[0];

// A ring that follows the pointer across the y = 0 floor.
const floorPlane = new Plane(new Vector3(0, 1, 0), 0);
const pointerOnFloor = new Vector3();
const ring = new Mesh3D({ geometry: new TorusGeometry({ radius: 0.5, tube: 0.05 }), material: new Material3D() });
view3d.root.addChild(ring);

view3d.on('pointermove', (e) => {
  const hit = view3d.screenToWorld(e.global, floorPlane, pointerOnFloor);
  ring.visible = hit !== null;
  if (hit) ring.position.set(hit.x, 0.02, hit.z);
});

// Keyboard is plain DOM: keep a set of held keys and read it in the ticker.
const held = new Set<string>();
window.addEventListener('keydown', (e) => held.add(e.code));
window.addEventListener('keyup', (e) => held.delete(e.code));

app.ticker.add((ticker) => {
  const step = 4 * (ticker.deltaMS / 1000);
  if (held.has('ArrowLeft') || held.has('KeyA')) selected.position.x -= step;
  if (held.has('ArrowRight') || held.has('KeyD')) selected.position.x += step;
  if (held.has('ArrowUp') || held.has('KeyW')) selected.position.z -= step;
  if (held.has('ArrowDown') || held.has('KeyS')) selected.position.z += step;
});
```

Pointer events on 3D nodes are pixi's own: `on('pointertap')`, `wheel`, `contextmenu`, `onpointerenter = fn`, `cursor`, `stopPropagation()`, capture listeners. A View3D adds `hit3D` (what the ray struck), `target3D` (the picked 3D node) and `currentTarget3D` (the node whose listener is running, an ancestor of `target3D` while the event bubbles) to the event. `eventMode`, `cursor` and `hitVolume` are also `Mesh3D` constructor options. There is no keyboard system: use `window` listeners.

### Nothing picks until you set eventMode

Every 3D node defaults to `'passive'`, and the renderer's `eventMode` option does not change that. Set `'static'` (or `interactive = true`) on the nodes that need events. With nothing interactive, `view3d.raycast` always returns `null`.

A `'passive'` child under a `'static'` parent is still ray-tested, and the hit goes to the parent. So one line makes a whole loaded model clickable:

```ts
const robot = new Model3D(source);
robot.eventMode = 'static'; // its meshes need no setup; e.target3D is robot
robot.on('pointertap', (e) => console.log('robot hit at', e.hit3D?.point));
outline.eventMode = 'none'; // decoration under an interactive mesh: skipped with its children, blocks nothing
```

Use `'dynamic'` for a node that moves under a still pointer, so `pointerover` / `pointerout` fire as it passes. It re-picks the scene while the pointer rests, so keep it to the nodes that move.

### Hit shape: bounding box by default

A Mesh3D is picked against its geometry's axis-aligned bounding box, so a sphere's corners count as hits, `hit3D.normal` and `uv` are zero and `triangleIndex` is -1. Set `hitVolume` for anything better:

```ts
mesh.hitVolume = 'geometry'; // per triangle: exact silhouette, real normal, uv and triangleIndex
mesh.hitVolume = new Sphere(new Vector3(0, 0, 0), 1.5); // one cheap test, in local space
mesh.hitVolume = lowPolyGeometry; // any Geometry3D as a per-triangle stand-in for a detailed mesh
group.interactiveChildren = false; // on a static group with a hitVolume: one test for the subtree
```

A class with `boundingRadiusSq` and `raycast(localRay, out)` (`IHitVolume3D`) plugs in a shape of your own, such as a physics collider. A volume set on an ancestor clips its descendants' hits.

### Raycast without an event, and clicks on empty space

`view3d.raycast(point)` returns the closest `RaycastHit3D` or `null`; hidden nodes (`visible = false`) are skipped and don't block hits behind them: `target`, `point` (world space), `localPoint` (the struck node's space), `normal`, `uv`, `distance` (from the camera) and `triangleIndex`. An event's `hit3D` has the same shape and belongs to the event object, which pixi reuses, so copy what you keep: `lastHit.copyFrom(e.hit3D.point)`.

Its argument is a point in `event.global` space, and pixi keeps the live pointer at `app.renderer.events.pointer.global`. Pass an `out` from `createRaycastHit3D()` to pick every frame without garbage. It uses transforms from the last render:

```ts
const pointer = app.renderer.events.pointer.global;
const hover = createRaycastHit3D();
app.ticker.add(() => {
  if (view3d.raycast(pointer, hover)) ring.position.copyFrom(hover.point);
});
// Listeners on the View run after the 3D dispatch; target3D is null over empty space
view3d.on('pointerdown', (e) => {
  if (!e.target3D) deselect();
});
```

Use `view3d.on(...)`, not `view3d.onpointerdown`: the View's `on*` handlers run before the 3D dispatch and see `null` 3D fields.

### Screen to world

`screenToWorld(global, plane, out?)` intersects the pointer ray with a `Plane` and returns `null` when it misses. `screenToWorld(global, distance)` returns the point that many units from the camera, and `screenToRay(global)` returns the `Ray` itself. Build a level plane at any height from a point on it:

```ts
const tablePlane = new Plane().setFromNormalAndCoplanarPoint({ x: 0, y: 1, z: 0 }, { x: 0, y: 0.8, z: 0 });
const spot = view3d.screenToWorld(e.global, tablePlane) ?? view3d.screenToWorld(e.global, 10);
```

These and `raycast` work in the view's logical pixels, so `view3d.resolution` and the app's `resolution` never change them. For the reverse, `worldToScreen` to pin 2D labels on 3D objects, see `2d-and-3d-together.md`.

### Dragging a mesh

On press, lay a plane through the grabbed point and follow the pointer across it. Stop the press so the `OrbitCamera` on the view stays still, listen for `globalpointermove` (it arrives wherever the pointer goes), and end on both `pointerup` and `pointerupoutside`:

```ts
const dragPlane = new Plane();
const grabOffset = new Vector3();
const dragPoint = new Vector3();

function startDrag(mesh: Mesh3D, e: Pointer3DEvent): void {
  e.stopPropagation(); // the orbit camera never hears this press
  if (!e.hit3D || e.button !== 0) return;
  dragPlane.setFromNormalAndCoplanarPoint({ x: 0, y: 1, z: 0 }, e.hit3D.point); // level, at the grabbed height
  grabOffset.copyFrom(e.hit3D.point).subtract(mesh.position);
  const move = (ev: Pointer3DEvent): void => {
    // null above the horizon. The mesh's parent is view3d.root, so world and local positions match.
    if (view3d.screenToWorld(ev.global, dragPlane, dragPoint)) mesh.position.copyFrom(dragPoint.subtract(grabOffset));
  };
  const end = (): void => {
    mesh.off('globalpointermove', move);
    mesh.off('pointerup', end);
    mesh.off('pointerupoutside', end);
  };
  mesh.on('globalpointermove', move);
  mesh.on('pointerup', end);
  mesh.on('pointerupoutside', end);
}
for (const mesh of shapes) mesh.on('pointerdown', (e) => startDrag(mesh, e));
```

Without a drag handler, an orbit drag that starts and ends on one mesh still fires `pointertap`. To tell a tap from an orbit, store `e.global` on `pointerdown` and act on `pointerup` only when the pointer moved under about 6 px.
