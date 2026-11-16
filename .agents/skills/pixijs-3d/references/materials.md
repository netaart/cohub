# Materials

How to colour, texture, light and make transparent the surfaces of `Mesh3D` objects: PBR `Material3D`, unlit `FlatMaterial`, `PhongMaterial`, `ToonMaterial`, alpha modes and runtime changes.

## Quick Start

```ts
import {
  CubeGeometry,
  DirectionalLight,
  FlatMaterial,
  Material3D,
  Mesh3D,
  PhongMaterial,
  PlaneGeometry,
  SphereGeometry,
  View3D,
} from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application, Assets, Matrix, type Texture } from 'pixi.js';

const app = new Application();
await app.init({ resizeTo: window, background: 0x101018, antialias: true });
document.body.appendChild(app.canvas);

// Metals and rough surfaces take their ambient light from the environment.
const view3d = new View3D({ autoResize: true, environment: { skyColor: 0xbfd4ff, groundColor: 0x3a3028 } });
app.stage.addChild(view3d);

const sun = new DirectionalLight({ intensity: 3 });
sun.position.set(4, 6, 5);
sun.lookAt({ x: 0, y: 0, z: 0 });
view3d.root.addChild(sun);

view3d.camera.position.set(0, 2, 7);
new OrbitCamera({ view: view3d, target: { x: 0, y: 0.6, z: 0 }, enableDamping: true });

// Textures come from pixi's Assets; set the wrap mode on the source to tile.
const grass = await Assets.load<Texture>('https://pixijs.com/assets/bg_grass.jpg');
grass.source.style.addressMode = 'repeat';
grass.source.style.update();
const bunny = await Assets.load<Texture>('https://pixijs.com/assets/bunny.png');

// PlaneGeometry lies in XY facing +Z: rotate it to make a floor.
const ground = new Mesh3D({
  geometry: new PlaneGeometry({ width: 12, height: 12 }),
  material: new Material3D({ baseColorTexture: grass, roughness: 1, uvTransform: new Matrix().scale(4, 4) }),
});
ground.rotation.x = -Math.PI / 2;
view3d.root.addChild(ground);

const sphere = new SphereGeometry({ radius: 0.5, widthSegments: 48, heightSegments: 32 });
const add = (material: Material3D | PhongMaterial, x: number): Mesh3D => {
  const mesh = new Mesh3D({ geometry: sphere, material });
  mesh.position.set(x, 0.5, 0);
  view3d.root.addChild(mesh);
  return mesh;
};

const gold = new Material3D({ baseColor: 0xffc356, metallic: 1, roughness: 0.25 });
const plastic = new Material3D({ baseColor: 'tomato', roughness: 0.5 });
const lamp = new Material3D({ baseColor: 0x111111, emissive: { color: 0x66ccff, strength: 3 } });
const phong = new PhongMaterial({ baseColor: 0x2f6f8b, specularColor: 0x777777, shininess: 64 });
add(gold, -2.4);
add(plastic, -0.8);
add(lamp, 0.8);
add(phong, 2.4);

// Translucent glass box: 'blend' turns depth writes off and casts no shadow.
const glass = new Mesh3D({
  geometry: new CubeGeometry({ width: 1, height: 1, depth: 1 }),
  material: new Material3D({ baseColor: 0x88ddff, roughness: 0.1, alphaMode: 'blend', alpha: 0.35 }),
});
glass.position.set(0, 0.6, 1.6);
view3d.root.addChild(glass);

// Unlit cut-out sign: FlatMaterial ignores lights and shows the texture as authored; 'mask' discards transparent texels.
const sign = new Mesh3D({
  geometry: new PlaneGeometry({ width: 0.8, height: 1.1, flipV: true }),
  material: new FlatMaterial({ baseColorTexture: bunny, alphaMode: 'mask', doubleSided: true }),
});
sign.position.set(0, 1.8, -1);
view3d.root.addChild(sign);

let time = 0;
app.ticker.add((ticker) => {
  time += ticker.deltaMS / 1000;
  lamp.emissive!.strength = 2 + Math.sin(time * 3) * 1.5; // setters upload for you
  plastic.roughness = 0.5 + Math.sin(time) * 0.45;
  sign.rotation.y = time;
  glass.rotation.y = time * 0.5;
});
```

