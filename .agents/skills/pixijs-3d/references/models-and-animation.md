Load glTF/GLB files, size them, and play, switch and cross-fade their animation clips.

## Quick Start

`Assets.load<Scene3DSource>` gives a shared template; `new Model3D(source)` builds a node you add to the view. Keys 1/2/3 cross-fade between the fox's clips.

```ts
import { DirectionalLight, Model3D, View3D } from '@pixi/3d';
import type { AnimationState, Scene3DSource } from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application, Assets } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: 0x20232a, antialias: true });
document.body.appendChild(app.canvas);

const view3d = new View3D({ autoResize: true, environment: { skyColor: 0xdde8ff, groundColor: 0x443322 } });
app.stage.addChild(view3d);

const sun = new DirectionalLight({ intensity: 3 });
sun.rotation.set(-Math.PI / 4, Math.PI / 6, 0); // lights shine down their local -Z
view3d.root.addChild(sun);

// A .glb or .gltf URL loads to a Scene3DSource: a shared template, never added to the view itself
const source = await Assets.load<Scene3DSource>(
  'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/main/2.0/Fox/glTF-Binary/Fox.glb',
);
const fox = new Model3D(source);
view3d.root.addChild(fox);

// Files come in any unit (the fox is ~80 units tall). Scale uniformly to 2 units tall,
// then stand it on y = 0, centred on X/Z. Bounds are local, so multiply by the scale.
const bounds = fox.getLocalBounds();
const size = bounds.getSize();
const center = bounds.getCenter();
const s = 2 / size.y;
fox.scale.set(s, s, s);
fox.position.set(-center.x * s, -bounds.min.y * s, -center.z * s);

view3d.camera.position.set(0, 1.5, 5);
new OrbitCamera({ view: view3d, target: { x: 0, y: 1, z: 0 }, enableDamping: true });

// player is undefined when the file has no animations
const player = fox.player;
if (!player) throw new Error('Fox.glb has no animations');

const labels = player.animationLabels; // Fox: ['Survey', 'Walk', 'Run']

let current: AnimationState = player.play(labels[0]); // loops by default
let fadingOut: AnimationState | null = null;
let fade = 1;
const FADE_SECONDS = 0.3;

const crossFadeTo = (label: string): void => {
  const next = player.getState(label);
  if (next === current) return;
  if (fadingOut) fadingOut.stop(); // drop a fade already in progress
  fadingOut = current;
  current = next;
  current.weight = 0;
  current.gotoAndPlay(0);
  fade = 0;
};

// Keys 1..n switch clips
window.addEventListener('keydown', (e) => {
  const label = labels[Number(e.key) - 1];
  if (label) crossFadeTo(label);
});

app.ticker.add((ticker) => {
  if (!fadingOut) return;
  fade = Math.min(1, fade + ticker.deltaMS / 1000 / FADE_SECONDS);
  current.weight = fade; // weights are relative shares of the blend
  fadingOut.weight = 1 - fade;
  if (fade === 1) {
    fadingOut.stop();
    fadingOut.weight = 1;
    fadingOut = null;
  }
});
```

`model.player` is the model's `AnimationPlayer`, `undefined` when the file has no clips. `player.play(label)` returns that clip's `AnimationState`, which holds `time`, `loop` (default `true`), `animationSpeed`, `weight`, `playing`, `onComplete` and `onLoop`. The player advances on `Ticker.shared` by itself; you don't call `update()` unless you turn `autoUpdate` off. There is no AnimationMixer, clipAction or crossFadeTo: a cross-fade is two playing states whose weights you ramp, as above.

## autoPlay and other build options

`Model3D` takes the source alone or a `Model3DOptions` object with `source` in it. `autoPlay: true` plays the first clip; a string plays that label.

```ts
const walker = new Model3D({ source, autoPlay: 'Walk', castShadow: false, label: 'walker', parent: view3d.root });
Model3D.defaultOptions.autoPlay = true; // every later Model3D starts its first clip

const runSeconds = source.animations['Run'].duration; // clips by name on the source; unnamed ones are 'anim_<index>'
```

