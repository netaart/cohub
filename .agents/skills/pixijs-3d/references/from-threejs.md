Port a Three.js app to `@pixi/3d`: one app on both sides, the differences that compile but change the picture, and where the full name tables are.

## Porting order

1. Replace the renderer with an `Application` and one `View3D`; the view's options take tone mapping, shadow quality, fog and the hemisphere light.
2. Set the camera's `fov` and `far` on `view.camera`, then build `OrbitCamera` or `FPSCamera`.
3. Port lights, then materials and textures, then meshes, then models and animation.
4. Move the setAnimationLoop body into `app.ticker.add`, stepping controllers and animation players from it.
5. Read every line of "Differences that change the picture" against the source: each one compiles and runs, then draws or moves differently.

## Differences that change the picture

Read this list before porting: each line compiles after a plain rename and still changes the picture or the behaviour. The first group is the one ports most often get wrong.

Most often hit first. Each line is the fix.

**Light and shadow**

- HemisphereLight intensity: three divides it by π and the view's `environment` doesn't, so pass `intensity: i / Math.PI`. Directional, point, spot and ambient intensities port 1:1.
- No light targets: lights shine down their local −Z, so call `light.lookAt(target)` after setting the position and again after every move. An unrotated `DirectionalLight` shines horizontally; three's default shines straight down.
- Shadows are on by default: `Mesh3D` and `Model3D` cast and receive. Set `castShadow: false` on floors and terrain, which otherwise also stretch the auto-fitted shadow box.
- `shadow.bias` has the opposite sign: negate three's value or keep the default +0.001. `shadow.mapSize` is the view's `shadowQuality`; the shadow camera box is `shadow.bounds`, a world-space `Box`.

**Time and updates**

- `ticker.deltaTime` counts 60 fps frames: use `ticker.deltaMS / 1000` for getDelta(). `deltaMS` is capped at 100 ms (and scaled by `ticker.speed`), so below 10 fps motion slows; use `ticker.elapsedMS / 1000` where simulated time must keep up with the clock.
- `OrbitCamera`, `FPSCamera`, `model.player` and `ParticleSystem3D` step themselves on `Ticker.shared`, not `app.ticker`: pass `autoUpdate: false` and call `update(ticker)` from `app.ticker` where three called `controls.update()` or `mixer.update(dt)`.
- Camera defaults are fov 60 and far 1000 (three: 50 and 2000): set both.

**Colour and output**

- Tone mapping is off by default in both, and `'aces'` is the same curve. `exposure` scales light even under `'none'` (three ignores it there), so a NoToneMapping app ports with `exposure: 1`.
- `scene.background = colour`: under the default `toneMapping: 'none'` use `view.background = colour`, which draws it exactly inside the 3D picture, so post effects (vignette, bloom) and fog cover it as they do in three. Under a filmic curve `view.background` is tone-mapped and three's isn't: use `app.init({ backgroundColor })` for the exact colour, knowing it sits behind the view where the view's effects don't reach it.
- Fog mixes in linear light before the tone curve: partial fog looks lighter, and under `'aces'` the fog colour itself shifts.
- Output and texture decode use gamma 2.2, not piecewise sRGB: authored colours round-trip, dark lit surfaces come out a few levels brighter.
- `{ h, s, l }` colours are sRGB in pixi but linear in three's setHSL, so the same numbers come out more saturated. Three's `Color.lerp` mixes in linear light: run each channel through `srgbToLinear`, mix, then `linearToSrgb`. Vertex and per-instance colours are linear too.

**Materials and textures**

- `emissive` is an opt-in group whose colour defaults to white: pass emissive: { color, strength: emissiveIntensity, texture: emissiveMap } when three's emissive is non-black (with `strength: 0` if it lights up later). Built without it, `material.emissive` is `undefined`.
- `alphaMode` defaults to `'opaque'`, which ignores `alpha` and texture alpha and draws transparent PNG texels black: `transparent` → `'blend'`, alphaTest → `'mask'` with `alphaCutoff`.
- `'blend'` turns depth writes off; for `transparent` with depthWrite: true, set `material.state.depthMask = true` after `alphaMode`, then `mesh.invalidate()`.
- Images upload without three's `flipY`: `PlaneGeometry({ flipV: true })`; on `CubeGeometry`, `uvTransform: new Matrix(1, 0, 0, -1, 0, 1)`. A `RenderTexture` feed also needs `flipV: true`.
- Mipmaps are off by default: load tiled or distant textures with `Assets.load({ src, data: { autoGenerateMipmaps: true } })`, or they shimmer.
- `colorSpace` has no equivalent: base colour and emissive textures always decode as sRGB, every other slot as linear. `repeat` and `offset` become one `material.uvTransform` (a pixi.js `Matrix`) for every texture of that material.
- side: BackSide (`state.cullMode = 'front'`) keeps outward normals, so a lit interior goes dark: use `doubleSided: true`.

