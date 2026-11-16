# Environment and sky

Ambient light, reflections, the sky behind the scene, HDR environments, fog, tone mapping and exposure. All of it is set on the `View3D`, not on a scene object.

## Quick Start

```ts
import { CubeGeometry, DirectionalLight, Material3D, Mesh3D, PlaneGeometry, View3D } from '@pixi/3d';
import type { Fog, Hemisphere } from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application, Color } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, antialias: true });
document.body.appendChild(app.canvas);

// Plain objects, not classes. The view keeps them by reference, so editing a field later is free.
const sky: Hemisphere = { skyColor: 0x9cc8ff, groundColor: 0x5a4a3a, intensity: 1 };
const fog: Fog = { type: 'linear', color: 0xb8c8d8, near: 15, far: 60 };

const view = new View3D({
  autoResize: true,
  environment: sky, // ambient light + reflections from a sky/ground gradient
  background: fog.color, // same colour as the fog: far geometry melts into it
  fog,
  toneMapping: 'none', // the default: colours as computed, clipped above 1
  exposure: 1,
});
app.stage.addChild(view);

const sun = new DirectionalLight({ color: 0xfff0d8, intensity: 2.5, castShadow: true });
sun.rotation.set(-Math.PI / 4, Math.PI / 5, 0); // lights shine down their local -Z
view.root.addChild(sun);

// PlaneGeometry lies in XY facing +Z: rotate it -90° around X to make a floor.
const ground = new Mesh3D({
  geometry: new PlaneGeometry({ width: 200, height: 200 }),
  material: new Material3D({ baseColor: 0x6f7f5a, roughness: 1, metallic: 0 }),
  rotation: { x: -Math.PI / 2, y: 0, z: 0 },
  castShadow: false,
});
view.root.addChild(ground);

// Two rows of pillars that fade into the fog with distance
const pillarGeometry = new CubeGeometry({ width: 1, height: 4, depth: 1 });
const pillarMaterial = new Material3D({ baseColor: 0xd8d0c0, roughness: 0.6, metallic: 0 });
for (let row = 0; row < 12; row++) {
  for (const x of [-4, 4]) {
    const pillar = new Mesh3D({ geometry: pillarGeometry, material: pillarMaterial });
    pillar.position.set(x, 2, -row * 6);
    view.root.addChild(pillar);
  }
}

view.camera.position.set(0, 3, 12);
new OrbitCamera({ view, enableDamping: true, target: { x: 0, y: 2, z: -10 }, maxDistance: 40 });

// Day to dusk and back by mutating the same objects: no shader recompiles.
const mix = (a: number, b: number, t: number): number => {
  const ca = new Color(a);
  const cb = new Color(b);
  return new Color([
    ca.red + (cb.red - ca.red) * t,
    ca.green + (cb.green - ca.green) * t,
    ca.blue + (cb.blue - ca.blue) * t,
  ]).toNumber();
};
let time = 0;

app.ticker.add((ticker) => {
  time += ticker.deltaMS / 1000;
  const t = 0.5 - 0.5 * Math.cos(time * 0.3); // 0 = day, 1 = dusk
  fog.color = mix(0xb8c8d8, 0xd88a60, t);
  view.background = fog.color; // a colour background is cheap to change
  sky.skyColor = mix(0x9cc8ff, 0xff9a66, t);
  sky.intensity = 1 - 0.5 * t;
  sun.intensity = 2.5 - 1.8 * t;
  view.exposure = 1 - 0.2 * t; // free every frame
});
```

`environment` lights the scene but draws nothing. `background` draws behind it but lights nothing. Set both. A hemisphere casts no shadows, so keep a `DirectionalLight` for those. Every colour here (hemisphere, fog, background, light) is display-space sRGB, as in pixi 2D.

## Cube map lighting (IBL) and skybox

`CubeTexture` comes from `pixi.js`, not `@pixi/3d`. Load a `.cubemap` file: JSON with the keys `right`, `left`, `top`, `bottom`, `front`, `back`, each an image path relative to the file. Importing `@pixi/3d` registers the loader, so plain `Assets.load` handles it:

```ts
import { Assets, CubeTexture } from 'pixi.js';
import type { Texture } from 'pixi.js';

const env = await Assets.load<CubeTexture>('env/studio.cubemap');
view.environment = env; // reflections + ambient light; prefiltered once on first use
view.background = env; // the skybox: no mesh, no sky material needed
// later: await Assets.unload('env/studio.cubemap') destroys the cube and its six faces

// Or build one from six loaded images
const [px, nx, py, ny, pz, nz] = await Promise.all(
  ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((face) => Assets.load<Texture>(`sky/${face}.jpg`)),
);
const built = CubeTexture.from({ faces: { right: px, left: nx, top: py, bottom: ny, front: pz, back: nz } });
```

