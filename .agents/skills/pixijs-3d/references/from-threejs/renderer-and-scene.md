Three.js renderer, frame loop, scene settings, cameras, controls, render targets, post-processing, labels and lifetime, mapped to `@pixi/3d` and pixi.js. Each note states what differs; a blank note means a plain rename. Behaviour that changes the picture is listed in [from-threejs.md](../from-threejs.md).

## Renderer → `Application` + `View3D`

| Three.js                                       | @pixi/3d                                                                            | note                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `new WebGLRenderer({ antialias })`             | `await app.init({ antialias })`                                                     | WebGL unless you pass `preference: 'webgpu'`; nothing else changes.                                                              |
| `{ alpha: true }`                              | `app.init({ backgroundAlpha: 0 })`                                                  | A view with no `background` is transparent where nothing draws.                                                                  |
| `{ powerPreference }`                          | `app.init({ powerPreference })`                                                     |                                                                                                                                  |
| renderer.setPixelRatio(r)                      | `app.init({ resolution: r, autoDensity: true })`                                    | Without `autoDensity` the canvas's CSS size grows by `r`; with it, it stays at the window size, as `setSize` does.               |
| `renderer.setSize(w, h)` + resize listener     | `app.init({ resizeTo: window })` + `new View3D({ autoResize: true })`               | Without `resizeTo` the canvas is 800×600; without `autoResize` the view is 256×256. `view.setSize(w, h)` turns `autoResize` off. |
| `renderer.domElement`                          | `app.canvas`                                                                        |                                                                                                                                  |
| renderer.outputColorSpace = SRGBColorSpace     | built in                                                                            | Encodes with gamma 2.2, not the piecewise sRGB curve.                                                                            |
| renderer.toneMapping = NoToneMapping           | `toneMapping: 'none'` (default)                                                     |                                                                                                                                  |
| ACESFilmicToneMapping                          | `'aces'`                                                                            | Same fit and the same 1/0.6 pre-scale.                                                                                           |
| ReinhardToneMapping                            | `'reinhard'`                                                                        |                                                                                                                                  |
| CustomToneMapping                              | `'custom'`                                                                          | Different meaning: outputs raw linear light for a post effect to tone-map.                                                       |
| renderer.toneMappingExposure                   | `exposure` (1)                                                                      | Applies under `'none'` too, and to unlit materials, background and fog.                                                          |
| `renderer.shadowMap.enabled = true`            | none                                                                                | `castShadow: true` on a light turns shadows on.                                                                                  |
| `shadowMap.type` BasicShadowMap / PCFShadowMap | `shadowFilter: 'hard'` / `'pcf'` (default)                                          | PCFSoftShadowMap was removed in r187 and falls back to PCF; `'pcf-high'` is the softer 9-tap filter.                             |
| `light.shadow.mapSize`                         | `shadowQuality: 'low' \| 'medium' \| 'high' \| 'ultra'` (512 to 4096)               | Per view, for every light; default `'medium'` (1024).                                                                            |
| renderer.setClearColor(c, a)                   | `app.init({ backgroundColor, backgroundAlpha })` or `app.renderer.background.color` | Never tone-mapped.                                                                                                               |
| `renderer.render(scene, camera)`               | none                                                                                | The app ticker renders the stage. On demand: `app.init({ autoStart: false })`, then `app.render()`.                              |
| `renderer.dispose()`                           | `app.destroy(true, { children: true })`                                             | `true` removes the canvas.                                                                                                       |

## Loop and time

| Three.js                                  | pixi.js                                                      | note                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| renderer.setAnimationLoop(cb)             | `app.ticker.add((ticker) => …)`                              | Listeners run before the app renders (it renders at `UPDATE_PRIORITY.LOW`).             |
| setAnimationLoop(null)                    | `app.ticker.stop()` or `app.ticker.remove(fn)`               | Stopping `app.ticker` doesn't stop anything on `Ticker.shared`.                         |
| Clock.getDelta(), Timer.getDelta()        | `ticker.deltaMS / 1000`                                      | Capped at 100 ms and scaled by `ticker.speed`. `ticker.deltaTime` counts 60 fps frames. |
| Timer.getElapsed(), the rAF timestamp     | accumulate `ticker.elapsedMS`, or `ticker.lastTime`          | `elapsedMS` is the raw, uncapped frame time.                                            |
| timer.setTimescale(s)                     | `app.ticker.speed = s`                                       |                                                                                         |
| a frame-rate cap by hand                  | `app.ticker.maxFPS = n`                                      |                                                                                         |
| set a flag after the first rendered frame | `app.ticker.addOnce(fn, undefined, UPDATE_PRIORITY.UTILITY)` | `UTILITY` runs after the render.                                                        |
| onBeforeRender                            | `view.onRender = (renderer) => …`                            | Runs before the view updates its scene.                                                 |