A file's own cameras are in `model.cameras` (`view3d.camera = model.cameras[0]` once the model is in the view), its lights load as light nodes that cast no shadow until you set `castShadow`, and `new Model3D({ source, scene: 'night' })` builds another of its scenes (names in `Object.keys(source.scene)`). For a viewer of one file, `View3D.from(source, { autoResize: true })` builds the model as `view.root`, looks through the file's first camera or frames a new one on the model, and adds a light when the file has none.

## Switching clips: play() does not stop the others

`player.play('Run')` starts Run and leaves every clip that was already playing running, so they blend at equal weight. To cut, stop first. One-shot clips: set `loop = false` and restart with `gotoAndPlay(0)`.

```ts
player.stop(); // stops every state, each holding its pose
player.play('Run');

const survey = player.getState('Survey'); // the state, without starting it
survey.loop = false;
survey.onComplete = () => player.play('Walk'); // the state has already stopped here
player.stop();
survey.gotoAndPlay(0); // state.play() on a one-shot that already finished just completes again
```

`weight` is a relative share between states driving the same property, not a fade against the rest pose: a state that is the only one driving a bone applies in full at any weight above 0. `state.stop()` freezes, `gotoAndStop(t)` stops and shows that clip's pose at `t`, writing `state.time` moves the playhead without applying it. A negative `animationSpeed` plays backwards.

## Sizing: scale uniformly from the bounds

Files arrive in any unit (the fox is 80 units tall; others come in metres or centimetres). `getLocalBounds()` returns a `Box` (`min`, `max`, `width`, `height`, `depth`, `getCenter()`) in the model's own space, ignoring its own transform, so multiply by the scale you apply. Hidden children are left out. `model.getSize()` returns `{ width, height, depth }` with the model's scale included; to fit the largest side to 2 units, `model.scale.set(2 / Math.max(width, height, depth))` (one number sets all three axes).

`model.setSize(2)`, `model.height = 2` and the `width`/`height`/`depth` options set each axis independently, so they stretch a model whose sides differ. Use them for boxes, not characters. Skinned meshes measure in their bind pose, not the animated pose, and the bounds are recomputed by walking the subtree on every call, so measure once after loading. A model faces local +Z, which is also what `lookAt` aims; cameras and lights aim -Z. The loader applies the file's own node transforms, so a glTF model already stands Y-up and faces +Z as the glTF spec defines it, and a camera on +Z sees its front: add no fix-up rotation.

## Many models from one source, and changing one

A `Model3D` is cheap: geometry, materials and textures stay on the source and are shared. Each model gets its own player, so instances animate independently.

```ts
for (let i = 0; i < 5; i++) {
  const f = new Model3D({ source, scale: 0.02, position: { x: (i - 2) * 2, y: 0, z: 0 }, parent: view3d.root });
  const walk = f.player?.getState('Walk');
  if (walk) walk.gotoAndPlay((walk.animation.duration * i) / 5); // stagger so they don't march in step
}

source.material['fox_material'].baseColor = 0xff8844; // materials by name in the file; shared, so every fox changes

const fox = new Model3D({ source, scale: 0.02, parent: view3d.root });
const ghost = new Material3D({ baseColor: 0x88ccff, alphaMode: 'blend', alpha: 0.4 });
fox.materials = { fox_material: ghost }; // this model only, by the file's material name
fox.materials = (material) => material.clone({ alphaMode: 'blend', alpha: 0.4 }); // or a copy of each, textures kept
const wheels = model.getChildrenByLabel(/^Wheel/, true); // labels are the file's node names; true searches deep
```