**Scene graph and models**

- `rotation` and `quaternion` aren't synced: glTF nodes and nodes after `lookAt` keep their rotation in `quaternion`, and `rotation.y += a` throws it away. Spin those with `quaternion.multiply(q.setFromAxisAngle(axis, a))`, or rotate a parent `Container3D`.
- `getLocalBounds()` is in the node's own space with its own transform left out (Box3.setFromObject is world space): multiply by the scale you apply instead of re-measuring, and set `origin` to pivot a turned model at its feet.
- No crossFadeTo, `fadeIn` or fadeOut: start the next state at `weight = 0` with `gotoAndPlay(0)` and ramp both weights in the ticker ([models-and-animation](models-and-animation.md)). `play()` stops nothing.
- Weights are relative shares, so a lone state at 0.3 plays in full, and a finished one-shot stops contributing: start its fade-out before it ends.
- setColorAt has no equivalent: give `BatchedMesh3D` an `instanceData` field, read it in a shader bit, write it with `setInstanceDataAt` ([instancing](instancing.md)). Every slot also needs `setGeometryAt`, `setMaterialAt` and `setPassesAt`, or it draws nothing.
- Geometry shapes: `TorusGeometry` lies in XZ (`rotation.x = Math.PI / 2` to match), cylinder and cone default to height 2, capsule `height` includes the caps. There's no `geometry.translate`: move the pivot into the matrix or `origin`.
- Geometry data is final once constructed: build per-frame vertex edits with `dynamic: true` and call `buffer.update()`.
- `Points` with a size, colour and alpha ShaderMaterial ports to `ParticleContainer3D.setParticleAt` with no shader: write size 0 into slots freed since the last frame (there's no setDrawRange), call `upload()` once per frame, and order blended containers by their `position` (there's no renderOrder) ([objects-and-animation](from-threejs/objects-and-animation.md#points-and-lines)).
- Picking: only nodes with `eventMode: 'static'` hit or block, against their bounding box unless `hitVolume: 'geometry'`. `view.screenToRay` takes pixels, not NDC. Listen with `view.on('pointermove', …)` and read `e.target3D` (the view's own `onpointermove` runs before the 3D dispatch), and check `e.button`: `pointertap` fires for every button ([picking-and-input](picking-and-input.md)).

**Effects and lifetime**

- UnrealBloomPass numbers don't carry over: `BloomEffect` thresholds the brightest channel with a soft knee. One port matched UnrealBloomPass(res, 0.5, 0.1, 0.2) with `new BloomEffect({ threshold: 0.3, intensity: 4.5, radius: 0.8, levels: 7 })`; retune by eye.
- A custom `PostEffect` runs before tone mapping by default; a ShaderPass that sat after `OutputPass` ports with `stage: 'afterToneMapping'` ([renderer-and-scene](from-threejs/renderer-and-scene.md#post-processing)).
- RoomEnvironment has no equivalent, and 8-bit cube faces light PBR models too dark: load an `.hdr`, or build `rgba16float` faces with values above 1.
- `destroy()` is final, unlike three's `dispose()`; `unload()` frees GPU memory and keeps the object usable. Destroy flags default to `false`: `mesh.destroy({ geometry: true, material: true, texture: true, textureSource: true })` frees everything down to the GPU image, and the view never destroys its passes.

**Current limitations**

- A glTF mesh without normals (Fox.glb is one) lights as if every face pointed +Z, and `flatShading` can't fix it. Rebuild flat normals from `getAttributeData(geometry, 'aPosition', 3)`, as addFaceNormals above does; an indexed mesh needs its triangles unshared first.
- `SphereGeometry` maps images mirrored left to right compared with three: `uvTransform: new Matrix(-1, 0, 0, 1, 1, 0)` plus `mesh.rotation.y = Math.PI` reproduces three's sphere exactly.

## A Three.js app and its port

The Three.js app: renderer, camera, OrbitControls, a hemisphere light and a shadowed sun, a textured ground, a box, an animated glTF fox, resize and the loop.

<!-- snippet-check: skip -->

```ts
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const FOX = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Fox/glTF-Binary/Fox.glb';
const GRASS = 'https://pixijs.com/assets/bg_grass.jpg';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9cc7ea);

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(4, 3, 8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xdfeeff, 0x5a5040, 1.2));
const sun = new THREE.DirectionalLight(0xfff4e0, 2.5);
sun.position.set(4, 8, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -6;
sun.shadow.camera.right = sun.shadow.camera.top = 6;
sun.shadow.bias = -0.0005;
scene.add(sun);

const grass = new THREE.TextureLoader().load(GRASS);
grass.colorSpace = THREE.SRGBColorSpace;
grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
grass.repeat.set(8, 8);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ map: grass, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const crate = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0xd9534f, roughness: 0.5, emissive: 0x330000 }),
);
crate.position.set(2, 0.5, 0);
crate.castShadow = true;
scene.add(crate);

const gltf = await new GLTFLoader().loadAsync(FOX);
const fox = gltf.scene;
const box = new THREE.Box3().setFromObject(fox);
fox.scale.setScalar(2 / box.getSize(new THREE.Vector3()).y);
fox.traverse((node) => {
  if ((node as THREE.Mesh).isMesh) node.castShadow = true;
});
scene.add(fox);
const mixer = new THREE.AnimationMixer(fox);
mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, 'Walk')!).play();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const timer = new THREE.Timer();
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = timer.getDelta();
  mixer.update(dt);
  crate.rotation.y += dt;
  controls.update();
  renderer.render(scene, camera);
});
```

The port. Comments mark every line that is more than a rename.

```ts
import {
  Box,
  CubeGeometry,
  DirectionalLight,
  Geometry3D,
  getAttributeData,
  Material3D,
  Mesh3D,
  Model3D,
  PlaneGeometry,
  Vector3,
  View3D,
} from '@pixi/3d';
import type { Scene3DSource } from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application, Assets, Matrix } from 'pixi.js';
import type { Texture } from 'pixi.js';

const FOX = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Fox/glTF-Binary/Fox.glb';
const GRASS = 'https://pixijs.com/assets/bg_grass.jpg';

const app = new Application();
await app.init({
  resizeTo: window, // replaces setSize and the resize listener
  antialias: true,
  resolution: Math.min(window.devicePixelRatio, 2), // setPixelRatio
  autoDensity: true,
  backgroundColor: 0x9cc7ea, // scene.background colour: the clear colour is never tone-mapped, like three's
});
document.body.appendChild(app.canvas);

const view = new View3D({
  autoResize: true, // the camera aspect follows the view; no updateProjectionMatrix
  toneMapping: 'aces', // the default is 'none'
  shadowQuality: 'high', // shadow.mapSize 2048, one setting for every light; casting lights replace shadowMap.enabled
  environment: { skyColor: 0xdfeeff, groundColor: 0x5a5040, intensity: 1.2 / Math.PI }, // HemisphereLight: divide by π
});
app.stage.addChild(view);

view.camera.fov = 45; // vertical degrees in both; the default is 60, not 50
view.camera.far = 100; // the default is 1000, not 2000
view.camera.position.set(4, 3, 8); // before OrbitCamera, which adopts the current offset
const orbit = new OrbitCamera({ view, target: { x: 0, y: 1, z: 0 }, enableDamping: true, autoUpdate: false });

const sun = new DirectionalLight({
  color: 0xfff4e0,
  intensity: 2.5, // direct light ports 1:1
  castShadow: true,
  position: { x: 4, y: 8, z: 5 },
  // shadow.camera's light-space box becomes a world-space box. bias stays at the default +0.001:
  // three's negative bias has the opposite sign here.
  shadow: { bounds: Box.fromCenterSize({ x: 0, y: 1, z: 0 }, { x: 12, y: 4, z: 12 }) },
});
sun.lookAt({ x: 0, y: 0, z: 0 }); // no target: aim the light's -Z, again after every move
view.root.addChild(sun);

// Mipmaps are off by default. Base colour textures decode as sRGB whatever the texture, so no colorSpace.
const grass = await Assets.load<Texture>({ src: GRASS, data: { autoGenerateMipmaps: true } });
grass.source.style.addressMode = 'repeat'; // wrapS, wrapT
grass.source.style.update();
view.root.addChild(
  new Mesh3D({
    geometry: new PlaneGeometry({ width: 40, height: 40 }),
    // texture.repeat lives on the material, for all its textures
    material: new Material3D({ baseColorTexture: grass, roughness: 0.95, uvTransform: new Matrix().scale(8, 8) }),
    rotation: { x: -Math.PI / 2, y: 0, z: 0 },
    castShadow: false, // meshes cast and receive by default
  }),
);

const crate = new Mesh3D({
  geometry: new CubeGeometry({ width: 1, height: 1, depth: 1 }),
  // emissive is an opt-in group whose colour defaults to white; emissiveIntensity is its strength
  material: new Material3D({ baseColor: 0xd9534f, roughness: 0.5, emissive: { color: 0x330000, strength: 1 } }),
  position: { x: 2, y: 0.5, z: 0 },
});
view.root.addChild(crate);

// Fox.glb has no normals, and @pixi/3d lights such a mesh as if every face pointed +Z (a current
// limitation). Its triangles share no vertices, so each vertex takes its face's normal.
function addFaceNormals(mesh: Mesh3D): void {
  const old = mesh.geometry;
  const positions = getAttributeData(old, 'aPosition', 3);
  const normals = new Float32Array(positions.length);
  const a = new Vector3();
  const ab = new Vector3();
  const ac = new Vector3();
  for (let i = 0; i < positions.length; i += 9) {
    a.fromArray(positions, i);
    ab.fromArray(positions, i + 3).subtract(a);
    ac.fromArray(positions, i + 6).subtract(a);
    ab.cross(ac).normalize();
    for (let v = 0; v < 9; v += 3) ab.toArray(normals, i + v);
  }
  mesh.geometry = new Geometry3D({
    positions,
    normals,
    uvs: old.attributes.aUV,
    joints: old.attributes.aJoints,
    weights: old.attributes.aWeights,
  });
}

const source = await Assets.load<Scene3DSource>(FOX);
// gltf.scene + AnimationMixer + clipAction('Walk').play(). autoUpdate: false steps the player from
// app.ticker below, like mixer.update(dt); by default it runs on Ticker.shared.
const fox = new Model3D({ source, autoPlay: 'Walk', autoUpdate: false });
fox.traverse((node) => {
  if (node instanceof Mesh3D && !node.geometry.attributes.aNormal) addFaceNormals(node);
});
fox.scale.set(2 / fox.getLocalBounds().height); // Box3.setFromObject: bounds in the model's own space
view.root.addChild(fox); // Model3D casts shadows by default, so no traverse for castShadow

app.ticker.add((ticker) => {
  const dt = ticker.deltaMS / 1000; // deltaTime counts frames; deltaMS is capped at 100
  fox.player?.update(ticker);
  crate.rotation.y += dt;
  orbit.update(ticker);
});
```

## Full tables

Open the page for the area you are porting. Each maps Three.js to `@pixi/3d` property by property and ends with what has no equivalent.

| porting                                                                                                                                                                       | page                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| renderer, loop and time, scene background and fog, cameras, OrbitControls, PointerLockControls, render targets, EffectComposer and ShaderPass, CSS2D labels, sprites, dispose | [from-threejs/renderer-and-scene.md](from-threejs/renderer-and-scene.md)       |
| materials and their properties, textures, colour space, lights, shadows                                                                                                       | [from-threejs/materials-and-lights.md](from-threejs/materials-and-lights.md)   |
| Object3D, maths, BufferGeometry, built-in geometries, InstancedMesh, lines and points, Raycaster, GLTFLoader, AnimationMixer, bones, morph targets                            | [from-threejs/objects-and-animation.md](from-threejs/objects-and-animation.md) |
