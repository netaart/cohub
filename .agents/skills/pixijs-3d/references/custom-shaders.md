# Custom shaders

Change how a material looks or moves with `ShaderBit`s: small WGSL + GLSL snippets the engine splices into its own shader.

## Quick Start

A lit, wobbling lava blob: one bit moves vertices and recolours the surface of an ordinary `Material3D`.

```ts
import type { ShaderBit } from '@pixi/3d';
import { DirectionalLight, Material3D, Mesh3D, SphereGeometry, View3D } from '@pixi/3d';
import { OrbitCamera } from '@pixi/3d/extras';
import { Application } from 'pixi.js';

// One bit, written twice: WGSL for WebGPU (`gpu`) and GLSL for WebGL (`gl`).
const lavaBit: ShaderBit = {
  name: 'lava', // must be unique: compiled shaders are cached by bit name
  // Per-material values, read in the shader as `material.<name>`, written from JS via `material.data`
  bindings: { material: { amplitude: 'f32', speed: 'f32', hotColor: 'vec4<f32>' } },
  gpu: {
    vertex: {
      beforeTransform: /* wgsl */ `{
        let wobble = sin(position.y * 6.0 + global.uTime * material.speed) * material.amplitude;
        position = vec4<f32>(position.xyz + normal * wobble, 1.0);
      }`,
    },
    fragment: {
      material: /* wgsl */ `{
        let heat = 0.5 + 0.5 * sin(input.vPosition.y * 10.0 - global.uTime * 3.0);
        albedo = mix(albedo, material.hotColor.rgb, heat);
        emissive += material.hotColor.rgb * heat;
      }`,
    },
  },
  gl: {
    vertex: {
      beforeTransform: /* glsl */ `{
        float wobble = sin(position.y * 6.0 + uTime * material.speed) * material.amplitude;
        position = vec4(position.xyz + normal * wobble, 1.0);
      }`,
    },
    fragment: {
      material: /* glsl */ `{
        float heat = 0.5 + 0.5 * sin(vPosition.y * 10.0 - uTime * 3.0);
        albedo = mix(albedo, material.hotColor.rgb, heat);
        emissive += material.hotColor.rgb * heat;
      }`,
    },
  },
};

const app = new Application();
await app.init({ resizeTo: window, background: 0x101018, antialias: true });
document.body.appendChild(app.canvas);

const view3d = new View3D({ autoResize: true, environment: { skyColor: 0x8899bb, groundColor: 0x221a14 } });
app.stage.addChild(view3d);
view3d.camera.position.set(0, 1, 5);
new OrbitCamera({ view: view3d, target: { x: 0, y: 0, z: 0 }, enableDamping: true });
const sun = new DirectionalLight({ intensity: 3 });
sun.rotation.set(-0.8, 0.5, 0);
view3d.root.addChild(sun);

// The bit rides on an ordinary material: lights, shadows and environment still apply.
const lava = new Material3D({ baseColor: 0x331100, roughness: 0.5, extraBits: [lavaBit] });
lava.data.amplitude = 0.08;
lava.data.speed = 4;
lava.data.hotColor = [1, 0.35, 0.05, 1]; // linear RGBA

const blob = new Mesh3D({
  geometry: new SphereGeometry({ radius: 1, widthSegments: 96, heightSegments: 64 }),
  material: lava,
});
view3d.root.addChild(blob);

// uTime animates the shader by itself; the ticker only drives per-material values.
app.ticker.add((ticker) => {
  lava.data.amplitude = 0.05 + 0.05 * Math.sin(performance.now() / 1000);
  blob.rotation.y += ticker.deltaMS / 3000;
});
```

## There is no ShaderMaterial

`@pixi/3d` has no ShaderMaterial, RawShaderMaterial or onBeforeCompile, and you never write `main()`. A bit is a plain object of code strings keyed by **slot**. Pass it as `extraBits` to `Material3D`, `FlatMaterial`, `PhongMaterial`, `ToonMaterial` or `ParticleSystem3D`. The bit list is fixed at construction: `material.clone({ extraBits: [bit] })` makes a copy with the bit added and everything else kept, which is how a loaded glTF material gets one ([materials](materials.md)). `material.data` values can change every frame.

