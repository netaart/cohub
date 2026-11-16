# Particles

Use this for fire, smoke, sparks, snow and impacts. `ParticleSystem3D` (from `@pixi/3d/extras`) simulates them for you. `ParticleContainer3D` (from `@pixi/3d`) is a pool of quads that you position yourself.

## Quick Start

```ts
import { View3D } from '@pixi/3d';
import { ConeShape, OrbitCamera, ParticleSystem3D } from '@pixi/3d/extras';
import { Application, Texture } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: 0x07070c, antialias: true });
document.body.appendChild(app.canvas);

const view3d = new View3D({ autoResize: true });
app.stage.addChild(view3d);
view3d.camera.position.set(0, 2, 6);
new OrbitCamera({ view: view3d, target: { x: 0, y: 1, z: 0 }, enableDamping: true });

// The default particle texture is a hard white square; draw a soft dot.
const canvas = document.createElement('canvas');
canvas.width = canvas.height = 128;
const ctx = canvas.getContext('2d')!;
const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
g.addColorStop(0, 'rgba(255,255,255,1)');
g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
g.addColorStop(1, 'rgba(255,255,255,0)');
ctx.fillStyle = g;
ctx.fillRect(0, 0, 128, 128);
const dot = Texture.from(canvas);

// Continuous emission. [min, max] ranges are drawn per particle at spawn. Particles draw unlit: no lights needed.
const flames = new ParticleSystem3D({
  texture: dot,
  blendMode: 'add', // glows; overlaps brighten
  billboard: 'cylindrical', // stays upright when the camera tilts
  capacity: 500,
  emitRate: 110, // particles per second
  shape: new ConeShape({ angle: 12, radius: 0.25 }), // sprays up +Y
  life: [0.5, 1], // seconds
  speed: [1.5, 2.3], // units per second along the shape's direction
  size: [0.5, 0.85],
  sizeEnd: [0.05, 0.2], // world-space diameter, ramped over life
  alpha: 0.7,
  alphaEnd: 0,
  color: 0xffd98a,
  colorEnd: 0xd12b06,
  drag: 1.6,
  position: { x: 0, y: 0.1, z: 0 },
  parent: view3d.root,
});
for (let i = 0; i < 60; i++) flames.update(); // prewarm one second, so the fire is burning on the first frame

// Systems step themselves; the ticker only changes settings.
let t = 0;
app.ticker.add((ticker) => {
  t += ticker.deltaMS / 1000;
  flames.emitRate = 80 + 70 * (0.5 + 0.5 * Math.sin(t * 9.3) * Math.sin(t * 4.1));
});
```

A `ParticleSystem3D` is configured by its options, which also take `Container3D` options such as `position` and `parent`. It steps itself from `Ticker.shared`, and the motion runs in the vertex shader, so it costs no per-particle CPU work and draws in one call. `alpha`, `color` and `size` set the spawn values, and `alphaEnd`, `colorEnd` and `sizeEnd` ramp to new values over each particle's life. Omit an `*End` to hold the spawn value.

Colours draw as authored under the view's default `toneMapping: 'none'`, and a `color` to `colorEnd` ramp blends the way a 2D tween does. Under a tone curve (`'aces'`, `'reinhard'`) particles go through it like every other material, so saturated additive colours shift; author them for the view's curve.

## Bursts, one-shots and spawning at a point

```ts
// Burst-only: emitRate 0, so only spawn() and bursts emit. Positive gravity pulls down.
const impact = new ParticleSystem3D({
  texture: dot,
  blendMode: 'add',
  capacity: 300,
  emitRate: 0,
  shape: new SphereShape({ radius: 0 }), // fires outward in every direction
  life: [0.3, 0.6],
  speed: [3, 6],
  size: 0.08,
  sizeEnd: 0,
  alphaEnd: 0,
  gravity: 9.8,
  parent: view3d.root,
});
const groundPlane = new Plane(new Vector3(0, 1, 0), 0); // Plane, Vector3 from '@pixi/3d'
view3d.on('pointerdown', (e) => {
  const hit = view3d.screenToWorld(e.global, groundPlane);
  if (hit) impact.spawn(40, { position: hit, color: 0xffcc66 });
});

const sparks = new ParticleSystem3D({ texture: dot, emitRate: 0, bursts: [{ time: 0.5, count: 80, repeatEvery: 2 }] });
const boom = new ParticleSystem3D({ texture: dot, emitRate: 0, autoPlay: false, bursts: [{ time: 0, count: 200 }] });
boom.gotoAndPlay(0); // fire, or re-fire, the burst timeline from the start
```

- `spawn()` can override `sizeEnd`, `alphaEnd`, `colorEnd` and `spin` only on a system that was built with those options. On any other system it throws.
- `capacity` (default 1000) is fixed at construction, and overflow recycles the oldest particles. Size it to about `emitRate × max life` plus your bursts.
- `stop()` stops emitting and lets live particles finish their lives. `clear()` kills every particle at once. `play()` resumes emission.

## Shapes, direction and gravity

