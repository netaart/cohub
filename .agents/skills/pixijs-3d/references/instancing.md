Draw thousands of copies as one node with `BatchedMesh3D`: each slot is a geometry, a material and a matrix, with no scene node per copy.

## Quick Start

```ts
import {
  AmbientLight,
  BatchedMesh3D,
  CubeGeometry,
  DirectionalLight,
  Material3D,
  Matrix4,
  RenderPassBit,
  SphereGeometry,
  View3D,
} from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application } from 'pixi.js';

const SIDE = 120;
const COUNT = SIDE * SIDE; // 14,400 instances, one node
const SPACING = 1.5;

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: 0x10121c, antialias: true });
document.body.appendChild(app.canvas);

const view3d = new View3D({ autoResize: true });
app.stage.addChild(view3d);

const sun = new DirectionalLight({ color: 0xffffff, intensity: 4 });
sun.rotation.set(-Math.PI / 3, Math.PI / 5, 0); // lights shine down their local -Z
view3d.root.addChild(sun, new AmbientLight({ color: 0x8090ff, intensity: 0.4 }));

view3d.camera.far = 1000;
view3d.camera.position.set(0, 80, 140);
new OrbitCamera({ view: view3d, enableDamping: true });

const cube = new CubeGeometry({ width: 0.8, height: 0.8, depth: 0.8 });
const sphere = new SphereGeometry({ radius: 0.5, widthSegments: 16, heightSegments: 12 });
const palette = [0xff5a5f, 0xffc145, 0x5bc0eb, 0x9bc53d].map(
  (baseColor) => new Material3D({ baseColor, metallic: 0.1, roughness: 0.5 }),
);

// The slot count is fixed here. A slot draws once it has a geometry, a material and passes.
const field = new BatchedMesh3D({ size: COUNT });
const seeds = new Float32Array(COUNT * 2);
const half = ((SIDE - 1) / 2) * SPACING;

for (let i = 0; i < COUNT; i++) {
  seeds[i * 2] = (i % SIDE) * SPACING - half;
  seeds[i * 2 + 1] = Math.floor(i / SIDE) * SPACING - half;
  field.setGeometryAt(i, i % 2 === 0 ? cube : sphere); // mixed geometries in one batch
  field.setMaterialAt(i, palette[i % palette.length]);
  field.setPassesAt(i, RenderPassBit.OPAQUE); // slots don't pick passes from the material
}
view3d.root.addChild(field);

// One scratch matrix, reused for every slot: setMatrixAt copies it and allocates nothing.
const m = new Matrix4();
const pos = { x: 0, y: 0, z: 0 };
let time = 0;

app.ticker.add(() => {
  time += app.ticker.deltaMS / 1000;
  for (let i = 0; i < COUNT; i++) {
    pos.x = seeds[i * 2];
    pos.z = seeds[i * 2 + 1];
    const phase = Math.hypot(pos.x, pos.z) * 0.1 - time * 2;
    pos.y = Math.sin(phase) * 3;
    field.setMatrixAt(i, m.makeRotationY(phase).setPosition(pos)); // rotation first, then write the translation
  }
});
```

The slot count is fixed at construction (`field.size`); size it for the most copies you will show and hide the spares. Slot matrices are relative to the `BatchedMesh3D`, so moving, rotating or scaling the node moves every slot on the GPU for free. Matrices must be affine (bottom row `0, 0, 0, 1`).

## Per-slot setup rules

- A new slot has no passes and an all-zero matrix, so it draws nothing; slots you never fill can stay empty. Give a slot its geometry, material and matrix, then its passes. A hidden slot stays in its passes, so it keeps needing all three.
- Call `setPassesAt` for every slot you fill. A slot does not take its passes from its material the way a `Mesh3D` does: use `RenderPassBit.OPAQUE` for opaque or `'mask'` materials, `RenderPassBit.TRANSPARENT` for `'blend'`, and OR in `RenderPassBit.SHADOW` to cast shadows.
- Slots don't see changes to a material they already use. After mutating a shared material, call `invalidate(i)` on each slot that uses it. Swapping in another material with `setMaterialAt` needs no `invalidate`.

## Per-instance values: `instanceData`

Declare `vec4` fields on the batch, read them in a shader bit as `instance.<name>`, and write them per slot. The field's name and type must match the bit's `bindings.instance` entry exactly.