What each slot can read and write (the local names are the same on both backends):

- `vertex.beforeTransform`: `position` (vec4, local), `normal` (local), `uv`, `material`. Displace here.
- `vertex.afterTransform`: `worldPosition`, `worldNormal`, `clipPosition` (WGSL) / `gl_Position` (GLSL). Moving `worldPosition` here means rebuilding the clip position: `camera.uViewProjectionMatrix * worldPosition` (WGSL), `uViewProjectionMatrix * worldPosition` (GLSL).
- `fragment.material`: `albedo` (vec3), `alpha`, `normal` (world). On `Material3D` also `emissive`, `roughness`, `metallic`, `occlusion`; on `PhongMaterial` also `emissive`. This slot runs after the material's own inputs, so `albedo` is already textured.
- `fragment.lobePostLighting` (lit materials only): `finalColor` after the light loop, `normal`, `viewDir`.
- `header` holds helper functions: one string per backend, `gpu: { header }` and `gl: { header }`; GLSL puts it in both stages. For `PI`, add `requires: [mathConstantsBit]` (from `@pixi/3d`) instead of defining it.

Shadows and outlines draw with shaders of their own, which bits never reach: a displaced or discarded surface still casts its undisplaced, whole shadow. Give such a mesh `castShadow: false`.

## Write it twice

`gpu` is WGSL for WebGPU and `gl` is GLSL ES 3.0 for WebGL. PixiJS tries WebGL first unless `preference: 'webgpu'` is set, so most users run the `gl` half. Write both halves and test both.

- WGSL reads varyings and time as `input.vPosition`, `input.vNormal`, `input.vUV`, `global.uTime`. GLSL reads them bare: `vPosition`, `vUV`, `uTime`. `vPosition` is in world space and `uTime` is seconds; don't declare either. Both backends read `material.<field>`.
- WGSL `let x = 1.0;` `vec3<f32>(...)`; GLSL `float x = 1.0;` `vec3(...)`, and GLSL won't mix ints and floats: write `3.0`, not `3`.
- Wrap slot code in `{ ... }`. All bits share one function, so two bits that each declare `let t` collide.
- Give each bit a unique `name`. Shaders are cached by name, and two different bits with the same name throw.

## Unlit custom colour: FlatMaterial

`FlatMaterial` ignores lights, so the screen shows what the bit writes to `albedo` and `alpha`. It is the nearest thing to a Three.js ShaderMaterial. Its shader runs in display space under the view's default `toneMapping: 'none'` and in linear light under fog or a filmic curve, so store colours as authored and read them through `decodeColor(...)`, which returns them in whichever space the shader uses. The default `alphaMode: 'opaque'` ignores `alpha`, so set `'blend'` or `'mask'` when you need it.

```ts
const ringsBit: ShaderBit = {
  name: 'rings',
  bindings: { material: { ringColor: 'vec4<f32>', rings: 'f32' } },
  gpu: {
    fragment: {
      material: /* wgsl */ `{
    let d = distance(input.vUV, vec2<f32>(0.5));
    let ring = step(0.5, fract(d * material.rings - global.uTime));
    albedo = decodeColor(material.ringColor.rgb) * ring;
    alpha = ring * step(d, 0.5);
  }`,
    },
  },
  gl: {
    fragment: {
      material: /* glsl */ `{
    float d = distance(vUV, vec2(0.5));
    float ring = step(0.5, fract(d * material.rings - uTime));
    albedo = decodeColor(material.ringColor.rgb) * ring;
    alpha = ring * step(d, 0.5);
  }`,
    },
  },
};
const rings = new FlatMaterial({ extraBits: [ringsBit], alphaMode: 'blend', doubleSided: true });
rings.data.ringColor = new Color('deepskyblue').toArray(); // as authored; the bit decodes it
rings.data.rings = 8;
```

For a material with no built-in inputs at all, subclass `BaseMaterial3D`, pass `descriptor: { bitsGpu: [bit], bitsGl: [bit] }` to `super`, and set `public override lit = false` on the class when the bit does no lighting.

## After lighting: rim glow

`lobePostLighting` runs once after the light loop, when `finalColor` is already lit, in linear light. Add to `finalColor`; don't replace it.