## Scene → `View3D`

| Three.js                          | @pixi/3d                                                                                                   | note                                                                                                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `new Scene()`, `scene.add(o)`     | `new View3D()` on `app.stage`, `view.root.addChild(o)`                                                     | `view.addChild` throws; 3D nodes on `app.stage` draw nothing.                                                                                                                                          |
| `scene.background = new Color(c)` | `view.background = c` under `toneMapping: 'none'`; `app.init({ backgroundColor: c })` under a filmic curve | `view.background` is inside the 3D picture, so effects and fog cover it, and it is exact under `'none'`. The app clear colour is never tone-mapped but sits behind the view, untouched by its effects. |
| `scene.background = cubeTexture`  | `view.background = cubeTexture`                                                                            |                                                                                                                                                                                                        |
| scene.environment = pmremTexture  | `view.environment = cubeTexture`                                                                           | Prefiltered on first use; no PMREM step. `.hdr` loads straight to a cube with `Assets.load`.                                                                                                           |
| HemisphereLight(sky, ground, i)   | `environment: { skyColor, groundColor, intensity: i / Math.PI }`                                           | A plain object, kept by reference. Also reflects on metals.                                                                                                                                            |
| `new Fog(color, near, far)`       | `fog: { type: 'linear', color, near, far }`                                                                | Defaults `near: 0`, `far: 99999999`. Mixes in linear light, before the tone curve.                                                                                                                     |
| new FogExp2(color, density)       | `fog: { type: 'exp2', color, density }`                                                                    | `'exponential'` is a third type with no three counterpart.                                                                                                                                             |
| `scene.fog.color.set(c)`          | `fog.color = c` on the object you assigned                                                                 | Changing `type` needs a new object, which recompiles materials.                                                                                                                                        |
| `scene.fog = null`                | `view.fog = null`                                                                                          | Recompiles materials.                                                                                                                                                                                  |

## Cameras

| Three.js                                                        | @pixi/3d                                                                      | note                                                                                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| new PerspectiveCamera(fov = 50, aspect, near = 0.1, far = 2000) | `view.camera`, or `new Camera3D({ fov = 60, near = 0.1, far = 1000 })`        | `fov` is vertical degrees in both; set `fov` and `far` explicitly.                                                                                     |
| `camera.aspect`, updateProjectionMatrix()                       | none                                                                          | Rebuilt every frame from the view rectangle.                                                                                                           |
| `camera.zoom`                                                   | `camera.zoom` (1)                                                             |                                                                                                                                                        |
| new OrthographicCamera(l, r, t, b, near, far)                   | `camera.mode = 'orthographic'`, `orthographicSize = (r - l) / 2`              | Half the **width**; height follows the aspect. For three's fixed frustumSize height: orthographicSize = (frustumSize / 2) \* view.width / view.height. |
| switch projection                                               | `camera.usePerspective(fov, near, far)`, `useOrthographic(size, near, far)`   | Omitted arguments reset to the defaults.                                                                                                               |
| `projectionMatrix`, matrixWorldInverse                          | `camera.projection`, `camera.view`, `camera.viewProjection`, `camera.frustum` | Read-only, rebuilt every frame.                                                                                                                        |
| `camera.lookAt(x, y, z)`                                        | `camera.lookAt({ x, y, z })`                                                  | Cameras face −Z in both.                                                                                                                               |
| another camera                                                  | `view.camera = cam`                                                           | Added to `view.root` when it has no parent.                                                                                                            |
| `vector.project(camera)`                                        | `view.worldToScreen(point, out?)`                                             | Pixi global pixels; `null` behind the camera.                                                                                                          |
| `vector.unproject`, Raycaster.setFromCamera                     | `view.screenToRay(px)`, `view.screenToWorld(px, distance \| plane)`           | Pixels, not NDC.                                                                                                                                       |
| `setViewport` / setScissor (pixels, bottom-left)                | `camera.viewport.set(x, y, w, h)`                                             | Fractions of the view, top-left origin.                                                                                                                |
| setViewOffset for jitter                                        | `camera.jitter.set(x, y)`                                                     | Sub-pixel only.                                                                                                                                        |

