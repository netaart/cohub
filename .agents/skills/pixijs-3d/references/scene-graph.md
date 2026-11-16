# Scene Graph

Build, move, find and tear down nodes: `Container3D` hierarchy, `position`/`rotation`/`angle`/`quaternion`/`scale`/`origin`, `lookAt`, local versus world space, bounds and size, visibility, scene events, `destroy` and `unload`. `Mesh3D`, `Model3D`, `Camera3D`, lights and `Sprite3D` are all `Container3D`s, so everything here applies to them.

## Quick Start

A tank drives a loop, its turret tracks a drone, and crates it touches ride along. Complete src/main.ts for a Vite + TypeScript app.

```ts
import { Container3D, CubeGeometry, CylinderGeometry, DirectionalLight, Material3D, Mesh3D } from '@pixi/3d';
import { PlaneGeometry, SphereGeometry, Vector3, View3D } from '@pixi/3d';
import { Application, Point, Text } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: 0x9cc3e6, antialias: true });
document.body.appendChild(app.canvas);

const view = new View3D({
  autoResize: true,
  environment: { skyColor: 0xcfe0f5, groundColor: 0x5a5040, intensity: 0.7 },
});
app.stage.addChild(view);
view.camera.position.set(0, 11, 13);
view.camera.lookAt({ x: 0, y: 0, z: 0 });
new DirectionalLight({ intensity: 3, castShadow: true, angle: { x: -60, y: 35, z: 0 }, parent: view.root });

// Level content gets its own node: view.root also holds the camera, so never clear or hide root itself.
const world = new Container3D({ label: 'world', parent: view.root });
const paint = (color: number) => new Material3D({ baseColor: color, roughness: 0.7 });
const floor = new PlaneGeometry({ width: 24, height: 24 });
// angle is degrees; rotation is the same turn in radians.
new Mesh3D({
  geometry: floor,
  material: paint(0x7f8f6a),
  angle: { x: -90, y: 0, z: 0 },
  castShadow: false,
  parent: world,
});

// One node per moving part. A child's position and rotation are in its parent's space.
const tank = new Container3D({ label: 'tank', parent: world });
const hull = new CubeGeometry({ width: 1.6, height: 0.6, depth: 2.2 });
new Mesh3D({ label: 'hull', geometry: hull, material: paint(0x4f6d3a), y: 0.3, parent: tank });
const turret = new Container3D({ label: 'turret', y: 0.85, parent: tank });
new Mesh3D({ geometry: new SphereGeometry({ radius: 0.45 }), material: paint(0x5f8046), parent: turret });
// Cylinders run along +Y: turn the barrel 90° about X so it points down the turret's +Z, its forward.
const barrel = new CylinderGeometry({ radiusTop: 0.08, radiusBottom: 0.1, height: 1.2 });
new Mesh3D({ geometry: barrel, material: paint(0x2f3b28), angle: { x: 90, y: 0, z: 0 }, z: 0.7, parent: turret });

const drone = new Mesh3D({ geometry: new SphereGeometry({ radius: 0.3 }), material: paint(0xe04a3a), parent: world });

const crateGeometry = new CubeGeometry({ width: 0.6, height: 0.6, depth: 0.6 });
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2;
  const position = { x: Math.cos(a) * 7, y: 0.3, z: Math.sin(a) * 7 };
  new Mesh3D({ label: `crate-${i}`, geometry: crateGeometry, material: paint(0xc08a4a), position, parent: world });
}
const crates = world.getChildrenByLabel(/^crate-/); // direct children; pass `true` to search deeper

// Measured in the tank's own space, before any crate rides on it.
const labelAnchor = { x: 0, y: tank.getLocalBounds().max.y + 0.4, z: 0 };
let carried = 0;
tank.on('childAdded', () => carried++);

const hud = new Text({ text: '', style: { fill: 0xffffff, fontSize: 18, stroke: { color: 0x000000, width: 4 } } });
hud.anchor.set(0.5, 1);
app.stage.addChild(hud);

// Scratch objects: getGlobalPosition and toGlobal allocate a new Vector3 unless given an `out`.
const ahead = new Vector3();
const tankPos = new Vector3();
const cratePos = new Vector3();
const dronePos = new Vector3();
const labelPos = new Vector3();
const screen = new Point();
let time = 0;

app.ticker.add((ticker) => {
  time += ticker.deltaMS / 1000;
  const a = time * 0.5;
  tank.position.set(Math.cos(a) * 6, 0, Math.sin(a) * 6);
  // lookAt aims a node's +Z (a camera's or light's -Z) at a world point, and writes `quaternion`.
  tank.lookAt(ahead.set(Math.cos(a + 0.1) * 6, 0, Math.sin(a + 0.1) * 6));

  drone.position.set(Math.sin(time * 0.7) * 3, 2.5 + Math.sin(time * 2) * 0.5, Math.cos(time * 0.5) * 2);
  // lookAt reads the parent's current world transform, so the turret tracks while the tank turns under it.
  turret.lookAt(drone.getGlobalPosition(dronePos));

  // Compare positions in one space: world. A crate's `position` is relative to whichever node holds it.
  tank.getGlobalPosition(tankPos);
  for (const crate of crates) {
    if (crate.parent === tank) continue;
    // reparentChild keeps the world pose, so the crate rides along where it touched; addChild would jump it.
    if (crate.getGlobalPosition(cratePos).distanceTo(tankPos) < 1.4) tank.reparentChild(crate);
  }

  const p = view.worldToScreen(tank.toGlobal(labelAnchor, labelPos), screen);
  hud.visible = p !== null; // null: behind the camera
  if (p) hud.position.copyFrom(p);
  hud.text = `tank: ${carried} crates`;
});
```

