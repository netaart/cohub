# Post-processing

Full-screen effects on a `View3D`: bloom, ambient occlusion, tilt-shift, motion blur, tint, FXAA. Effects come from `@pixi/3d/extras` and go in the view's `passes` array, never in pixi `filters`.

## Quick Start

```ts
import { DirectionalLight, Material3D, Mesh3D, PlaneGeometry, SphereGeometry, View3D } from '@pixi/3d';
import { BloomEffect, OrbitCamera, SsaoEffect } from '@pixi/3d/extras';
import { Application } from 'pixi.js';

const app = new Application();
// antialias carries through post effects: the scene keeps the canvas's MSAA.
await app.init({ resizeTo: window, backgroundColor: 0x0b0d12, antialias: true });
document.body.appendChild(app.canvas);

// Both read the scene as linear light, before the view's tone curve, in array order.
const ssao = new SsaoEffect({ radius: 0.5, intensity: 1.2 });
const bloom = new BloomEffect({ intensity: 1.5, radius: 0.7 });

const view3d = new View3D({
  autoResize: true,
  environment: { skyColor: 0x223344, groundColor: 0x0a0a0a },
  passes: [ssao, bloom],
});
app.stage.addChild(view3d);

view3d.camera.fov = 40;
view3d.camera.position.set(0, 4, 11);
new OrbitCamera({ view: view3d, target: { x: 0, y: 0.6, z: 0 }, enableDamping: true });

// Lit surfaces stay below 1, under bloom's default threshold, so only emissive light glows.
const key = new DirectionalLight({ color: 0xffffff, intensity: 0.8 });
key.position.set(4, 8, 6);
key.lookAt({ x: 0, y: 0, z: 0 });
view3d.root.addChild(key);

const sphere = new SphereGeometry({ radius: 0.5, widthSegments: 32, heightSegments: 24 });
const colors = [0xff4d3d, 0xffa62b, 0x7cff5e, 0x38e6ff, 0x5c7cff, 0xe25cff];
const orbs: Mesh3D[] = [];

for (let i = 0; i < colors.length; i++) {
  const angle = (i / colors.length) * Math.PI * 2;
  // Emissive strength past 1 is light brighter than white: that is what blooms.
  const orb = new Mesh3D({
    geometry: sphere,
    material: new Material3D({ baseColor: 0x101010, emissive: { color: colors[i], strength: 3 } }),
  });
  orb.position.set(Math.cos(angle) * 3.5, 0.6, Math.sin(angle) * 3.5);
  view3d.root.addChild(orb);
  orbs.push(orb);
}

const plain = new Mesh3D({ geometry: sphere, material: new Material3D({ baseColor: 0x9aa4b0, roughness: 0.6 }) });
plain.position.set(0, 0.5, 0);
view3d.root.addChild(plain);

// PlaneGeometry lies in XY facing +Z: rotate it to make a floor.
const floor = new Mesh3D({
  geometry: new PlaneGeometry({ width: 24, height: 24 }),
  material: new Material3D({ baseColor: 0x2a303a, roughness: 0.85 }),
});
floor.rotation.set(-Math.PI / 2, 0, 0);
view3d.root.addChild(floor);

// Settings toggles: flipping `enabled` rebuilds the render graph once.
window.addEventListener('keydown', (e) => {
  if (e.key === '1') ssao.enabled = !ssao.enabled;
  if (e.key === '2') bloom.enabled = !bloom.enabled;
});

let time = 0;
app.ticker.add((ticker) => {
  time += ticker.deltaMS / 1000;
  // Effect properties are uniform writes: safe to animate every frame.
  bloom.intensity = 1.5 + Math.sin(time * 2) * 0.5;
  for (let i = 0; i < orbs.length; i++) {
    orbs[i].position.y = 0.6 + Math.sin(time * 1.3 + i * 1.1) * 0.35;
  }
});
```

## Linear light and the tone curve

A view's default `toneMapping` is `'none'`: the sRGB encode alone, so colours show as authored and anything brighter than 1 clips to white. Bloom, SSAO, tilt-shift, motion blur and custom effects run at the `'beforeToneMapping'` stage: the scene draws as linear light into a float texture, the effects see brightness above 1, and an output pass applies the curve once at the end. `TintEffect` and `FxaaEffect` run at `'afterToneMapping'`, on the picture as it shows.

Set `toneMapping: 'aces'` (or `'reinhard'`, `'uncharted2'`) when strong emissive or lights push colour past 1 and glow cores clip to flat white. A filmic curve rolls bright light off, and it also shifts and darkens ordinary colours.

## Making things bloom