`model.materials` (also a `Model3D` and `View3D.from` option) gives one model materials of its own: a record by material `label` (the loader sets it to the name in the file), an array by index into `source.materials` (an empty entry keeps the source's), or a function called once per distinct source material, so meshes that shared one share its copy. Read, it lists what the model draws, which is `source.materials` itself until you assign; assigning `undefined` goes back to it. Assigning switches every mesh still under the model at once, overwriting a material you set on one by hand; a mesh you moved out of the model keeps its own. Assigning never destroys what it replaces: take the copies a function made from `model.materials` and `destroy()` them before you assign again.

`traverse` visits the model and every node under it. A search walks the tree, so search once and keep the result. `model.destroy({ children: true })` removes a model and its player but never the source; `await Assets.unload(url)` destroys the source and its textures.

## Dissolve one model

`dissolveBit` from `@pixi/3d/extras` cuts a surface away in noisy holes with a glowing edge, on any material. Add it to copies, so the other models from the source stay whole:

```ts
const enemy = new Model3D({ source, castShadow: false, parent: view3d.root });
enemy.materials = (material) => material.clone({ extraBits: [dissolveBit] });
const holeSize = enemy.getLocalBounds().height / 8; // stored units; 0 means 0.25
for (const material of enemy.materials) {
  material.data.dissolveEdgeColor = [6, 2, 0.4]; // linear light; black: no edge
  material.data.dissolveHoleSize = holeSize;
}

let progress = 0;
const dissolveStep = (ticker: Ticker): void => {
  progress = Math.min(1, progress + ticker.deltaMS / 1500);
  for (const material of enemy.materials) material.data.dissolve = progress; // 0 whole, 1 gone
  if (progress < 1) return;
  app.ticker.remove(dissolveStep);
  for (const material of enemy.materials) material.destroy(); // the copies; textures stay on the source
  enemy.destroy({ children: true });
};
app.ticker.add(dissolveStep);
```

- `dissolveHoleSize` is in the mesh's stored units, before any scale, so holes stay put as it animates. The 0.25 default suits a model about 2 units tall and speckles a bigger one (the Fox is 80): size it from `getLocalBounds()`, which ignores the model's own scale too.
- Shadows and outlines draw the whole mesh: build dissolving models with `castShadow: false`, and take a copy out of an outline with `material.disablePass('outline')`.

## Bones and morph targets

A bone is a scene node only when a mesh hangs under it, so `getChildByLabel` usually does not find one. `model.skeletons[0]` holds every bone's local pose in flat arrays indexed by `indexOf(name)`: `localPosition` and `localScale` take 3 floats a bone, `localRotation` a quaternion of 4. A playing clip rewrites the bones it drives on each update, so build with `autoUpdate: false` (also the way to pause or run a fixed step), update the player yourself, then write over the clip's pose and set `dirty`:

```ts
const rig = new Model3D({ source, autoUpdate: false, autoPlay: 'Survey', parent: view3d.root });
const skeleton = rig.skeletons[0];
const head = skeleton.indexOf('b_Head_05') * 4; // Fox.glb's bone names
const pose = new Quaternion();
const turn = new Quaternion();

app.ticker.add((ticker) => {
  rig.player?.update(ticker); // the clip poses the bones first
  turn.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.sin(ticker.lastTime / 500) * 0.5); // about the bone's own axes
  pose.fromArray(skeleton.localRotation, head).multiply(turn).toArray(skeleton.localRotation, head);
  skeleton.dirty = true;
});
```

`skeleton.setLocalTRS(i, tx, ty, tz, qx, qy, qz, qw, sx?, sy?, sz?)` sets one bone's whole local pose and marks the skeleton dirty in one call; scale defaults to 1, so leaving it out resets any scale, and the quaternion must be unit length.

Morph targets (blend shapes) load as a `Mesh3D` whose `weights` is a `Float32Array`, one per target: `const face = model.getChildByLabel('Face', true)`, then `if (face instanceof Mesh3D && face.weights) face.weights[0] = 0.8`. Write into that array rather than assigning a new one; a playing clip that animates the weights overwrites them each update.

## Loading from a File

A `blob:` URL from a dropped file has no extension, so name the parser: `Assets.load<Scene3DSource>({ src: url, parser: 'glb' })` (`'gltf'` for text glTF). A `.gltf` loads its `.bin` and images relative to its URL; a `.glb` loads only what is packed inside it. KTX2 textures need `import 'pixi.js/ktx2'`.