## Rules that run without errors

- **Spaces.** `position`, `rotation`, `quaternion` and `scale` are local, relative to the parent. World space is the space of `view.root`. Convert with `toGlobal`, `toLocal` and `getGlobalPosition`; a child of `view.root`, or of an untransformed group like `world` above, has a world `position`.
- **One rotation in use.** A node keeps `rotation` (Euler radians, XYZ order) and `quaternion` side by side, unsynced, and turns by whichever was written last. `lookAt`, `reparentChild` and the glTF loader write `quaternion`, so on those nodes `rotation` still reads its old value (0 on a loaded node), and `node.rotation.y += 0.1` throws the real turn away. Turn them through `quaternion` (below).
- Writing a value the field already holds is a no-op, even to switch back: after `lookAt`, `node.rotation.y = 0` does nothing when it already read 0. Assign the whole object (`node.rotation = { x: 0, y: 0, z: 0 }`) to make `rotation` the turn in use again.
- `angle` is a live degree view of `rotation` (`node.angle.y = 90` is `node.rotation.y = Math.PI / 2`). Camera `fov` is degrees too; `rotation` and `Quaternion` methods take radians.
- Assigning `node.position = p`, `node.scale = 2` or passing `position: other.position` copies values; nothing stays linked. Read-outs are live objects: `const start = node.position` changes as the node moves, so copy what you keep with `new Vector3().copyFrom(node.position)` (`node.position.clone()` keeps the node as its observer, so writing to that copy marks the node dirty).
- `ObservableVector3` math writes into itself unless given an `out`: `a.position.subtract(b.position)` moves `a`. Use `a.position.subtract(b.position, delta)`.
- **Timing.** Transform writes only mark the node; the view computes world matrices once per frame, before drawing. `toGlobal`, `toLocal`, `getGlobalPosition`, `getGlobalTransform` and `lookAt` walk the parent chain themselves, so they're current mid-frame. `worldTransform` (and those calls with their last argument, `skipUpdate`, set to `true`) is the last render's, and is not updated at all while the node or an ancestor is hidden.

## Transforms

```ts
node.position.set(0, 1, 0); // or node.x / node.y / node.z, or node.position = { x, y, z }
node.scale = 2; // a number scales all three axes; a negative axis mirrors
node.angle = { x: 0, y: 45, z: 0 }; // degrees; node.rotation takes radians
node.origin = { x: 0.5, y: 0, z: 0 }; // pivot: turn and scale about this local point, without moving the node
door.angle.y = -90; // swings on the hinge at its origin

// Quaternion, Matrix4, Box and Vector3 all come from '@pixi/3d'.
const spin = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.02);
wheel.quaternion.multiply(spin); // about the node's own axes; premultiply(spin) turns about the parent's
head.quaternion.slerp(aim.quaternion, 0.1); // ease toward another node's turn (same parent)
```

Every option above is also a constructor option, alongside `label`, `x`/`y`/`z`, `visible`, `children`, `parent`, `boundsVolume` and `width`/`height`/`depth`. Keys apply in the order written (of `rotation`, `angle` and `quaternion`, the last wins), then `children` are added, then `width`/`height`/`depth` measure them, then `parent` adds the node.

`lookAt(worldPoint, up = { x: 0, y: 1, z: 0 })` turns the node at once. Meshes, models, sprites and plain `Container3D`s aim local **+Z**; `Camera3D` and every light aim **-Z**. It aims from `position + origin`. To turn gradually, `lookAt` an empty twin (`new Container3D({ position: head.position, parent: head.parent })`) and `slerp` toward its quaternion.

## Local and world space

```ts
const muzzle = turret.toGlobal({ x: 0, y: 0, z: 1.3 }); // turret space -> world
const seen = turret.toLocal(drone.getGlobalPosition()); // world -> turret space: +z ahead, x/y off-axis
const rel = turret.toLocal({ x: 0, y: 0, z: 0 }, drone); // drone's origin in turret space, in one call
const world = mesh.getGlobalTransform(); // current world Matrix4; .decompose(pos, quat, scale) splits it
```

