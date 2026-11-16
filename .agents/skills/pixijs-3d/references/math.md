# Math

Vectors, quaternions, matrices, the shapes a game tests against (`Box`, `Sphere`, `Ray`, `Plane`, `Frustum`) and `Spherical` / `Cylindrical` for orbits. All are exported from `@pixi/3d`.

## Quick Start

A cone steers toward the pointer's spot on the ground with a smooth turn, crates turn red while its box overlaps theirs, and a drone circles it on spherical coordinates.

```ts
import { Box, ConeGeometry, Container3D, CubeGeometry, DirectionalLight, Material3D } from '@pixi/3d';
import { Matrix4, Mesh3D, Plane, PlaneGeometry, Quaternion, SphereGeometry } from '@pixi/3d';
import { Spherical, Vector3, View3D } from '@pixi/3d';
import { Application } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: 0x20242c, antialias: true });
document.body.appendChild(app.canvas);

const view = new View3D({ autoResize: true, environment: { skyColor: 0xc8d8f0, groundColor: 0x40382c } });
app.stage.addChild(view);
view.camera.position.set(0, 14, 12);
view.camera.lookAt({ x: 0, y: 0, z: 0 });

const sun = new DirectionalLight({ intensity: 2.5, parent: view.root });
sun.lookAt({ x: -0.4, y: -1, z: -0.3 }); // a light at the origin aims its -Z at this point
new Mesh3D({
  geometry: new PlaneGeometry({ width: 24, height: 24 }),
  material: new Material3D({ baseColor: 0x55634a, roughness: 1 }),
  rotation: { x: -Math.PI / 2, y: 0, z: 0 },
  parent: view.root,
});

// The seeker faces its +Z. Its cone's tip points +Y, so the cone is tipped +90° around X to point +Z.
const seeker = new Container3D({ position: { x: 0, y: 0.6, z: 0 }, parent: view.root });
new Mesh3D({
  geometry: new ConeGeometry({ radius: 0.5, height: 1.2 }),
  material: new Material3D({ baseColor: 0xf0c040 }),
  rotation: { x: Math.PI / 2, y: 0, z: 0 },
  parent: seeker,
});

// Crates never move, so their world-space boxes are measured once.
const crates = [-6, -2, 2, 6].map((x, i) => {
  const material = new Material3D({ baseColor: 0x8a5a3a });
  const geometry = new CubeGeometry({ width: 1.5, height: 1.5, depth: 1.5 });
  const mesh = new Mesh3D({ geometry, material, position: { x, y: 0.75, z: i % 2 ? 3 : -3 }, parent: view.root });
  // getLocalBounds leaves out the node's own transform: carry the box into world space with it.
  return { material, box: mesh.getLocalBounds().applyMatrix4(mesh.getGlobalTransform()) };
});

const drone = new Mesh3D({
  geometry: new SphereGeometry({ radius: 0.2 }),
  material: new Material3D({ baseColor: 0x60d0ff }),
  parent: view.root,
});

// Scratch objects, made once and reused every frame.
const UP = { x: 0, y: 1, z: 0 };
const groundPlane = new Plane(new Vector3(0, 1, 0), 0); // y = 0
const target = new Vector3(5, 0, 4);
const hit = new Vector3();
const toTarget = new Vector3();
const forward = new Vector3();
const heading = new Quaternion();
const seekerLocalBox = seeker.getLocalBounds(); // its cone, in the seeker's own space
const seekerBox = new Box();
const seekerWorld = new Matrix4();
const orbit = new Spherical(1.5, Math.PI / 3, 0); // radius, angle down from +Y, angle around Y
const pointer = app.renderer.events.pointer.global; // pixi's live pointer position

app.ticker.add((ticker) => {
  const dt = ticker.deltaMS / 1000;

  // Where the pointer's ray meets the ground; null when it points above the horizon.
  if (view.screenToWorld(pointer, groundPlane, hit)) target.copyFrom(hit);

  // Ease the facing toward the target, then move along the new facing.
  target.subtract(seeker.position, toTarget);
  toTarget.y = 0;
  if (toTarget.magnitude() > 0.3) {
    heading.setFromAxisAngle(UP, Math.atan2(toTarget.x, toTarget.z)); // the yaw that points +Z at the target
    seeker.quaternion.slerp(heading, 1 - Math.exp(-6 * dt)); // the same ease at any frame rate
    forward.set(0, 0, 1).applyQuaternion(seeker.quaternion);
    seeker.position.addScaledVector(forward, 4 * dt);
  }

  // Overlap: the seeker's box carried into world space, against each crate's.
  seekerLocalBox.applyMatrix4(seeker.getGlobalTransform(seekerWorld), seekerBox);
  for (const crate of crates) crate.material.baseColor = crate.box.intersectsBox(seekerBox) ? 0xe04040 : 0x8a5a3a;

  // The drone circles the seeker: a spherical offset turned into a point, plus the centre.
  orbit.theta += 2 * dt;
  drone.position.setFromSpherical(orbit).add(seeker.position);
});
```