```ts
const rimCode = 'finalColor += material.rimColor.rgb * pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);';
const rimBit: ShaderBit = {
  name: 'rim',
  bindings: { material: { rimColor: 'vec4<f32>' } },
  gpu: { fragment: { lobePostLighting: rimCode } },
  gl: { fragment: { lobePostLighting: rimCode } }, // this line is valid in both languages
};
const glowing = new Material3D({ baseColor: 0x223344, extraBits: [rimBit] });
glowing.data.rimColor = [0.3, 0.8, 2, 1]; // linear; above 1 glows past white
```

## Your own lighting model

`createLightingBit` builds the bit that decides how a surface takes light, from three snippets per backend: `preLighting` declares accumulators, `perLight` runs once for each light that reaches the surface (with `light.color`, `nDotL`, `attenuation` and `shadow` in scope), and `postLighting` writes `finalColor`. Pair it with a surface bit that sets `albedo` in a `BaseMaterial3D` descriptor:

```ts
import { BaseMaterial3D, createLightingBit, mathConstantsBit } from '@pixi/3d';
import type { ShaderBit } from '@pixi/3d';

const surfaceBit: ShaderBit = {
  name: 'surface',
  bindings: { material: { baseColor: 'vec4<f32>' } }, // filled from the baseColor option, in linear light
  gpu: { fragment: { material: 'albedo *= material.baseColor.rgb;' } },
  gl: { fragment: { material: 'albedo *= material.baseColor.rgb;' } },
};

const lambertLightingBit = createLightingBit({
  name: 'lambertLighting',
  requires: [mathConstantsBit],
  preLighting: { gpu: 'var directLight = vec3<f32>(0.0);', gl: 'vec3 directLight = vec3(0.0);' },
  perLight: {
    gpu: 'directLight += light.color * (nDotL * attenuation * shadow);',
    gl: 'directLight += light.color * (nDotL * attenuation * shadow);',
  },
  postLighting: {
    gpu: 'finalColor = albedo * directLight * INV_PI;',
    gl: 'finalColor = albedo * directLight * INV_PI;',
  },
});

const material = new BaseMaterial3D({
  baseColor: 0xe91e63,
  descriptor: { bitsGpu: [surfaceBit, lambertLightingBit], bitsGl: [surfaceBit, lambertLightingBit] },
});
```

`perLight` never runs for a light the surface faces away from, so anything on the shaded side (wrap lighting, a fill colour) comes from `postLighting`. Divide by π (`INV_PI`) as the built-in models do, or one light reads π× brighter than on the PBR meshes beside it.

## Values, textures and ready-made bits

- Declare fields in `bindings.material` using WGSL type names (`'f32'`, `'vec2<f32>'`, `'vec4<f32>'`); the same declaration serves both backends. Never add fields to `global` or `camera`, or the draw fails.
- Write values with `material.data.x = ...`: numbers or arrays. Assignment queues the upload. Writing into a returned vector (data.rimColor[0] = 1) does not, so call `material.update()` afterwards.
- Colours: `Material3D`, `PhongMaterial` and `ToonMaterial` shade in linear light, so a colour used as is must be linear (`srgbToLinear(channel)` from `@pixi/3d` converts one channel). `decodeColor(c)` on a colour stored as authored works on every material.
- `textures: ['noise']` on a bit generates sampleNoise(uv) (fragment only) and sampleNoiseDirect(uv) (mip 0, works in the vertex stage). Fill it with `new Material3D({ extraBits: [noiseBit], textures: { noise: tex } })` or `material.textures.noise = tex`. To tile, set `tex.source.style.addressMode = 'repeat'` and then call `tex.source.style.update()`.
- On `ParticleSystem3D`, set values with `particles.uniforms.<name>`, not `data`. Its `vertex.beforeTransform` sees `particleAge`, `position` and `particleColor`.
- Check before writing a bit. `@pixi/3d/extras` has `glossBit` (wet-plastic edges), `dissolveBit` (noisy holes with a glowing edge; [models-and-animation](models-and-animation.md)), `ToonMaterial` and `PortalMaterial`. Faceting is `flatShading: true` and billboards are `mesh.billboardMode`; neither needs a bit.