`Material3D`, `FlatMaterial` and `PhongMaterial` live in `@pixi/3d`; `ToonMaterial` is in `@pixi/3d/extras`. Every material takes one options object; there is no `color`, `map` or `transparent` field as in Three.js. Colours take any pixi `ColorSource` (`0xff7733`, `'tomato'`, `[1, 0.5, 0.2]`) in display (sRGB) space, and the source's alpha is ignored: opacity is `alpha`.

## Fixed at construction vs changeable later

`doubleSided`, `flatShading`, `fog` and which extension groups exist (`emissive`, `specular`, `clearcoat`, `sheen`, `transmission`, `iridescence`, `anisotropy`) are fixed when the material is built. A material built without `emissive` has `material.emissive === undefined`, so pass the group up front, even at strength 0, if it will glow later; for a material that already exists, `clone` with the group (below). Passing a group, even `clearcoat: {}`, turns the feature on at full strength.

```ts
const warning = new Material3D({ baseColor: 0x222222, emissive: { color: 0xff3300, strength: 0 } });
warning.emissive!.strength = 4; // group props: strength, color, texture
warning.emissive!.color = 'yellow';
```

Everything else is a setter that uploads for you, with no needsUpdate: `baseColor`, `metallic`, `roughness`, `alpha`, `alphaMode`, `alphaCutoff`, `normalScale`, `occlusionStrength`, `ior`, `uvTransform` (assign a new or reused `Matrix`; the material keeps a copy), and every extension group's fields. Phong adds `shininess`, `specularColor` and `specularStrength`. A material shared by several meshes changes all of them; swap a mesh's material with `mesh.material = other`, or give one mesh a copy with `clone` (below). After changing `vertexColors` or a field of `material.state` (`blendMode`, `depthTest`, `cullMode`), call `mesh.invalidate()` on each mesh using the material.

## Copies: `clone(options)`

`material.clone(options)` builds a material of the same class that draws as this one does now, with the constructor options you pass changed. It's the way to change a fixed option, add a feature group or add `extraBits` to a material that exists, such as one the glTF loader built: building a new `Material3D` instead drops the textures and values the loader set.

```ts
const ghost = mesh.material.clone({ alphaMode: 'blend', alpha: 0.4 }); // mesh.material: a BaseMaterial3D
mesh.material = ghost; // this mesh only; other meshes keep the original
const paint = new Material3D({ baseColor: 0x992222, emissive: { color: 0xff3300, strength: 0.5 } });
const hot = paint.clone({ emissive: { strength: 2 } }); // keeps paint's emissive colour
ghost.destroy(); // when done; the shared textures stay alive
```

- Options merge one level deep: a group you pass keeps the fields you leave out, and a group the material lacks (`clearcoat: {}`) adds the feature. `descriptor` is replaced whole.
- `extraBits` adds to the material's own `extraBits`. A new bit's `material.data` fields start at 0 and its texture slots hold `Texture.WHITE`: set them on the copy.
- Textures are shared, not copied. `label`, `colorSpace`, `state` changes and passes joined with `enablePass` come across. Colours read back as 8-bit hex.
- A copy with the same bits compiles no new shader. One copy can serve many meshes; destroy the copies you make.
- To give one loaded model copies of all its materials, assign `model.materials` ([models-and-animation](models-and-animation.md)).

## Transparency: blend vs mask

```ts
// See-through: alpha-blended, sorted back to front, no depth writes, casts no shadow
const ghost = new Material3D({ baseColor: 0xffffff, alphaMode: 'blend', alpha: 0.3 });
ghost.alpha = 0.5; // fade at runtime

// Cut-out (leaves, fences, sprites): texels below alphaCutoff (default 0.5) are discarded, depth stays correct
const leafTexture = await Assets.load<Texture>('https://pixijs.com/assets/bunny.png');
const leaves = new Material3D({
  baseColorTexture: leafTexture,
  alphaMode: 'mask',
  alphaCutoff: 0.3,
  doubleSided: true,
});
```

