A lit 3D scene: View3D, ground plane, primitives, a shadow-casting sun, hemisphere fill and a moving camera.

## Quick Start

```ts
import { CubeGeometry, DirectionalLight, Material3D, Mesh3D, PlaneGeometry, SphereGeometry, View3D } from '@pixi/3d';
import { Application } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: 0x1a1d26, antialias: true });
document.body.appendChild(app.canvas);

// A View3D is a 2D display object that renders a 3D scene; autoResize fills the canvas
const view3d = new View3D({
  autoResize: true,
  shadowQuality: 'high', // 'low' | 'medium' (default) | 'high' | 'ultra'
  environment: { skyColor: 0x9db8e0, groundColor: 0x3a3028, intensity: 0.8 }, // hemisphere fill
});
app.stage.addChild(view3d);

// Sun: shines along its local -Z, so aim it with lookAt (position only sets where it aims from).
// Direct light is divided by π: intensity 3 lights a face-on surface at about its full baseColor.
const sun = new DirectionalLight({ color: 0xfff1dc, intensity: 3, castShadow: true, position: { x: 5, y: 8, z: 4 } });
sun.lookAt({ x: 0, y: 0, z: 0 });
view3d.root.addChild(sun);

// Ground: PlaneGeometry lies in XY facing +Z. Tip it back to lie in XZ facing +Y
const ground = new Mesh3D({
  geometry: new PlaneGeometry({ width: 20, height: 20 }),
  material: new Material3D({ baseColor: 0x6b7a5a, roughness: 0.9 }),
  rotation: { x: -Math.PI / 2, y: 0, z: 0 },
  castShadow: false,
});
view3d.root.addChild(ground);

// Primitives: geometry, material and transform go in one options object
const cube = new Mesh3D({
  geometry: new CubeGeometry({ width: 1, height: 1, depth: 1 }),
  material: new Material3D({ baseColor: 0xd9534f, roughness: 0.5 }),
  position: { x: -1, y: 0.5, z: 0 },
});
const sphere = new Mesh3D({
  geometry: new SphereGeometry({ radius: 0.6, widthSegments: 32, heightSegments: 16 }),
  material: new Material3D({ baseColor: 0xe0e0e0, metallic: 1, roughness: 0.25 }),
  position: { x: 1, y: 0.6, z: 0 },
});
view3d.root.addChild(cube, sphere);

// Camera: lives on the view, faces its local -Z; lookAt turns it toward a point
const camera = view3d.camera;
camera.fov = 50; // vertical, degrees
camera.position.set(0, 3, 7);
camera.lookAt({ x: 0, y: 0.5, z: 0 });

// Orbit the camera around the scene
let time = 0;
app.ticker.add((ticker) => {
  time += ticker.deltaMS / 1000;
  camera.position.set(Math.sin(time * 0.3) * 7, 3, Math.cos(time * 0.3) * 7);
  camera.lookAt({ x: 0, y: 0.5, z: 0 });
  cube.rotation.y += ticker.deltaTime * 0.02;
});
```

Everything 3D goes under `view3d.root`, not `app.stage`. Meshes cast and receive shadows by default; a light's `castShadow` defaults to `false`.

The view's `toneMapping` defaults to `'none'`: lit colour reaches the screen as computed and clips flat above 1. When strong lights or a bright environment burn surfaces out, pass `toneMapping: 'aces'` to the view; it rolls highlights off, and white surfaces then draw light grey. See `environment-and-sky.md`.

## Ground plane orientation

`PlaneGeometry` lies in the XY plane facing +Z, like a wall, and is single-sided. To use it as a floor, rotate X by `-Math.PI / 2` so the face points +Y. `+Math.PI / 2` points it down, so it vanishes when seen from above.

```ts
// A wall seen from both sides: doubleSided is fixed at construction
const wall = new Mesh3D({
  geometry: new PlaneGeometry({ width: 4, height: 3 }),
  material: new Material3D({ baseColor: 0xcccccc, doubleSided: true }),
  position: { x: 0, y: 1.5, z: -3 },
});
```

## Aiming lights

Lights shine along their local -Z. A `DirectionalLight`'s position changes neither its light nor its shadow; only its rotation counts, and there is no `target` property as in Three.js. An unrotated sun shines horizontally toward -Z and leaves the tops of things unlit. Aim it with `lookAt` from a position, or rotate it directly:

```ts
sun.position.set(5, 8, 4);
sun.lookAt({ x: 0, y: 0, z: 0 });

sun.rotation.set(-Math.PI / 4, Math.PI / 6, 0); // radians, pitch down 45°
sun.angle.set(-45, 30, 0); // the same in degrees; the last one written wins
```

`lookAt` is on every `Container3D`. Cameras and lights point their -Z at the target; meshes point their +Z.

## Point, spot and ambient lights

Point and spot lights dim with the square of the distance, so they need a far higher `intensity` than a sun. `range` (default 0, no limit) fades them to nothing at that distance and lets the view skip the pixels outside it. `coneAngle` is degrees from the axis to the edge (default 60). Only directional and spot lights cast shadows.

```ts
import { AmbientLight, PointLight, SpotLight } from '@pixi/3d';

const bulb = new PointLight({ color: 0x66aaff, intensity: 6, range: 4, position: { x: 2, y: 1, z: 1 } });
const lamp = new SpotLight({
  color: 0xffa040,
  intensity: 80,
  range: 8,
  coneAngle: 26,
  penumbra: 0.3,
  castShadow: true,
});
lamp.position.set(-2, 4, 0);
lamp.lookAt({ x: -2, y: 0, z: 0 }); // the cone points down its local -Z
const fill = new AmbientLight({ intensity: 1 }); // also divided by π: 1 adds about a third of baseColor
view3d.root.addChild(bulb, lamp, fill);
```

A view shades up to 32 directional, point and spot lights (ambient doesn't count) and ignores the rest. Shadows share 16 maps, one per casting spot or uncascaded sun and one per cascade; a casting light past that draws unshadowed and warns. `light.visible = false` switches a light off at no cost.

## Shadow settings

Shadow map size and edge softness are set on the view, not the light. There is no `shadow.mapSize`.

```ts
view3d.shadowQuality = 'ultra'; // 'low' 512, 'medium' 1024 (default), 'high' 2048, 'ultra' 4096
view3d.shadowFilter = 'pcf-high'; // 'hard' | 'pcf' (default) | 'pcf-high'; a change recompiles materials
```

By default the sun's shadow box fits every shadow caster, measured each frame. Past 256 casters it is measured once and kept, so call `sun.fitShadowBounds()` after the scene changes. For a big level, pass fixed `bounds` or camera-following `cascades` (not both; that is a type error):

```ts
import { Box } from '@pixi/3d';

const arenaSun = new DirectionalLight({
  castShadow: true,
  shadow: { bounds: Box.fromCenterSize({ x: 0, y: 1, z: 0 }, 30) },
});
const worldSun = new DirectionalLight({ castShadow: true, shadow: { cascades: 3, maxDistance: 80 } });
```

Striped acne on lit faces: raise `shadow.bias` (default 0.001) or `shadow.normalBias`. Turn shadows off per mesh with `castShadow: false` / `receiveShadow: false` in the `Mesh3D` options or as properties.

## Fill light and background

With only a directional light, faces turned away from it render black. Add a fill: `environment` on the view (a hemisphere gradient or a cube map, normal-aware and cheap), or `AmbientLight` (flat, adds up).

The view's `background` defaults to `null`, so the app's `backgroundColor` from `app.init` shows through untouched. Set `background` to draw a colour, hemisphere or cube map inside the 3D pass, where exposure, fog and tone mapping apply to it. At the default `toneMapping: 'none'` and `exposure: 1`, a colour background draws exactly as authored.

```ts
import type { Hemisphere } from '@pixi/3d';

const sky: Hemisphere = { skyColor: 0x88bbff, groundColor: 0x443322, intensity: 1 };
const view = new View3D({ autoResize: true, environment: sky, background: sky });
```

## Camera and view

The view comes with a camera, `view3d.camera`. `fov` is vertical, in degrees (default 60). `near` (default 0.1) and `far` (default 1000) are in world units. For user-controlled orbiting, use `OrbitCamera` from `@pixi/3d/extras` in place of the ticker loop:

```ts
import { OrbitCamera } from '@pixi/3d/extras';

new OrbitCamera({ view: view3d, target: { x: 0, y: 0.5, z: 0 }, enableDamping: true, autoRotate: true });

// Texels per logical pixel for the 3D scene; 'inherit' (default) follows the canvas. 1 saves fill rate on DPR 3 phones.
view3d.resolution = 1;
```