Use `metallic: 1, roughness: 0.1` on a sphere to check the reflections show. Switching `environment` between a cube map, a hemisphere and `null` recompiles every material on the next frame; swapping one cube map for another doesn't. To flip between a cube map and a plain colour without a recompile, use `ColorCubeTexture.from(0x9ea8ba)` from `@pixi/3d`, a one-texel cube. On WebGL the prefilter needs the `EXT_color_buffer_float` extension and throws without it.

## HDR environments (.hdr)

`Assets.load` also reads an equirectangular Radiance `.hdr` panorama into a float cube. It holds light brighter than white, so a sun in the panorama stays bright in reflections and the sky. Pair it with a filmic curve, or the bright parts clip flat:

```ts
const hdrSky = await Assets.load<CubeTexture>('env/sunset_2k.hdr');
view.environment = hdrSky;
view.background = hdrSky;
view.toneMapping = 'aces';
view.exposure = 0.5; // one stop down: each stop halves or doubles it

const sharp = await Assets.load<CubeTexture>({ src: 'env/sunset_4k.hdr', data: { faceSize: 1024 } });
```

Faces default to a quarter of the panorama's width, capped at 512 (about 8.4 MB with mips). The conversion runs on the main thread while loading: about 50 ms for 1k and 120 ms for 2k on a desktop. The panorama's centre faces +X. Image cube maps are read as sRGB, float cubes as linear light.

## Hemisphere details

`Hemisphere` is a type, not a HemisphereLight class: pass `{ skyColor, groundColor, intensity?, up? }`. `intensity` defaults to 1, `up` to `{ x: 0, y: 1, z: 0 }`. The same object as `background` draws the gradient as a procedural sky:

```ts
const dome: Hemisphere = { skyColor: 0x88ccff, groundColor: 0x553311 };
view.environment = dome;
view.background = dome; // sky matches the light the scene receives
dome.skyColor = 0xff8800; // shows next frame
```

## Fog

`view.fog` takes a plain `Fog` object; there is no `Fog` class to construct. Three curves: `'linear'` (uses `near`/`far`), `'exponential'` and `'exp2'` (use `density`).

```ts
const haze: Fog = { type: 'exp2', color: 0xadb2ba, density: 0.04 };
view.fog = haze;
haze.density = 0.08; // free: the view kept the object
view.fog = { type: 'linear', color: 0xadb2ba, near: 20, far: 60 }; // new curve: assign a new object
view.fog = null; // off
```

- `type` is read-only. Writing `haze.type` is a type error; assign a new object. A new curve recompiles materials.
- Give `view.background` the fog's colour. Both go through exposure and tone mapping, so they match on screen under any curve. The app's `backgroundColor` is never tone-mapped, so it matches the fog only at `'none'` and exposure 1.
- A missing `far` means linear fog never shows; a missing `density` means exponential fog never shows.
- Materials opt out with `new Material3D({ ..., fog: false })`, fixed at construction. Use it for sky domes and water.

## Tone mapping and exposure

`toneMapping` is `'none'` by default: the sRGB encode alone, so lit colour above 1 clips to flat white. `'aces'`, `'reinhard'` and `'uncharted2'` are filmic curves that roll highlights off; use one (usually `'aces'`) for bright lights, HDR environments and bloom, accepting that white then draws light grey. `'custom'` outputs raw linear light for a post effect that does its own curve and encode.

```ts
view.toneMapping = 'aces'; // recompiles materials: set it once, not per frame
view.exposure = 1.4; // multiplier in linear light before the curve; cheap to animate
```

- The curve covers every material, lit and unlit, plus the background and fog. Under `'none'` at exposure 1, unlit art (`FlatMaterial`, sprites, particles) matches pixi 2D exactly; a filmic curve or another exposure shifts it with the lit scene.
- With a `'beforeToneMapping'` post effect in `view.passes`, the scene renders as linear float light and an output pass applies the curve once to the whole image; changing `toneMapping` then rebuilds the render graph. See `post-processing.md`.
- For a plain flat backdrop with no fog, leave `background` null and set `backgroundColor` in `app.init`: the 2D clear shows the exact colour under any curve.
