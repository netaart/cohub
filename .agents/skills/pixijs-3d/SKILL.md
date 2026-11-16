---
name: pixijs-3d
description: 'Use this skill whenever writing or editing code that uses PixiJS 3D (@pixi/3d): scenes, View3D, Mesh3D, Model3D, lights, shadows, cameras, OrbitCamera, FPSCamera, materials, Material3D, textures, glTF models and animation, BatchedMesh3D instancing, picking and pointer events, post-processing (bloom, SSAO), particles, render to texture, ContainerTexture, custom shader bits, 2D HUD over 3D, Sprite3D billboards, tone mapping and HDR environments, scene graph and transforms (local and world space, reparenting, bounds), vector and quaternion math (Vector3, Quaternion, Matrix4, slerp, Box, Ray, Plane, Frustum), porting a Three.js app. Read it before writing any @pixi/3d code: the API is new and differs from Three.js and from pixi3d, an older, unrelated npm package. Triggers on: @pixi/3d, pixi 3d, PixiJS 3D, View3D, Mesh3D, Model3D, Camera3D, Container3D, 3D scene in pixi, port or convert from Three.js.'
license: MIT
disable-model-invocation: true
---

PixiJS 3D (`@pixi/3d`) is PixiJS's 3D extension. A `View3D` is an ordinary 2D display object on the Pixi stage that renders a 3D scene into its rectangle, so 3D and 2D mix freely. The scene hangs from `view.root`, the view owns its `camera`, lights are nodes in the scene, and the Pixi application ticker is the frame loop.

This file gives you the mental model, a complete starting app, and the conventions that catch people. The `references/` folder has one complete, runnable recipe per job; open the one you need.

For a signature or option this skill doesn't cover, fetch the class's API page: `https://3d.pixijs.download/release/docs/<module>.<Class>.html.md` (scene.View3D, materials.Material3D, extras_camera.OrbitCamera, maths.Vector3). To find a class's module, or a guide on a topic, look it up in `https://3d.pixijs.download/release/docs/llms.txt`.

## Quick Start

A lit scene with shadows, two primitives, a loaded model and mouse orbit controls. Complete src/main.ts for a Vite + TypeScript app with `pixi.js` and `@pixi/3d` installed.

```ts
import {
  CubeGeometry,
  DirectionalLight,
  Material3D,
  Mesh3D,
  Model3D,
  PlaneGeometry,
  SphereGeometry,
  View3D,
} from '@pixi/3d';
import type { Scene3DSource } from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application, Assets } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: 0x87b7e6, antialias: true });
document.body.appendChild(app.canvas);

// A View3D is a 2D display object that renders a 3D scene into its rectangle.
const view = new View3D({
  autoResize: true,
  shadowQuality: 'medium',
  environment: { skyColor: 0xbcd4f0, groundColor: 0x6b6250, intensity: 0.7 }, // hemisphere fill light
});
app.stage.addChild(view);

// Lights are nodes under view.root. Lights and cameras face their local -Z axis.
const sun = new DirectionalLight({ color: 0xfff2dc, intensity: 3, castShadow: true });
sun.rotation.set(-Math.PI / 4, Math.PI / 6, 0);
view.root.addChild(sun);

// PlaneGeometry lies in XY with a +Z normal: rotate it -90° around X to make a floor.
const ground = new Mesh3D({
  geometry: new PlaneGeometry({ width: 30, height: 30 }),
  material: new Material3D({ baseColor: 0x7f8f6a, roughness: 0.95, metallic: 0 }),
  rotation: { x: -Math.PI / 2, y: 0, z: 0 },
  castShadow: false,
  receiveShadow: true,
});
view.root.addChild(ground);

// Meshes take a geometry and a material. Options objects set position, rotation, scale, shadows.
view.root.addChild(
  new Mesh3D({
    geometry: new CubeGeometry({ width: 2, height: 2, depth: 2 }),
    material: new Material3D({ baseColor: 0xd9534f, roughness: 0.6, metallic: 0 }),
    position: { x: -3, y: 1, z: 0 },
  }),
  new Mesh3D({
    geometry: new SphereGeometry({ radius: 1.2 }),
    material: new Material3D({ baseColor: 0x4a90d9, roughness: 0.3, metallic: 0.2 }),
    position: { x: 3, y: 1.2, z: 0 },
  }),
);

// Models: load a glTF/GLB with Assets, then wrap the source in a Model3D.
const source = await Assets.load<Scene3DSource>('/assets/models/Duck.glb');
// The file's own node transforms set its size (this duck is about 1.6 units); read duck.getLocalBounds() before scaling.
const duck = new Model3D({ source, position: { x: 0, y: 0, z: 3 } });
view.root.addChild(duck);

// The view owns its camera. OrbitCamera (extras) drives it from the mouse.
view.camera.position.set(0, 5, 12);
view.camera.lookAt({ x: 0, y: 1, z: 0 });
new OrbitCamera({ view, enableDamping: true });

// Per-frame work goes on the application ticker.
app.ticker.add((ticker) => {
  duck.rotation.y += 0.01 * ticker.deltaTime;
});
```