## Controls (`@pixi/3d/extras`)

| Three.js                                                                                                                                                                                                                     | @pixi/3d                                                                                                                                        | note                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| new OrbitControls(camera, dom)                                                                                                                                                                                               | `new OrbitCamera({ view })`                                                                                                                     | Listens to the view's pointer events. Position the camera first; it adopts the current offset.                                                 |
| `.target.set(…)`                                                                                                                                                                                                             | `target` option, `orbit.target`                                                                                                                 | The option is copied.                                                                                                                          |
| `.enableDamping`, `.dampingFactor`, min/maxDistance, min/maxPolarAngle, min/maxAzimuthAngle, min/maxZoom, enableZoom/Rotate/Pan, zoom/rotate/panSpeed, `screenSpacePanning`, `zoomToCursor`, `autoRotate`, `autoRotateSpeed` | same names and defaults                                                                                                                         |                                                                                                                                                |
| `.mouseButtons = { LEFT: MOUSE.ROTATE, … }`                                                                                                                                                                                  | `mouseButtons: { left: 'rotate', middle: 'zoom', right: 'pan' }`                                                                                | String literals, merged over the defaults.                                                                                                     |
| .touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }                                                                                                                                                                       | `touches: { one: 'rotate', two: 'zoom-pan' }`                                                                                                   | Also `'zoom-rotate'`, `'pan'`, `'none'`.                                                                                                       |
| MapControls                                                                                                                                                                                                                  | `OrbitCamera` with `screenSpacePanning: false`, `mouseButtons: { left: 'pan', right: 'rotate' }`, `touches: { one: 'pan', two: 'zoom-rotate' }` |                                                                                                                                                |
| `controls.update()` every frame                                                                                                                                                                                              | `autoUpdate: false` + `orbit.update(ticker)` in `app.ticker`                                                                                    | The default `autoUpdate: true` runs on `Ticker.shared`, not `app.ticker`.                                                                      |
| rotateLeft(a) + rotateUp(b), `pan(dx, dy)`                                                                                                                                                                                   | `orbit.rotate(a, b)`, `orbit.pan(dx, dy)`                                                                                                       |                                                                                                                                                |
| dollyIn(s) / dollyOut(s)                                                                                                                                                                                                     | `orbit.zoom(s)`                                                                                                                                 | `s > 1` zooms in.                                                                                                                              |
| getPolarAngle(), getAzimuthalAngle(), getDistance()                                                                                                                                                                          | `orbit.polarAngle`, `orbit.azimuthAngle`, `orbit.distance`                                                                                      |                                                                                                                                                |
| `saveState()`, `reset()`, `enabled`                                                                                                                                                                                          | same                                                                                                                                            | `enabled = false` stops input only; `update()` keeps aiming the camera.                                                                        |
| `addEventListener('change' \| 'start' \| 'end')`                                                                                                                                                                             | `orbit.on('change' \| 'start' \| 'end')`                                                                                                        |                                                                                                                                                |
| `controls.dispose()`                                                                                                                                                                                                         | `orbit.destroy()`                                                                                                                               |                                                                                                                                                |
| PointerLockControls(camera, dom)                                                                                                                                                                                             | `new FPSCamera({ view, pointerLock: true })`                                                                                                    | Built-in WASD, arrows, Space and Shift; `moveSpeed` in units per second. It overwrites the camera rotation from `yaw`/`pitch` at construction. |
| .pointerSpeed                                                                                                                                                                                                                | `lookSpeed` (0.002 radians per pixel)                                                                                                           | Three's default is the same 0.002.                                                                                                             |
| `.lock()`, `.unlock()`, .isLocked                                                                                                                                                                                            | locks on pointerdown; `document.exitPointerLock()`; `fps.locked`                                                                                |                                                                                                                                                |
| moveForward(d) stays level                                                                                                                                                                                                   | walking follows the pitch                                                                                                                       | Re-pin `camera.position.y` after `update()` for a ground walker.                                                                               |