`BloomEffect`'s `threshold` defaults to `1`, white in linear light, with a soft knee from half the threshold to one and a half times it. Give glowing objects an `emissive` group with `strength` past 1 on a near-black `baseColor`, and keep ordinary lighting under 1. Lower `threshold` (around `0.5`) for a hazy look where bright lit surfaces glow too.

```ts
const glow = new Material3D({ baseColor: 0x101010, emissive: { color: 0x38e6ff, strength: 4 } });
// Runtime control exists only if the material was built with an `emissive` group.
if (glow.emissive) glow.emissive.strength = 6;
```

`material.emissive` is `undefined` on a material created without `emissive`; build a new material to add glow. `threshold`, `intensity` and `radius` can change every frame. `levels` and `resolution` are fixed at construction: build a new effect, assign a new `passes` array, and call `destroy()` on the old one (same for `SsaoEffect`'s `resolution` and `sceneNormals`).

## Toggling and replacing effects

Three levers, from cheapest to most expensive:

```ts
bloom.threshold = 0.4; // uniform write, every frame is fine
ssao.enabled = false; // rebuilds the graph once: a settings toggle
view3d.passes = [bloom]; // new array: rebuilds the graph
view3d.passes = []; // no enabled post effect: renders straight to screen
```

`view3d.passes` is a `readonly Pass3D[]` copied on assignment; mutating it in place does nothing, so assign a new array. Replacing the list never destroys the effects, and one instance can serve several views. Animate an effect's own properties, and keep `enabled` for toggles.

## Ordering

Effects run stage by stage: every `'beforeToneMapping'` effect in array order, then the tone curve, then every `'afterToneMapping'` effect in array order. Array order matters only within one stage. Put `SsaoEffect` before `BloomEffect` so occlusion darkens the light before it glows, and `FxaaEffect` last among the after-curve effects. Non-post passes in the same array (`OutlinePass`, `MeshPass`, `PortalPass`) run at their own stage, so their position does not matter. Move one instance with `stage`: `new TintEffect({ tint: 0xffaa66, stage: 'beforeToneMapping' })` tints the light rather than the picture.

## Anti-aliasing

With `antialias: true` on `app.init`, the scene stays multisampled through post effects, so most apps need no `FxaaEffect`. Add `new FxaaEffect()` last in `passes` when the canvas has `antialias: false`, or alongside `new SsaoEffect({ sceneNormals: true })` on WebGL, where the normals attachment turns the scene's MSAA off.

## Tilt-shift

`TiltShiftEffect` keeps a band of depth sharp and blurs the rest, for a miniature look from a high, angled camera. Distances are in view units from the camera. Tie `focalDepth` to the orbit distance so the target stays sharp while zooming, and use `debug` to see the bands.

```ts
import { OrbitCamera, TiltShiftEffect } from '@pixi/3d/extras';

const tiltShift = new TiltShiftEffect({ focalDepth: 20, focalNear: 1.5, focalFar: 7, maxBlur: 12 });
view3d.passes = [tiltShift];
const orbit = new OrbitCamera({ view: view3d, target: { x: 0, y: 0, z: 0 } });

app.ticker.add(() => {
  tiltShift.focalDepth = orbit.distance; // focal plane follows the orbit target
});
tiltShift.debug = true; // white line = focal plane, green = sharp band, orange/blue = blur
```

Within `focalNear` of the plane stays sharp; the blur grows to `maxBlur` physical pixels at `focalFar`. Taps are weighed by depth, so a sharp object doesn't smear onto a blurred background. It samples a mip chain of its input: a mipmap generation per frame and a third more memory.

## Other effects

```ts
import { MotionBlurEffect, SsaoEffect, TintEffect } from '@pixi/3d/extras';

new MotionBlurEffect({ intensity: 0.5 }); // camera motion only; call camera.resetHistory() on a cut
new SsaoEffect({ radius: 0.5, fadeDistance: [40, 80] }); // fades out with depth, skips far pixels
new TintEffect({ tint: 0xffd9b3 }); // multiplies the finished picture
```

## Lower scene resolution

`View3D.resolution` draws the scene at fewer texels and stretches it back at the end, for dynamic resolution on slow devices. It defaults to `'inherit'`, the canvas's resolution.

```ts
view3d.resolution = app.renderer.resolution * 0.67;
```

## Custom effects

Extend `PostEffect` and set `fragment`, an `EffectFragment` with a GLSL (`gl`) and a WGSL (`gpu`) body that each define `effect(uv)` and read `sampleColor(uv)`. Pass `stage: 'afterToneMapping'` to `super` for an effect that judges the picture as shown, such as a colour grade or edge detection.