## Conventions

- **Scene graph.** Everything 3D goes under `view.root` (a `Container3D`); a mesh on `app.stage` does nothing useful. Nodes have `position`, `rotation` (Euler radians), `quaternion`, `scale`, `visible`, `lookAt(point)`, `addChild`, `traverse(callback)` over a subtree, and bounds via `getLocalBounds()`.
- **Options objects.** Constructors take one options object: `new Mesh3D({ geometry, material, position: { x, y, z }, castShadow, parent: view.root })`. The same values are plain properties afterwards (`mesh.position.set(x, y, z)`).
- **Camera.** `view.camera` is a `Camera3D`: `fov` is the vertical field of view in **degrees** (default 60), `near` 0.1, `far` 1000, `mode` `'perspective'` or `'orthographic'` with `orthographicSize` (half the view's **width** in world units, default 5). Aim it with `position.set(...)` and `lookAt(point)`.
- **Facing.** Cameras and lights look down their local -Z; meshes and glTF models face +Z. A `DirectionalLight` is aimed by its `rotation` (or `lookAt`), not a target.
- **Planes.** `PlaneGeometry` lies in the XY plane with a +Z normal. For a floor, rotate it -π/2 around X.
- **Primitive options.** `CubeGeometry({ width, height, depth })`, `SphereGeometry({ radius })`, `CylinderGeometry({ radiusTop, radiusBottom, height })` (no `radius`), `ConeGeometry({ radius, height })`, `CapsuleGeometry({ radius, height })` (height includes the caps), `TorusGeometry({ radius, tube })` (lies in XZ), `PlaneGeometry({ width, height })`, `IcosahedronGeometry({ radius, detail })`. Each also takes segment counts.
- **Lighting.** `DirectionalLight`, `PointLight`, `SpotLight`, `AmbientLight` are nodes. Soft fill comes from the view's `environment`: `{ skyColor, groundColor, intensity }` for a hemisphere, or a `CubeTexture` (`.cubemap` or `.hdr` via `Assets.load`) for image-based lighting. Shadows: `castShadow` on the light, `castShadow` / `receiveShadow` on meshes, `shadowQuality` (`'low' | 'medium' | 'high' | 'ultra'`) on the view.
- **Materials.** `Material3D` is physically based (`baseColor`, `metallic`, `roughness`, `baseColorTexture`, `alphaMode`, `alpha`); glow is an opt-in group, `emissive: { color, strength }`, never a plain colour. `FlatMaterial` is unlit. Custom looks come from shader bits in `extraBits`, not a ShaderMaterial class. `material.clone(options)` copies a material with options changed or bits added.
- **Models.** `Assets.load<Scene3DSource>(url)` then `new Model3D({ source })`. Animation clips play through `model.player`. Models from one source share its materials; `model.materials` gives one model its own.
- **Extras.** `OrbitCamera`, `FPSCamera`, `ParticleSystem3D`, `BloomEffect`, `SsaoEffect`, `TiltShiftEffect`, `MotionBlurEffect`, `TintEffect`, `FxaaEffect`, `ToonMaterial`, `PortalPass`, `PortalMaterial`, `dissolveBit` live in `@pixi/3d/extras`.
- **Many copies.** `BatchedMesh3D` draws thousands of instances in one call (`setMatrixAt`, `setInstanceDataAt`). Separate `Mesh3D` nodes batch into instanced draws on their own when they share a geometry, the same kind of material and the same texture _sources_: the frames of one sprite sheet count as one source, so `Sprite3D`s or textured meshes showing different frames of one sheet still draw together. Pack one effect's images into one sheet.
- **2D over 3D.** HUD text, buttons and sprites are ordinary Pixi objects added to the stage after the view. `view.worldToScreen(point)` places a 2D label at a 3D position; it always draws over the 3D. For a picture inside the scene that walls can hide, use `new Sprite3D({ texture, height, billboardMode, parent: view.root })`.
- **The app around it is pixi.js.** `Application` and `await app.init`, `Assets`, `Text`, pointer events and the ticker are pixi.js v8; when the `pixijs` skill is installed, use it for those.
- **Renderers.** `app.init` uses WebGL unless you pass `preference: 'webgpu'`; nothing else in your code changes. MSAA is `app.init({ antialias: true })`; `View3D` has no `antialias` option.
- **No enums.** Options like `shadowQuality`, `alphaMode` and `mode` are string literals. There is no `LightType` or `ShadowQuality` enum.

## Pitfalls that fail silently

Each line is the fix; its link owns the rule. These run without errors and draw or behave wrongly. Check the groups for what you built.

**Scene graph and math**

- `lookAt`, `reparentChild` and loaded glTF nodes set `quaternion`, and a node turns by whichever of `rotation` or `quaternion` was written last: on those nodes `rotation.y += x` replaces the real turn, so turn them with `quaternion.multiply(q)`. [scene-graph](references/scene-graph.md)
- `addChild` keeps a node's local numbers, so it jumps to the same offset under its new parent; `reparentChild` keeps its place in the world. [scene-graph](references/scene-graph.md)
- `view.root` holds the camera: clearing or hiding `view.root` makes rendering throw. Put level content under its own `Container3D` and clear that. [scene-graph](references/scene-graph.md)
- `getLocalBounds()` is in the node's own space and leaves out hidden children: for a world box use `getLocalBounds().applyMatrix4(node.getGlobalTransform())`. [math](references/math.md)
- `Vector3` math works in place (`a.add(b)` changes `a`; pass an `out` to keep it) and uses `subtract`, `multiplyScalar`, `magnitude` and `copyFrom`. A node's `position` is live, so copy what you keep. [math](references/math.md)
- A ground plane at height `h` is `new Plane(new Vector3(0, 1, 0), -h)` (note the minus), or `setFromNormalAndCoplanarPoint`. [math](references/math.md)

**Light and colour**

- Views default to `toneMapping: 'none'`, where lit colour clips above 1: set `toneMapping: 'aces'` for strong lights, HDR environments or bloom. [environment-and-sky](references/environment-and-sky.md)
- Porting from Three.js: a HemisphereLight(sky, ground, i) becomes `environment: { skyColor, groundColor, intensity: i / Math.PI }`; directional, point, spot and ambient intensities port 1:1. [from-threejs](references/from-threejs.md)
- Direct lights and `AmbientLight` are divided by π and the hemisphere is not: a sun near 3 and a hemisphere near 0.7 light `baseColor` fully, and an `AmbientLight` of 0.2 is barely visible. [scene-and-lighting](references/scene-and-lighting.md)
- Vertex colours are linear light: convert sRGB picks with `srgbToLinear`, or mid tones come out pale. [geometry](references/geometry.md)
- A view shades 32 lights and 16 shadow maps; past 256 casters the sun's shadow box is measured once, so call `sun.fitShadowBounds()` after the scene changes. [scene-and-lighting](references/scene-and-lighting.md)

**Surfaces**

- `alphaMode` defaults to `'opaque'`, which ignores `alpha` and texture alpha (transparent PNG texels draw black): set `'blend'` or `'mask'`. [materials](references/materials.md)
- A `'mask'` cut-out, or a shader bit that moves or discards vertices (`dissolveBit`), still casts the whole undisplaced shadow and outline: give it `castShadow: false` and `material.disablePass('outline')` if that shows. [materials](references/materials.md), [custom-shaders](references/custom-shaders.md)
- Images show upside down on `PlaneGeometry` unless `flipV: true`, and on `CubeGeometry` faces unless the material has `uvTransform: new Matrix(1, 0, 0, -1, 0, 1)` (`Matrix` from pixi.js). [from-threejs](references/from-threejs.md)
- A `ContainerTexture` on an opaque material draws black where the 2D is transparent: add a backdrop, `clearColor`, or `alphaMode: 'blend'`. [render-to-texture](references/render-to-texture.md)

**Models and animation**

- A glTF file's own node transforms already size it and stand it Y-up facing +Z: read `getLocalBounds()` before scaling and add no fix-up rotation. [models-and-animation](references/models-and-animation.md)
- A loaded model draws its source's materials, so a write to one changes every model from that file: give one model copies with `model.materials = (m) => m.clone()`, and build a changed loaded material with `clone(options)`, not `new Material3D`, which drops its textures. [models-and-animation](references/models-and-animation.md)
- Most bones aren't scene nodes, so `getChildByLabel('Hand', true)` returns null: use `model.skeletons[0]`. [models-and-animation](references/models-and-animation.md)
- Write into `mesh.weights`; assigning a new array disconnects it from the clips that animate it. [models-and-animation](references/models-and-animation.md)
- A `Mesh3D` with no geometry or material draws nothing and raises no error. [geometry](references/geometry.md)

**Input and cameras**

- `OrbitCamera`, `FPSCamera`, `ParticleSystem3D` and a model's animation `player` update themselves on `Ticker.shared`, not `app.ticker`, so their step can land after your frame's code or a frame late: pass `autoUpdate: false` and call `update(ticker)` from your `app.ticker` callback when order matters (`orbit.update()` returns `true` when the camera moved). [cameras](references/cameras.md)

- 3D nodes default to `eventMode: 'passive'`: set `'static'` (also a `Mesh3D` option) or nothing picks. `pointertap` fires for every mouse button, so check `e.button`. [picking-and-input](references/picking-and-input.md)
- A full-screen view hit-tests its whole rectangle, so it blocks clicks to 2D objects behind it: put interactive 2D above the view or set `view.hitArea`. [2d-and-3d-together](references/2d-and-3d-together.md)
- `OrbitCamera.enabled = false` only stops input; `update()` keeps re-aiming the camera, so also set `autoUpdate = false` (or `destroy()`) before moving the camera yourself. [cameras](references/cameras.md)
- `FPSCamera` walking follows the pitch, so looking down sinks the camera: re-pin `position.y` after `update()` for a ground walker. [cameras](references/cameras.md)

**Effects and render to texture**

- `BloomEffect`'s threshold is 1 in linear light: make glowing things `emissive` with `strength` above 1; a threshold near 0.5 blooms every lit surface. MSAA carries through effects, so add `FxaaEffect` only without `antialias`. [post-processing](references/post-processing.md)
- A camera feed shown on a mesh under a filmic curve (`'aces'`) goes through the curve twice and looks washed out; `format: 'rgba16float'` is the documented fix with bloom-style effects, but on a `FlatMaterial` monitor it currently draws too dark, so compare the screen with the scene by eye, or show the feed in a 2D `Sprite`. Make feeds with `antialias: true` or their edges are jagged. [render-to-texture](references/render-to-texture.md)
- Toggle effects with `enabled`; adding the first or removing the last pre-curve effect recompiles every material. [post-processing](references/post-processing.md)

**Particles**

- `ParticleContainer3D` shows nothing until `upload()` after `setParticleAt`. [particles](references/particles.md)

**Current library limitations** (workarounds until they're fixed)

- A glTF mesh without normals (Fox.glb is one) lights as if every face pointed +Z, black when it turns away: rebuild flat normals with `getAttributeData`. [from-threejs](references/from-threejs.md)
- `SphereGeometry` maps images mirrored left to right: `uvTransform: new Matrix(-1, 0, 0, 1, 1, 0)` plus `rotation.y = Math.PI` fixes it. [from-threejs](references/from-threejs.md)
- A `Sprite3D` created with no `position`, `scale` or `anchor` draws 1×1 units instead of its texture size until one of them changes: always pass a `position`. [2d-and-3d-together](references/2d-and-3d-together.md)

## Which reference to open

| job                                                                                                                                                                           | file                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| scene graph: parent and child, transforms, rotation vs quaternion, lookAt, local and world space, find by label, reparent, bounds and size, visibility, scene events, destroy | `references/scene-graph.md`          |
| vectors, quaternions, matrices, smooth turning, boxes, spheres, rays, planes, frustum tests, spherical orbits                                                                 | `references/math.md`                 |
| scene, ground, sun, point and spot lights, shadows                                                                                                                            | `references/scene-and-lighting.md`   |
| load a glTF, frame it, play and cross-fade clips, one model's own materials, dissolve, bones, morph targets                                                                   | `references/models-and-animation.md` |
| PBR, unlit, toon, emissive, transparency, textures                                                                                                                            | `references/materials.md`            |
| built-in geometries, custom vertex data, terrain, lines and points                                                                                                            | `references/geometry.md`             |
| thousands of instances, per-instance data, batching, LOD                                                                                                                      | `references/instancing.md`           |
| click, hover, drag, raycast, screen-to-world, keyboard                                                                                                                        | `references/picking-and-input.md`    |
| camera control, orbit, first-person, orthographic, clipping, follow                                                                                                           | `references/cameras.md`              |
| skybox, cubemaps, HDR (.hdr), image-based lighting, fog, tone mapping                                                                                                         | `references/environment-and-sky.md`  |
| bloom, SSAO, tilt-shift, motion blur, FXAA, effect order, scene resolution                                                                                                    | `references/post-processing.md`      |
| emitters, bursts, hand-driven particles                                                                                                                                       | `references/particles.md`            |
| second camera to a texture, live 2D on a surface, portals                                                                                                                     | `references/render-to-texture.md`    |
| HUD, labels, Sprite3D billboards, 2D filters and masks, several views, resolution                                                                                             | `references/2d-and-3d-together.md`   |
| shader bits, custom material effects                                                                                                                                          | `references/custom-shaders.md`       |
| port a Three.js app: paired program, differences that change the picture, full name tables                                                                                    | `references/from-threejs.md`         |

## If you know Three.js or the unrelated pixi3d package

| you may reach for                                        | use here                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `Scene`, `renderer.render`                               | `View3D` on `app.stage`; Pixi renders it                           |
| renderer.setAnimationLoop                                | `app.ticker.add`                                                   |
| PerspectiveCamera, OrthographicCamera                    | `view.camera`; `camera.mode = 'orthographic'` + `orthographicSize` |
| OrbitControls, CameraOrbitControl                        | `OrbitCamera` (extras)                                             |
| `Mesh(geometry, material)`, Mesh3D.createCube()          | `new Mesh3D({ geometry: new CubeGeometry(), material })`           |
| MeshStandardMaterial, StandardMaterial                   | `Material3D`                                                       |
| MeshBasicMaterial                                        | `FlatMaterial`                                                     |
| ShaderMaterial                                           | a `ShaderBit` in `extraBits`                                       |
| HemisphereLight, LightingEnvironment, ImageBasedLighting | the view's `environment`                                           |
| ShadowCastingLight                                       | `castShadow: true` on a light                                      |
| GLTFLoader, `Model.from`                                 | `Assets.load<Scene3DSource>` + `new Model3D({ source })`           |
| AnimationMixer                                           | `model.player`                                                     |
| InstancedMesh                                            | `BatchedMesh3D`                                                    |
| Raycaster                                                | pointer events on meshes, or `view.raycast`                        |
| Box3                                                     | `node.getLocalBounds()`                                            |
| EffectComposer                                           | `view.passes` with effects from extras                             |
| CSS2DRenderer                                            | Pixi `Text` on the stage + `worldToScreen`                         |

Every other Three.js name, and the behaviour that differs after a rename, is in `references/from-threejs.md`.