Every shape emits along local **+Y**, not -Z as cameras and lights face. `ConeShape({ angle, radius })` sprays within `angle` degrees of +Y. `SphereShape({ radius, shell })` fires outward. `BoxShape({ width, height, depth })` fills a volume. The default `PointShape` fires straight up. To aim a spray, rotate the system:

```ts
const jet = new ParticleSystem3D({ texture: dot, shape: new ConeShape({ angle: 8 }), speed: 6, emitRate: 60 });
jet.rotation.z = -Math.PI / 2; // tip the +Y spray over to +X
const embers = new ParticleSystem3D({ texture: dot, gravity: -0.7 }); // number = downward pull; negative rises
embers.gravity = { x: 1.5, y: -2, z: 0 }; // assign a new value; mutating the returned vector does nothing
const snowfall = new BoxShape({ width: 10, height: 0.2, depth: 10 });
const snow = new ParticleSystem3D({ texture: dot, shape: snowfall, speed: 0, gravity: 0.6, drag: 1.2 });
snow.position.y = 6;
```

`speed` defaults to 0. With no `speed` and no `gravity`, particles stay where they spawn. With both, a particle settles at a falling speed of `gravity / drag`. Live settings: `emitRate`, `shape`, `gravity`, `drag`, `frameRate`, `blendMode`, and each burst object's `count` and `repeatEvery`. Fixed at construction: `capacity`, `billboard`, `frameMode`, `space` and the list of bursts. Particles default to `space: 'world'`, so they stay behind as the emitter moves. For exhaust that should travel with a moving parent, use `space: 'local'` and add the system to that parent with `ship.addChild(exhaust)`.

## Textures, blending and facing

```ts
const sheetTexture = await Assets.load<Texture>('rings.png'); // 6 frames of 128 px in a row
const frames = Array.from(
  { length: 6 },
  (_, i) => new Texture({ source: sheetTexture.source, frame: new Rectangle(i * 128, 0, 128, 128) }),
);
const rings = new ParticleSystem3D({
  texture: frames,
  frameMode: 'overLife', // flipbook: 'random' (default) | 'animate' (+ frameRate) | 'overLife'
  billboard: 'horizontal', // lies flat on the XZ ground plane
  emitRate: 0,
  bursts: [{ time: 0, count: 1, repeatEvery: 0.6 }],
  life: 1.5,
  size: 1,
  sizeEnd: 4,
  alphaEnd: 0,
});
const leaves = new ParticleSystem3D({
  texture: dot,
  alphaMode: 'mask',
  alphaCutoff: 0.3,
  startRotation: [0, Math.PI * 2],
});
```

- All flipbook frames must share one `TextureSource` (one sheet, or a `Spritesheet`'s `animations`), because the whole system is drawn in one call.
- `blendMode` takes `'normal'` (smoke, dust), `'add'` (fire, sparks, magic), `'multiply'` (dark wisps) or `'screen'`. It only applies under the default `alphaMode: 'blend'`. Use `alphaMode: 'mask'` for hard-edged cutouts that write depth and need no sorting.
- `billboard` takes `'spherical'` (default, faces the camera), `'cylindrical'` (stays upright) or `'horizontal'` (lies on the ground). The mesh `billboardMode` property is refused on particles.
- `spin` is in radians per second and `startRotation` is the starting angle. The node's own `rotation` turns the emitter, not the particles.

## Stepping manually

`ParticleSystem3D` updates itself from `Ticker.shared`, which a default `Application` runs separately from `app.ticker`, so a new particle can show one frame late. To control timing, build the system with `autoUpdate: false` and call `app.ticker.add((ticker) => steam.update(ticker))`. `update()` with no ticker steps 1/60 s, which is how to prewarm. Assigning `system.time = seconds` scrubs every particle to that moment.

## Hand-driven particles: ParticleContainer3D

This class has no simulation. You write each slot yourself, then call `upload()` **once per frame after all writes**. Until you do, nothing changes on screen. Positions are in world space unless the container is built with `space: 'local'`. A slot with size 0 draws nothing, and `clear()` empties every slot. `setParticleAt` packs the colour on every call. For a fixed tint, call `packParticleColor` once and write the slots with `writePacked`.

```ts
import { packParticleColor, ParticleContainer3D } from '@pixi/3d';

const COUNT = 2000;
const swarm = new ParticleContainer3D({ texture: dot, capacity: COUNT, blendMode: 'add', parent: view3d.root });
const blue = packParticleColor(0x66ccff, 0.8); // pack a fixed tint once

let t = 0;
app.ticker.add((ticker) => {
  t += ticker.deltaMS / 1000;
  for (let i = 0; i < COUNT; i++) {
    const a = (i / COUNT) * Math.PI * 2 + t * 0.5;
    const x = Math.cos(a) * 2;
    const y = Math.sin(a * 3 + t);
    const z = Math.sin(a) * 2;
    if (i % 2) swarm.writePacked(i, x, y, z, 0.06, 0, blue);
    else swarm.setParticleAt(i, x, y, z, 0.08, 0, 0xffaa33, 1); // size, rotation, color, alpha
  }
  swarm.upload(); // once per frame, after every write
});
```
