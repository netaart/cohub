# Geometry

Built-in primitives, custom `Geometry3D` from typed arrays (heightmap terrain, vertex colours), and geometry you rewrite every frame.

## Quick Start

```ts
import {
  CapsuleGeometry,
  ConeGeometry,
  CubeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Geometry3D,
  IcosahedronGeometry,
  Material3D,
  Mesh3D,
  SphereGeometry,
  TorusGeometry,
  View3D,
} from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, background: 0x202030, antialias: true });
document.body.appendChild(app.canvas);

const view3d = new View3D({ autoResize: true, environment: { skyColor: 0xcfe0ff, groundColor: 0x403020 } });
app.stage.addChild(view3d);

const sun = new DirectionalLight({ intensity: 3, castShadow: true });
sun.rotation.set(-Math.PI / 3, Math.PI / 5, 0); // lights shine down their local -Z
view3d.root.addChild(sun);

// Built-in primitives: every option is optional; all are centred on the origin, axis +Y
const shapes = [
  new CubeGeometry({ width: 1, height: 1, depth: 1 }),
  new SphereGeometry({ radius: 0.6, widthSegments: 32, heightSegments: 16 }),
  new CylinderGeometry({ radiusTop: 0.4, radiusBottom: 0.6, height: 1.2 }),
  new ConeGeometry({ radius: 0.6, height: 1.2 }),
  new CapsuleGeometry({ radius: 0.4, height: 1.4 }),
  new TorusGeometry({ radius: 0.5, tube: 0.2 }),
  new IcosahedronGeometry({ radius: 0.6, detail: 0 }),
];
const palette = [0xe05050, 0xe0a040, 0xd0d050, 0x50c070, 0x4090e0, 0x8060d0, 0xd060b0];
const meshes = shapes.map((geometry, i) => {
  const material = new Material3D({ baseColor: palette[i], roughness: 0.4, flatShading: i === 6 });
  const mesh = new Mesh3D({ geometry, material });
  mesh.position.set((i - 3) * 1.6, 1.2, 0);
  view3d.root.addChild(mesh);
  return mesh;
});

// Custom geometry: a heightmap terrain in XZ, built from typed arrays
const N = 64; // quads per side
const SIZE = 14;
const height = (x: number, z: number) => Math.sin(x * 0.6) * Math.cos(z * 0.5) * 0.6;
const vertCount = (N + 1) * (N + 1);
const positions = new Float32Array(vertCount * 3);
const normals = new Float32Array(vertCount * 3);
const uvs = new Float32Array(vertCount * 2);
const colors = new Float32Array(vertCount * 4); // RGBA, four per vertex
const indices = new Uint32Array(N * N * 6);
for (let iz = 0, v = 0; iz <= N; iz++) {
  for (let ix = 0; ix <= N; ix++, v++) {
    const x = (ix / N - 0.5) * SIZE;
    const z = (iz / N - 0.5) * SIZE;
    const y = height(x, z);
    positions.set([x, y, z], v * 3);
    const e = 0.01; // normal from central differences: (-dh/dx, 1, -dh/dz)
    const nx = -(height(x + e, z) - height(x - e, z)) / (2 * e);
    const nz = -(height(x, z + e) - height(x, z - e)) / (2 * e);
    const len = Math.hypot(nx, 1, nz);
    normals.set([nx / len, 1 / len, nz / len], v * 3);
    uvs.set([ix / N, iz / N], v * 2);
    const t = (y + 0.6) / 1.2; // linear-light RGBA: green valleys, pale peaks
    colors.set([0.03 + 0.3 * t, 0.12 + 0.25 * t, 0.02 + 0.3 * t, 1], v * 4);
  }
}
for (let iz = 0, i = 0; iz < N; iz++) {
  for (let ix = 0; ix < N; ix++) {
    const a = iz * (N + 1) + ix; // counter-clockwise seen from +Y, the side the normals face
    const b = a + N + 1;
    indices.set([a, b, a + 1, a + 1, b, b + 1], i);
    i += 6;
  }
}
const terrain = new Mesh3D({
  geometry: new Geometry3D({ positions, normals, uvs, colors, indices }),
  material: new Material3D({ baseColor: 0xffffff, roughness: 0.9, vertexColors: true }),
});
view3d.root.addChild(terrain);

view3d.camera.position.set(0, 5, 11);
new OrbitCamera({ view: view3d, target: { x: 0, y: 0.5, z: 0 }, enableDamping: true });

app.ticker.add((ticker) => {
  for (const mesh of meshes) mesh.rotation.y += 0.01 * ticker.deltaTime;
});
```

## Built-in primitives

Wrap any geometry in `new Mesh3D({ geometry, material })`; one geometry can serve many meshes. All are exported from `@pixi/3d`, take one optional options object (no positional args), are centred on the origin, and stand along +Y. Defaults shown:

```ts
new CubeGeometry({ width: 1, height: 1, depth: 1, widthSegments: 1, heightSegments: 1, depthSegments: 1 });
new SphereGeometry({ radius: 1, widthSegments: 32, heightSegments: 16 });
new PlaneGeometry({ width: 1, height: 1, widthSegments: 1, heightSegments: 1, flipV: false });
new CylinderGeometry({ radiusTop: 1, radiusBottom: 1, height: 2, radialSegments: 32, openEnded: false });
new ConeGeometry({ radius: 1, height: 2, radialSegments: 32, heightSegments: 1, openEnded: false });
new CapsuleGeometry({ radius: 0.5, height: 2, radialSegments: 32, heightSegments: 8 }); // height includes the caps
new TorusGeometry({ radius: 1, tube: 0.4, radialSegments: 12, tubularSegments: 48, arc: Math.PI * 2 });
new TorusKnotGeometry({ radius: 1, tube: 0.4, tubularSegments: 64, radialSegments: 8, p: 2, q: 3 });
new IcosahedronGeometry({ radius: 1, detail: 0 }); // detail 2+ is a geodesic sphere, capped at 7
```

There is no BoxGeometry, no `segments` shorthand and no `(width, height, depth)` constructor. Cylinder also takes `heightSegments: 1`, and a radius of 0 closes that end to a point; torus `arc` sweeps the ring and `thetaStart`/`thetaLength` cut the tube. Torus lies in XZ (Three.js's lies in XY). For a textured ball use `SphereGeometry`; `IcosahedronGeometry` has a UV seam that smears textures. Use `flatShading: true` on the material for a faceted look instead of duplicating vertices.

## PlaneGeometry is a wall, not a floor

It lies in XY with a +Z normal and is single-sided. Turn it to make a floor, and set `flipV` when it shows an image (default UVs run upward, so pictures come out upside down). `CubeGeometry` has no `flipV`, so an image on its side faces shows upside down.

```ts
const ground = new Mesh3D({ geometry: new PlaneGeometry({ width: 20, height: 20 }), material });
ground.rotation.x = -Math.PI / 2; // +Z normal now points +Y
const poster = new PlaneGeometry({ width: 1.6, height: 0.9, flipV: true });
const wall = new Mesh3D({ geometry: new PlaneGeometry(), material: new Material3D({ doubleSided: true }) });
```

## Custom Geometry3D rules

`new Geometry3D({ positions, normals, uvs, colors, indices })`, all flat typed arrays, vertex after vertex. Only `positions` is required.

- `positions`, `normals`: `Float32Array`, 3 per vertex. `uvs`: 2 per vertex. `tangents`: 4 per vertex.
- `colors`: **4 per vertex (RGBA)**, `Float32Array` or normalized `Uint8Array`/`Uint16Array`. Widen RGB yourself. They only tint when the material has `vertexColors: true`, and they are linear light, so mid values look pale: convert sRGB picks with `srgbToLinear`.
- `indices`: `Uint16Array` or `Uint32Array`, three per triangle. Use `Uint32Array` past 65,535 vertices. Leave it out to draw vertices in order.
- Front faces are counter-clockwise seen from the side the normals point to (the Quick Start grid: `[a, b, a + 1, a + 1, b, b + 1]` with `b` one row further along +Z faces +Y). Wrong winding makes the mesh vanish from the front; `doubleSided: true` on the material hides the mistake.
- There is no computeVertexNormals(). Without `normals` everything lights as if the normal were `(0, 0, 1)`. Compute them (central differences for a heightmap) or use `flatShading: true`.
- `topology: 'line-list'` draws vertex pairs as lines and `'point-list'` draws each vertex as a dot; give them an unlit `FlatMaterial` and `castShadow: false` on the mesh.
- `morphTargets: [{ positions, normals }]` adds blend shapes, each an offset per vertex from the base arrays; the mesh blends them by its `weights` (`mesh.weights![0] = 0.5`).
- `getAttributeData(geometry, 'aPosition', 3)` reads any attribute back as a new `Float32Array`, however it is stored (`'aNormal'` 3, `'aUV'` 2, `'aTangent'` 4). Use it for CPU work on built-in or loaded geometry; the `positions`/`normals` getters return the data as stored.

A `Mesh3D` can start without either part (`new Mesh3D({ parent: view3d.root })`) and draws nothing until both `geometry` and `material` are assigned.

## Changing vertices after creation

A normal geometry is copied into shared GPU buffers the first time it draws, and **later edits never show**. For a one-off change, build a new geometry and assign `mesh.geometry`. For per-frame edits construct it with `dynamic: true` (fixed at construction; built-ins accept it too), write the arrays in place, then call `update()` on the attribute's buffer. Dynamic geometry is never frustum-culled.

```ts
const water = new PlaneGeometry({ width: 10, height: 10, widthSegments: 48, heightSegments: 48, dynamic: true });
const rest = Float32Array.from(water.positions); // XY grid, z = 0; lay the mesh flat with rotation.x = -PI/2
let time = 0; // flatShading: true on the material saves recomputing normals
app.ticker.add((ticker) => {
  time += ticker.deltaMS / 1000;
  const p = water.positions as Float32Array;
  for (let i = 0; i < p.length; i += 3) {
    p[i + 2] = Math.sin(rest[i] * 1.5 + time * 2) * Math.cos(rest[i + 1] + time) * 0.25;
  }
  water.attributes.aPosition.buffer.update();
});
```

Normals are stored quantized (`Int16Array`, 4 per vertex, 32767 = 1) by default. To rewrite them every frame, pass `quantizeNormals: false` with `dynamic: true`, write `geometry.normals as Float32Array`, then call `geometry.attributes.aNormal.buffer.update()`. The `positions` setter needs an array at least as long as the original; you can't grow a geometry.