Moving a node to a new parent: `addChild(child)` keeps its local numbers, so it jumps to the same offset from the new parent; `reparentChild(child)` (and `reparentChildAt(child, index)`) rewrites `position`, `quaternion` and `scale` so it stays put in the world. Use `reparentChild` to pick up, drop or attach things to a moving part.

## Hierarchy and finding

- `addChild(a, b, ...)` appends and returns the first; a child with another parent leaves it first, and one already here moves to the end. `addChildAt(child, i)`, `removeChild(...)`, `removeChildAt(i)`, `removeChildren(begin?, end?)` (returns them last child first), `removeFromParent()`, `getChildAt(i)` and `getChildIndex(child)` (both throw when out of range or not a child), `setChildIndex`, `swapChildren(a, b)`, and `replaceChild(old, new)` (`new` takes `old`'s index and local transform) all match pixi's `Container`.
- `children` order doesn't decide draw order; the render passes do. Read the array, change it through the methods.
- `label` is the name: plain nodes start `null`, `Mesh3D` starts `'Mesh3D'`, `Model3D` `'Model3D'`, and glTF nodes take their file names. `getChildByLabel(label, deep = false)` returns the first match or `null`; without `deep` it checks direct children only. Both it and `getChildrenByLabel(label, deep, out?)` accept a `RegExp`; unlabelled nodes never match one.
- `node.traverse((n) => ...)` visits the node and its whole subtree, hidden ones included, depth first; it can't stop early. Skeleton bones and `BatchedMesh3D` items aren't nodes, so neither `traverse` nor `getChildByLabel` reaches them. `model.logHierarchy()` prints the tree with labels. `node.view3d` is the `View3D` the node is in, or `null` outside a scene; `node.destroyed` is `true` after `destroy()`.

```ts
model.traverse((n) => {
  if (n instanceof Mesh3D) n.castShadow = true;
});
const wheels = car.getChildrenByLabel(/^wheel_/, true);
```

## Bounds and size

`getLocalBounds(out?)` returns a `Box` (`min`, `max`, `width`, `height`, `depth`, `getCenter(out?)`, `getSize(out?)`) in the node's **own** space: its own position, rotation and scale don't count, its children's do. Hidden descendants are left out. It walks the subtree on every call, as do the `width`, `height` and `depth` getters, so cache it. `width`/`height`/`depth` are bounds times `|scale|`; assigning one rescales that axis only. `setSize(w, h?, d?)` scales each axis to its target in one measurement (missing axes take `w`), which changes the shape; `getSize(out?)` reads all three as a `Size3D`.

```ts
// Fit a model into a 2-unit cube, shape kept, centred and standing on y = 0 (holds while the model isn't rotated).
const b = model.getLocalBounds();
model.scale = 2 / Math.max(b.width, b.height, b.depth);
const c = b.getCenter();
model.position.set(-c.x * model.scale.x, -b.min.y * model.scale.y, -c.z * model.scale.z);

const worldBox = mesh.getLocalBounds().applyMatrix4(mesh.getGlobalTransform()); // world AABB; applyMatrix4 is in place
swarm.boundsVolume = Box.fromCenterSize({ x: 0, y: 2, z: 0 }, 10); // fixed box measured instead of the subtree; null to clear
```

## Visibility and events

`visible = false` hides the node and its subtree from the next frame, without rebuilding anything; a hidden node stays in the tree and can still be moved and found. `worldVisible` is a number, `1` when the node and every ancestor are visible, worked out by the view each frame, so it lags a change by a frame. Never hide `view.root` or an ancestor of the camera: rendering throws.

Listen with `on`/`once`/`off`. On the parent: `childAdded(child, parent, index)` and `childRemoved(child, parent, index)`. On the child: `added(parent)` and `removed(parent)` (the former parent). Also `visibleChanged(visible)` and `destroyed(node)`. A move within the same parent fires none; `reparentChild` fires all four.

## Teardown

`destroy()` empties the node, detaches it and its children from the scene, emits `destroyed` and drops its listeners. Every flag defaults to `false`, so children, geometry, materials and textures survive (the children detached but alive). `destroy({ children: true })` destroys the subtree with the same options; add `geometry: true`, `material: true` and `texture: true` for resources nothing else shares; `destroy(true)` destroys everything reachable, shared or not. A `Model3D` also stops its animation player; its `source` is never destroyed.

`unload()` frees the subtree's geometry GPU memory and keeps the CPU data, so showing it again re-uploads it; `Model3D.unload()` also frees its materials' textures. Remove the node from the scene first.

```ts
for (const n of level.removeChildren()) n.destroy({ children: true }); // clear a level, keep shared assets
cache.removeFromParent();
cache.unload(); // back later with view.root.addChild(cache)
```