```ts
import type { ShaderBit } from '@pixi/3d';

const tintBit: ShaderBit = {
  name: 'instanceTint',
  bindings: { instance: { tint: 'vec4<f32>' } },
  gpu: { fragment: { material: 'albedo *= instance.tint.rgb;' } },
  gl: { fragment: { material: 'albedo *= instance.tint.rgb;' } },
};
const material = new Material3D({ baseColor: 0xffffff, extraBits: [tintBit] });

const boxes = new BatchedMesh3D({
  size: COUNT,
  instanceData: { tint: { value: [1, 1, 1, 1], type: 'vec4<f32>' } }, // every slot's starting value
});
boxes.setInstanceDataAt(i, 'tint', 1, 0.2, 0.2, 1); // always four numbers; uploads on next render
```

For every slot each frame, write into the shared array and call `update()` once. Always read `stride`, `offset` and `fields`; never hard-code them. `boxes.instanceData` throws if the batch was built without the `instanceData` option. The shadow pass doesn't run material bits, so shadows ignore anything a bit does to the shape.

```ts
const { data, stride, offset, fields } = boxes.instanceData;
for (let i = 0, o = offset + fields.tint; i < boxes.size; i++, o += stride) {
  data[o] = 0.5 + 0.5 * Math.sin(time + i * 0.1); // tint.r
}
boxes.instanceData.update();
```

## Faster matrix writes: `matrices`

`setMatrixAt` is fine every frame for every slot. For hundreds of thousands, skip the `Matrix4` copy and write column-major floats straight into `field.matrices`. A slot's matrix starts as all zeros, so write the full matrix once with `setMatrixAt` before you start writing only the lanes that move. Write only the 16 floats of each slot; the floats between slots belong to the engine.

```ts
for (let i = 0; i < COUNT; i++) field.setMatrixAt(i, m.makeTranslation(seeds[i * 2], 0, seeds[i * 2 + 1]));

app.ticker.add(() => {
  const { data, stride, offset } = field.matrices; // re-read each frame
  for (let i = 0, o = offset; i < COUNT; i++, o += stride) {
    data[o + 13] = Math.sin(time + i * 0.01) * 3; // 0-2, 4-6, 8-10 rotation/scale; 12-14 translation
  }
  field.matrices.update(); // nothing uploads without this; update(first, count) uploads only that range
});
```

## Spawning and despawning: `setVisibleAt`

Hiding a slot rebuilds nothing, so a pool is how to spawn and despawn: fill every slot (geometry, material, passes) at setup, then `setVisibleAt(i, false)` the spares. Keep `setPassesAt` for setup: it moves the slot in its passes' draw commands and rebuilds its shader when it joins one. The exception is blended slots that stay spare for a long time: the transparent pass still sorts hidden slots every frame, so take those out with `setPassesAt(i, 0)`.

```ts
function spawn(x: number, y: number, z: number): number {
  for (let i = 0; i < bullets.size; i++) {
    if (bullets.getVisibleAt(i)) continue;
    bullets.setMatrixAt(i, m.makeTranslation(x, y, z));
    bullets.setVisibleAt(i, true);
    return i;
  }
  return -1; // pool exhausted; despawn with bullets.setVisibleAt(i, false)
}
```

## Culling, and when you don't need a batch

A batch does not frustum-cull by default (`cull: 'off'`), whatever the view's setting. Turn it on for batches spread well beyond the screen: `new BatchedMesh3D({ size: 50_000, cull: 'gpu' })` or `forest.cull = 'cpu'` later.

Plain `Mesh3D` nodes that share one geometry, the same kind of material and the same texture sources (frames of one sprite sheet or atlas count as one source) (`new Mesh3D({ geometry: cube, material: palette[i % 4] })` in a loop) are already batched by the view into instanced draws: one per geometry on WebGL whatever the colours, one per material on WebGPU until a geometry needs more than 16. They keep per-node features: picking, `lookAt`, children, animation, and the view's culling (`'gpu'` by default). Reach for `BatchedMesh3D` when you have tens of thousands of copies, rewrite every transform every frame, or need per-instance shader values.

## Level of detail

There is no LOD component: build each level's geometry once and set `mesh.geometry` by camera distance. A swap rebuilds the mesh's shader, so change level only once the distance is a band past a threshold, or a mesh hovering at one flips every frame.

```ts
const THRESHOLDS = [16, 24];
const BAND = 1;
const levels = [32, 12, 6].map((w) => new SphereGeometry({ widthSegments: w, heightSegments: w / 2 }));
const rock = new Mesh3D({ geometry: levels[0], material: palette[0], parent: view3d.root });
let level = 0;

app.ticker.add(() => {
  const d = view3d.camera.position.distanceTo(rock.position);
  while (level < THRESHOLDS.length && d > THRESHOLDS[level] + BAND) level++;
  while (level > 0 && d < THRESHOLDS[level - 1] - BAND) level--;
  if (rock.geometry !== levels[level]) rock.geometry = levels[level];
});
```