## Rules that run without errors

- **In place by default.** `a.add(b)` changes `a`. Pass an `out` last (`a.add(b, out)`) to leave `a` alone; the call returns `out`. Queries that make a point (`getCenter`, `at`, `intersectPlane`, `closestPointToPoint`, `projectPoint`) return a new `Vector3` unless given an `out`.
- **Allocate once.** Make scratch objects outside the ticker. `Vector3.shared`, `Quaternion.shared` and `Matrix4.shared` reset on every access: use one inside a single expression, never store it.
- **Names differ from Three.js:** `subtract`, `multiplyScalar`, `magnitude`, `copyFrom`, `getInverse(m)`. Vectors have no `lerp`: `p.addScaledVector(toTarget, t)` with `toTarget = target - p` is the same.
- **Radians** for `rotation`, `setFromAxisAngle`, `makeRotationY`, `makePerspective` and `Spherical`; **degrees** only for `node.angle` and `camera.fov`.
- **Unit length is assumed** for `setFromAxisAngle`'s axis, `setFromUnitVectors`, `Ray.direction` and `Plane.normal`. `normalize()` leaves a zero vector at zero.
- **Angles around Y start at +Z and turn toward +X**, so `Math.atan2(dx, dz)` is the yaw that points a node's +Z along `(dx, dz)`.
- **Spaces.** `node.position` is in the parent's space; `getLocalBounds()` is in the node's own space without its transform; `screenToRay`, `screenToWorld`, `mesh.boundingSphere`, `camera.frustum` and `lookAt` targets are world space.

## Node transforms are live observables

`position`, `scale`, `rotation` (Euler radians, XYZ order) and `origin` are `ObservableVector3`s and `quaternion` is an `ObservableQuaternion`, with the plain classes' methods. A write that changes a value marks the node for a transform rebuild.

```ts
const spawn = new Vector3().copyFrom(player.position); // a snapshot
const live = player.position; // the same object forever: it moves with the player
enemy.position = player.position; // copies the values once; the enemy doesn't follow
```

- `node.position.clone()` keeps the node as its observer, so writes to the copy mark the node dirty; `new Vector3().copyFrom(...)` is a plain copy.
- A node's facing: meshes and models look down local +Z, so `new Vector3(0, 0, 1).applyQuaternion(node.quaternion)` is its direction in its parent's space, and `node.toGlobal({ x: 0, y: 0, z: 1 }).subtract(node.getGlobalPosition())` in world space (cameras and lights look down -Z). `new Vector3().setFromMatrixColumn(node.getGlobalTransform(), 2).normalize()` reads the same world +Z (column 3 is the world position). There is no getWorldDirection.
- `rotation` and `quaternion` are unsynced, and the last written is in use (`scene-graph.md`). After a `rotation` write, `node.quaternion` holds the old turn until the view's transform pass or a `getGlobalTransform()`, so `applyQuaternion(node.quaternion)` lags: drive the quaternion on nodes whose facing you read.
- `node.worldTransform` is from the last transform pass; `getGlobalTransform(out)` and `getGlobalPosition(out)` are current.

## Quaternions: turning and aiming

```ts
const q = new Quaternion().setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2); // quarter turn, +Z to +X
q.setFromEuler({ x: 0, y: yaw, z: 0 }); // the XYZ order node.rotation uses
q.setFromUnitVectors({ x: 0, y: 0, z: 1 }, dir); // shortest turn from +Z to the unit vector dir
ship.quaternion.multiply(roll); // turns around the ship's own axes
globe.quaternion.premultiply(spin); // turns around the parent's axes
const left = head.quaternion.angleTo(aim); // radians, 0 to π
if (left > 0) head.quaternion.slerp(aim, Math.min(1, (turnRate * dt) / left)); // constant rate, radians/s
```