## Render targets and second cameras

| Three.js                                                         | @pixi/3d                                                                                                       | note                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| new WebGLRenderTarget(w, h, { samples: 4, type: HalfFloatType }) | `RenderTexture.create({ width, height, antialias: true, format: 'rgba16float' })`                              | pixi.js.                                                                               |
| `setRenderTarget(rt)` + `render(scene, cam2)`                    | `new Camera3D({ renderTexture: rt })` under `view.root`, plus a `MeshPass` naming that camera in `view.passes` | Without the pass the texture stays empty. [render-to-texture](../render-to-texture.md) |
| `rt.texture` on a material                                       | `baseColorTexture: rt` on a `FlatMaterial`, `PlaneGeometry({ flipV: true })`                                   | Holds the tone-mapped sRGB picture, stored top-down.                                   |
| `rt.setSize`, `rt.dispose()`                                     | `rt.resize(w, h)`, `rt.destroy(true)`                                                                          |                                                                                        |

## Post-processing

| Three.js                                          | @pixi/3d                                                                                                     | note                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| EffectComposer + `RenderPass`                     | `view.passes = [...]`, or the `passes` option                                                                | The scene pass is implicit.                                                                     |
| `OutputPass`                                      | built in                                                                                                     | Tone curve and encode run after the last `'beforeToneMapping'` effect.                          |
| `composer.render()`, `setSize`, setPixelRatio     | none                                                                                                         | Effects follow the view; `view.resolution` lowers the scene resolution.                         |
| `addPass`, insertPass, removePass                 | assign a new array                                                                                           | Mutating the array in place does nothing.                                                       |
| `pass.enabled`                                    | `effect.enabled`                                                                                             | Rebuilds the graph once; fine for toggles, not every frame.                                     |
| UnrealBloomPass(res, strength, radius, threshold) | `new BloomEffect({ intensity, radius, threshold, levels })`                                                  | Different threshold and falloff; retune by eye. [post-processing](../post-processing.md)        |
| SSAOPass                                          | `new SsaoEffect({ radius, intensity, bias, samples })`                                                       | `radius` is in world units; no conversion from kernelRadius.                                    |
| FXAAPass, ShaderPass(FXAAShader)                  | `new FxaaEffect()`                                                                                           | Only without `antialias`: MSAA carries through effects.                                         |
| ShaderPass({ uniforms, fragmentShader })          | a `PostEffect` subclass: `effect(uv)` in GLSL and WGSL, `sampleColor(uv)`, uniforms in a pixi `UniformGroup` | texture2D(tDiffuse, vUv) becomes `sampleColor(uv)`. `uv.y` runs down on WebGPU and up on WebGL. |
| a ShaderPass after `OutputPass`                   | `super({ stage: 'afterToneMapping' })`                                                                       | The default stage is `'beforeToneMapping'` (linear light).                                      |
| `OutlinePass`                                     | `OutlinePass` (extras)                                                                                       | A mesh-pass outline.                                                                            |
| `pass.dispose()`                                  | `effect.destroy()`                                                                                           | The view never destroys its passes.                                                             |

ShaderPass(VignetteShader) placed after `OutputPass`, as a `PostEffect`. Write the body twice, WGSL (`gpu`, uniforms under `fx.`) and GLSL (`gl`); uniform setters are yours to add.

```ts
import { PostEffect, View3D } from '@pixi/3d';
import type { EffectFragment, PostEffectOptions } from '@pixi/3d';
import { BloomEffect } from '@pixi/3d/extras';
import { UniformGroup } from 'pixi.js';

class VignetteEffect extends PostEffect {
  protected override readonly uniforms = new UniformGroup({
    uVignette: { value: new Float32Array([1.2, 1.0]), type: 'vec2<f32>' }, // offset, darkness
  });

  protected readonly fragment: EffectFragment = {
    gpu: /* wgsl */ `
fn effect(uv: vec2<f32>) -> vec4<f32> {
  let texel = sampleColor(uv);
  let d = (uv - vec2<f32>(0.5)) * fx.uVignette.x;
  return vec4<f32>(mix(texel.rgb, vec3<f32>(1.0 - fx.uVignette.y), dot(d, d)), texel.a);
}
`,
    gl: /* glsl */ `