The default `alphaMode` is `'opaque'`, which ignores `alpha` and the alpha of textures and vertex colours: `alpha: 0.5` alone does nothing, and a PNG's transparent texels draw black, because pixi premultiplies images on upload. Set `'mask'` for a texture with holes and `'blend'` for see-through. `'blend'` surfaces write no depth, so they can show sorting artefacts where they overlap themselves. A `'mask'` surface casts a solid shadow with no holes in it, since the shadow pass doesn't read textures. Glass that refracts is `transmission: {}`, not `'blend'`.

## Textures

```ts
const crate = await Assets.load<Texture>('https://pixijs.com/assets/p2.jpeg');
const mat = new Material3D({ baseColorTexture: crate, roughness: 0.8 });
mat.textures.baseColor = await Assets.load<Texture>('https://pixijs.com/assets/bg_grass.jpg'); // swap by slot name
```

- Option names are `baseColorTexture`, `normalTexture` (green up, as glTF), `metallicRoughnessTexture` (roughness in G, metalness in B, as glTF), `occlusionTexture`, and `emissive: { texture }`. Runtime slots are `material.textures.baseColor`, `.normal`, `.metallicRoughness`, `.occlusion`, `.emissive`, ...
- Textures clamp by default. To tile, set `texture.source.style.addressMode = 'repeat'`, call `texture.source.style.update()`, and scale UVs with `uvTransform: new Matrix().scale(4, 4)` (`Matrix` from `pixi.js`). One `uvTransform` applies to every texture of the material.
- A spritesheet frame as `baseColorTexture` sets the UV transform from its frame, so assigning the next frame to `material.textures.baseColor` plays a flipbook. An explicit `uvTransform` overrides the frame.
- `PlaneGeometry` puts UV `v = 0` at the bottom, so an image shows upside down. Pass `flipV: true` when the plane shows a picture.

## FlatMaterial, PhongMaterial and ToonMaterial

```ts
// Unlit: lights, environment and shadows leave it alone. For UI panels, icons, baked art
const label = new FlatMaterial({ baseColorTexture: leafTexture, alphaMode: 'mask' });

// Blinn-Phong: no metallic/roughness, uses shininess (default 30) and a specular tint
const tile = new PhongMaterial({ baseColor: 0x8a5a2b, shininess: 12, specularStrength: 0.5 });
const chalk = new PhongMaterial({ baseColor: 0xeeeeee, specularStrength: 0 }); // no highlight

// Cel shading (import from '@pixi/3d/extras'): banded light, a hard highlight and a rim
const toon = new ToonMaterial({ baseColor: 0xf4a259, bands: 2, rimIntensity: 0.4 });
toon.data.bands = 3; // toon values change through `data`
```

`FlatMaterial` is what Three.js calls MeshBasicMaterial; there is no MeshStandardMaterial name, `Material3D` is the PBR one. Under the view's default `toneMapping: 'none'`, a `FlatMaterial` shows its colour and texture exactly as authored, like a pixi sprite; a filmic curve such as `'aces'` and the view's fog shift it, and `fog: false` keeps fog off. `PhongMaterial` takes the same `emissive` group as `Material3D`. `specularColor: 0x000000` does not remove Phong's highlight (Fresnel lifts it at grazing angles); `specularStrength: 0` does. `ToonMaterial` reads direct lights and `AmbientLight` only, not the view's environment; for ink outlines add `new OutlinePass({ width: 0.05 })` (from `@pixi/3d/extras`) to the View3D's `passes`, and pass `outline: false` to keep a material out of it.

## Metals, brightness and tone mapping

`metallic: 1` surfaces get their colour from reflected light, so a lone `DirectionalLight` leaves them dark except for one highlight. Give the view an environment: a sky/ground gradient as in the Quick Start, or a `CubeTexture`.

```ts
view3d.environment = { skyColor: 0xbfd4ff, groundColor: 0x3a3028 };
const chrome = new Material3D({ baseColor: 0xffffff, metallic: 1, roughness: 0.05 });
```

`roughness` defaults to 1 (fully matte) and `metallic` to 0, so a bare `new Material3D({ baseColor })` looks like chalk; lower `roughness` for any shine. Views default to `toneMapping: 'none'`, so lit colour past 1 clips, and an `emissive.strength` above 1 flattens toward white unless bloom picks it up. For strong lights, a bright environment or glowing materials, set `toneMapping: 'aces'` on the `View3D` to roll highlights off smoothly; it shifts unlit colours too.