- `slerp(qb, t)` takes the shorter way round; `1 - Math.exp(-k * dt)` as `t` eases, the line above turns at a fixed rate.
- `setFromUnitVectors` with exactly opposite vectors gives a half turn around an arbitrary axis, which can roll a ground unit over: build its yaw with `atan2` as the Quick Start does.
- `node.lookAt(worldPoint)` turns at once (a mesh's +Z, a camera's or light's -Z). For a smooth aim, `lookAt` an empty twin with the same parent and position and slerp toward `twin.quaternion`.
- `normalize()` now and then after long `multiply` chains; they drift from unit length.

## Vectors and matrices

```ts
toPlayer.copyFrom(player.position).subtract(enemy.position).normalize();
if (enemy.position.distanceToSquared(player.position) < range * range) attack(); // no square root
const ahead = forward.dot(toPlayer) > 0; // unit vectors: 1 same way, 0 at right angles, -1 opposite
edgeA.cross(edgeB, normal).normalize();
muzzleOffset.applyAffineMatrix4(gun.getGlobalTransform(m), muzzleWorld); // a point through a node transform
dir.transformDirection(m); // a direction: no translation, then normalized
worldPoint.applyMatrix4(view.camera.viewProjection, ndc); // divides by w: on screen when x and y are in -1..1
const world = new Matrix4().compose(position, rotation, scale); // scale, then rotate, then move
world.decompose(outPosition, outQuaternion, outScale);
const worldToLocal = new Matrix4().getInverse(world); // this becomes the inverse of the argument
```

- `a.multiply(b)` is `a * b`, so `b` applies to a point first: the parent's world matrix multiplied by the child's local matrix is the child's world. `premultiply(b)` is `b * a`; `append` / `prepend` are aliases.
- `elements` is column-major with the translation at 12, 13, 14. Inverting a non-invertible matrix gives identity and a warning.
- `Matrix4.lookAt(eye, target, up)` points **-Z** at `target` (the camera convention) and writes only rotation. `extractForward(out)` reads -Z too, so it points backwards for a mesh.
- `makePerspective(fovy, aspect, near, far)` takes radians, unlike `camera.fov`.
- `Matrix3` has `getNormalMatrix(matrix4)` and `setUvTransform(...)` (a material's `uvTransform` is a pixi `Matrix`). `Vector2` adds `angle()`, `rotate(angle)` and a number-valued `cross`; `Vector4`'s `w` defaults to 1 and its `applyMatrix4` doesn't divide.

## Boxes and spheres

```ts
const zone = Box.fromCenterSize({ x: 0, y: 1, z: 0 }, { x: 4, y: 2, z: 4 }); // full size, not half
const squad = new Box(); // empty until it grows
for (const unit of units) squad.expandByPoint(unit.position);
level.union(roomBox);
const worldBox = mesh.getLocalBounds(scratchBox).applyMatrix4(mesh.getGlobalTransform(m));
if (zone.containsPoint(player.position) || zone.intersectsBox(worldBox)) trigger();
const blast = new Sphere(new Vector3(0, 0, 0), 4);
if (blast.intersectsSphere(enemy.boundingSphere)) enemy.hit();
```

- `new Sphere()` and `new Sphere(center)` are empty (radius -1) and intersect nothing: pass a radius.
- An empty box's `getCenter` / `getSize` are 0 and its `width` / `height` / `depth` are `-Infinity`. Touching boxes intersect; `containsPoint` includes the boundary.
- `applyMatrix4` fits a new axis-aligned box around the turned corners, so a rotated box grows.
- Vectors passed to the `Box`, `Sphere`, `Ray` and `Plane` constructors become the shape's own; `set(...)` copies.
- `mesh.boundingSphere` is world space, shared, and from the last transform pass: `clone()` to keep it. `geometry.bounds3D` and `geometry.boundsSphere` are in the mesh's local space.

## Rays, planes and visibility

```ts
const ray = view.screenToRay(e.global, pointerRay); // world space, unit direction
const onFloor = ray.intersectPlane(floorPlane, hit); // the point, or null
const t = ray.intersectBoxT(wallBox); // distance, or -1 on a miss; intersectSphereT likewise
ray.closestPointToPoint(enemy.position, nearest);
const table = new Plane().setFromNormalAndCoplanarPoint({ x: 0, y: 1, z: 0 }, { x: 0, y: 0.8, z: 0 });
const height = table.distanceToPoint(ball.position); // signed: positive on the normal's side
table.projectPoint(ball.position, shadowSpot);
if (view.camera.frustum.intersectsSphere(enemy.boundingSphere)) enemy.think(dt);
const seen = new Frustum().setFromProjectionMatrix(guardCamera.viewProjection).containsPoint(player.position);
```

- A plane is `normal · p + constant = 0`, so `y = 2` is `new Plane(new Vector3(0, 1, 0), -2)`; `setFromNormalAndCoplanarPoint` avoids the sign.
- `intersectSphere` and `intersectBox` return the exit point when the ray starts inside.
- Test in a mesh's space by carrying the ray in: `ray.applyMatrix4(new Matrix4().getInverse(world), localRay)`; under scale compare hit points, not `t`.
- `camera.frustum` is world space, rebuilt at each render, so in the ticker it is last frame's. Its tests err towards true near corners. Pointer events and `view.raycast` are in `picking-and-input.md`.

## Orbits with Spherical and Cylindrical

```ts
const orbit = new Spherical().setFromPoint3D(offsetFromCentre); // radius, phi, theta
orbit.theta += 0.5 * dt; // around +Y, from +Z toward +X
orbit.phi -= dragY * 0.01; // down from +Y: 0 straight up, π/2 level
orbit.makeSafe(); // keeps phi off the poles, where lookAt flips
camera.position.setFromSpherical(orbit).add(centre);
camera.lookAt(centre);
pillar.position.setFromCylindrical(new Cylindrical(6, (i / count) * Math.PI * 2, 0)); // radius, theta, y
```

Both measure around the origin: subtract the centre going in, add it coming out.