vec4 effect(vec2 uv) {
  vec4 texel = sampleColor(uv);
  vec2 d = (uv - vec2(0.5)) * uVignette.x;
  return vec4(mix(texel.rgb, vec3(1.0 - uVignette.y), dot(d, d)), texel.a);
}
`,
  };

  constructor(options: PostEffectOptions = {}) {
    super({ stage: 'afterToneMapping', ...options }); // after the tone curve and encode, where OutputPass put three's
  }
}

// RenderPass, UnrealBloomPass, OutputPass, ShaderPass: the scene and output steps are built in.
const view = new View3D({ autoResize: true, passes: [new BloomEffect(), new VignetteEffect()] });
```

## Labels and sprites

| Three.js                                       | @pixi/3d                                                                                                     | note                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| CSS2DRenderer + CSS2DObject(el)                | Pixi `Text` on `app.stage` after the view, placed each tick from `view.worldToScreen(node.toGlobal(offset))` | Hide it when the result is `null`. Sort by distance yourself. [2d-and-3d-together](../2d-and-3d-together.md) |
| CSS2DObject.center (0.5, 0.5)                  | `text.anchor.set(0.5)`                                                                                       |                                                                                                              |
| new Sprite(new SpriteMaterial({ map, color })) | `new Sprite3D({ texture, tint, parent })`                                                                    | Unlit, double-sided, `alphaMode: 'blend'`, `castShadow: false`.                                              |
| `sprite.scale.set(w, h, 1)`                    | `width: w, height: h`                                                                                        | A three sprite is 1×1 at scale 1; `Sprite3D` is texture pixels × 0.01.                                       |
| `sprite.center (cx, cy)`                       | `anchor: { x: cx, y: 1 - cy }`                                                                               | Pixi y runs down.                                                                                            |
| always faces the camera                        | `billboardMode: 'spherical'` (default), `'cylindrical'`, `'none'`                                            |                                                                                                              |

## Lifetime

| Three.js                            | @pixi/3d                                                                          | note                                            |
| ----------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `geometry.dispose()` (usable after) | `geometry.unload()`; `geometry.destroy(true)` is final                            |                                                 |
| `material.dispose()`                | `material.unload()`; `material.destroy({ texture: true })` is final               |                                                 |
| `texture.dispose()`                 | `texture.source.unload()`; `texture.destroy(true)` or `Assets.unload(url)`        |                                                 |
| traverse and dispose everything     | `view.destroy({ children: true, geometry: true, material: true, texture: true })` | Every flag defaults to `false`.                 |
| none                                | `view.unload()`                                                                   | Frees the view's GPU state and keeps it usable. |
| `scene.remove(o)`                   | `view.root.removeChild(o)`                                                        | Frees nothing in either.                        |

## No direct equivalent

- `camera.layers`, `object.layers`: toggle `visible`, use a second `View3D`, or opt a material into a named pass with `passes: { name: true }` and a `MeshPass` of that name (additive; the mesh still draws in the main pass).
- setViewOffset, filmGauge, filmOffset, setFocalLength, getEffectiveFOV: none beyond `camera.jitter`.
- scene.backgroundBlurriness, backgroundIntensity, backgroundRotation, environmentIntensity, environmentRotation: none; a hemisphere's `up` rotates only that gradient.
- scene.overrideMaterial: a `MeshPass` with a `descriptor` redraws opted-in meshes with another shader but doesn't replace the main draw.
- AgXToneMapping, NeutralToneMapping, CineonToneMapping: none. `LinearToneMapping` is close to `'none'` with `exposure`. `'uncharted2'` is Hable's curve.
- VSMShadowMap: none.
- CSS3DRenderer: a `ContainerTexture` on a plane (Pixi content, not DOM).
- OrbitControls listenToKeyEvents, `keys`, keyPanSpeed, minTargetRadius, `cursor`: call `orbit.rotate` / `orbit.pan` from your own `keydown`.
- FirstPersonControls, FlyControls, TrackballControls, ArcballControls, TransformControls: none. DragControls: pointer events plus `view.screenToWorld` ([picking-and-input](../picking-and-input.md)).
- SMAA, TAA, SSR, GTAO, SAO, Film, Glitch, Halftone, DotScreen, LUT, Afterimage, RenderPixelated, Bokeh: write a `PostEffect`.
- `renderer.compile`, compileAsync, `renderer.info`, WebXR: none.
