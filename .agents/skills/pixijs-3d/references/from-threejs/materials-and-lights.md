Three.js materials, textures, lights and shadows mapped to `@pixi/3d`. Defaults are in brackets. Each note states what differs; a blank note means a plain rename. Behaviour that changes the picture is listed in [from-threejs.md](../from-threejs.md).

## Material classes

| Three.js                                           | @pixi/3d                                                    | note                                                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| MeshStandardMaterial                               | `Material3D`                                                | One options object, no positional arguments.                                                                    |
| MeshPhysicalMaterial                               | `Material3D` with extension groups                          | `clearcoat`, `sheen`, `transmission`, `iridescence`, `specular`, `anisotropy` are groups fixed at construction. |
| MeshBasicMaterial                                  | `FlatMaterial`                                              | Unlit.                                                                                                          |
| MeshLambertMaterial                                | `PhongMaterial({ specularStrength: 0 })`                    |                                                                                                                 |
| MeshPhongMaterial                                  | `PhongMaterial`                                             | Same Blinn-Phong maths and defaults.                                                                            |
| MeshToonMaterial                                   | `ToonMaterial` (extras)                                     | Different model, not divided by π, ignores `view.environment`.                                                  |
| LineBasicMaterial, PointsMaterial                  | `FlatMaterial` on a `'line-list'` / `'point-list'` geometry | Always 1 px.                                                                                                    |
| SpriteMaterial + `Sprite`                          | `Sprite3D`                                                  | See [renderer-and-scene](renderer-and-scene.md#labels-and-sprites).                                             |
| ShaderMaterial, RawShaderMaterial, onBeforeCompile | a `ShaderBit` in `extraBits`                                | Snippets per slot in WGSL and GLSL, no `main()`. [custom-shaders](../custom-shaders.md)                         |

## Common material properties

| Three.js                   | @pixi/3d                                                | note                                                                                                        |
| -------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `color` (white)            | `baseColor`                                             | Reads back as a hex number; assign, there's no `.set()`.                                                    |
| `map`                      | `baseColorTexture`; later `material.textures.baseColor` |                                                                                                             |
| `opacity`                  | `alpha`                                                 | Used only with `alphaMode: 'blend'`.                                                                        |
| `transparent: true`        | `alphaMode: 'blend'`                                    | Also turns depth writes off.                                                                                |
| alphaTest: x               | `alphaMode: 'mask', alphaCutoff: x` (0.5)               |                                                                                                             |
| depthWrite, `depthTest`    | `material.state.depthMask`, `state.depthTest`           | Set after `alphaMode` (its setter overwrites `depthMask`), then `mesh.invalidate()` if it has rendered.     |
| side: DoubleSide           | `doubleSided: true`                                     | Constructor only.                                                                                           |
| side: BackSide             | `material.state.cullMode = 'front'`                     | Normals aren't flipped, so lit interiors come out dark; use `doubleSided: true` for a lit room or sky dome. |
| blending: AdditiveBlending | `alphaMode: 'blend'` + `state.blendMode = 'add'`        |                                                                                                             |
| blending: MultiplyBlending | `state.blendMode = 'multiply'`                          |                                                                                                             |
| `vertexColors`             | `vertexColors`                                          | Geometry colours are RGBA in linear light.                                                                  |
| `flatShading`              | `flatShading`                                           | Constructor only.                                                                                           |
| `fog`                      | `fog`                                                   | Constructor only.                                                                                           |
| `wireframe`                | `WireframePass` (extras) or a `'line-list'` geometry    | Approximate.                                                                                                |
| needsUpdate = true         | none                                                    | Setters upload; a different shader shape needs a new material.                                              |
| `dispose()`                | `unload()` (reusable) / `destroy()`                     | `destroy({ texture: true })` also destroys its textures.                                                    |
| `clone()`                  | `clone(options)`                                        | Same class; the options you pass change on the copy. Textures are shared.                                   |

## MeshStandardMaterial → `Material3D`

| Three.js                                           | @pixi/3d                                          | note                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `roughness` (1)                                    | `roughness` (1)                                   |                                                                                                                                        |
| `metalness` (0)                                    | `metallic` (0)                                    |                                                                                                                                        |
| roughnessMap (G) + metalnessMap (B)                | `metallicRoughnessTexture` (G roughness, B metal) | One packed texture.                                                                                                                    |
| `normalMap`, `normalScale` (Vector2)               | `normalTexture`, `normalScale` (number)           |                                                                                                                                        |
| aoMap, aoMapIntensity                              | `occlusionTexture`, `occlusionStrength`           |                                                                                                                                        |
| `emissive` (black), emissiveIntensity, emissiveMap | `emissive: { color, strength, texture }`          | Opt-in group whose `color` defaults to **white**; without it `material.emissive` is `undefined`. Later: `material.emissive!.strength`. |
| envMap, envMapIntensity                            | none                                              | Only the view-wide `view.environment`.                                                                                                 |

## MeshPhysicalMaterial → `Material3D` groups

Pass a group at construction for it to exist; give it `factor: 0` if it turns on later.

| Three.js                                                                                              | @pixi/3d                                                                                                | note                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `ior` (1.5)                                                                                           | `ior` (1.5)                                                                                             |                                                  |
| `reflectivity`                                                                                        | `ior = (1 + 0.4 * r) / (1 - 0.4 * r)`                                                                   | Three's own formula.                             |
| `clearcoat`, `clearcoatRoughness`, maps                                                               | `clearcoat: { factor, roughness, texture, roughnessTexture, normalTexture, normalScale }`               | `factor` defaults to 1 once the group is passed. |
| `sheen` × `sheenColor`, `sheenRoughness` (**1**)                                                      | `sheen: { color: sheenColor × sheen, roughness }` (**0**)                                               | Pass the three values explicitly.                |
| `transmission`, `thickness`, `attenuationDistance`, `attenuationColor`                                | `transmission: { factor, thickness, attenuationDistance, attenuationColor, texture, thicknessTexture }` | Draws in its own pass.                           |
| specularIntensity, `specularColor`, maps                                                              | `specular: { factor, color, texture, colorTexture }`                                                    |                                                  |
| `iridescence`, iridescenceIOR, `iridescenceThicknessMinimum` (**100**), `iridescenceThicknessMaximum` | `iridescence: { factor, ior, thicknessMinimum (**0**), thicknessMaximum }`                              |                                                  |
| `anisotropy`, `anisotropyRotation`, anisotropyMap                                                     | `anisotropy: { strength, rotation, texture }`                                                           |                                                  |

## MeshPhongMaterial and MeshToonMaterial

| Three.js                       | @pixi/3d                                                           | note                                                                      |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `specular` (0x111111)          | `specularColor` (0x111111)                                         |                                                                           |
| `shininess` (30)               | `shininess` (30)                                                   |                                                                           |
| `specularMap`                  | `specularTexture` (R scales `specularStrength`)                    |                                                                           |
| Phong with `scene.environment` | environment adds diffuse only                                      | No env reflection term.                                                   |
| toon gradientMap               | `bands` (3), `specularSize`, `rimPower`, `rimIntensity`, `outline` | Closest to three's default: `bands: 1, rimIntensity: 0, specularSize: 0`. |

## Textures

| Three.js                                           | pixi.js / @pixi/3d                                                                                      | note                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| new TextureLoader().load(url)                      | `await Assets.load<Texture>(url)`                                                                       |                                                                                                                                                  |
| generateMipmaps (**true**)                         | `Assets.load({ src, data: { autoGenerateMipmaps: true } })` (**false**)                                 | Tiled textures shimmer without it.                                                                                                               |
| colorSpace = SRGBColorSpace                        | none                                                                                                    | Fixed by slot: base colour and emissive decode as sRGB, every other slot is linear.                                                              |
| `flipY` (true)                                     | none                                                                                                    | Images upload top row first; see the UV fixes in [from-threejs.md](../from-threejs.md).                                                          |
| `wrapS`, `wrapT` = RepeatWrapping                  | `texture.source.style.addressMode = 'repeat'`, then `style.update()`                                    | Also `addressModeU`/`V`, `'mirror-repeat'`.                                                                                                      |
| `repeat`, `offset`                                 | `material.uvTransform = new Matrix().scale(rx, ry).translate(ox, oy)`                                   | One transform per material, for every slot.                                                                                                      |
| `anisotropy`                                       | `source.style.maxAnisotropy` (capped at 16)                                                             |                                                                                                                                                  |
| `magFilter` / `minFilter` NearestFilter            | `source.style.scaleMode = 'nearest'`                                                                    | Or `magFilter`, `minFilter`, `mipmapFilter` one by one.                                                                                          |
| needsUpdate = true                                 | `texture.source.update()`                                                                               |                                                                                                                                                  |
| `CanvasTexture(canvas)`                            | `Texture.from(canvas)`, then `source.update()` after each redraw                                        | For Pixi 2D content, `ContainerTexture` ([render-to-texture](../render-to-texture.md)).                                                          |
| VideoTexture(video)                                | `Assets.load({ src, data: { autoPlay, loop } })`                                                        | Updates every frame by itself.                                                                                                                   |
| DataTexture(data, w, h)                            | `new Texture({ source: new BufferImageSource({ resource, width, height, format: 'rgba8unorm' }) })`     | Give the format; a bare `Uint8Array` defaults to `bgra8unorm`.                                                                                   |
| CubeTextureLoader().load([px, nx, py, ny, pz, nz]) | `CubeTexture.from({ faces: { right, left, top, bottom, front, back } })`, or `Assets.load('x.cubemap')` | Same order: right is +X, front is +Z.                                                                                                            |
| RGBELoader / HDRLoader + PMREM                     | `Assets.load<CubeTexture>('x.hdr')`                                                                     | A float cube, prefiltered on first use. [environment-and-sky](../environment-and-sky.md)                                                         |
| RoomEnvironment + fromScene                        | none                                                                                                    | Load an `.hdr`, or build float faces (`BufferImageSource`, `format: 'rgba16float'`) with values above 1; 8-bit faces light a PBR model too dark. |
| `texture.dispose()`                                | `texture.destroy(true)` or `Assets.unload(url)`                                                         |                                                                                                                                                  |

## Lights

| Three.js                                                  | @pixi/3d                                                                     | note                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `AmbientLight(color, 1)`                                  | `new AmbientLight({ color, intensity })` (0.5)                               | Same scale.                                                                      |
| HemisphereLight(sky, ground, i)                           | `environment: { skyColor, groundColor, intensity: i / Math.PI }` on the view | Also reflects on metals.                                                         |
| `DirectionalLight(color, i)` with `position` and `target` | `new DirectionalLight({ color, intensity })` + `lookAt(target)`              | Shines down local −Z. An unrotated light shines horizontally, not straight down. |
| `PointLight(color, i, distance, decay = 2)`               | `new PointLight({ color, intensity, range })`                                | `distance` → `range`; decay is always 2.                                         |
| `SpotLight(color, i, distance, angle, penumbra)`          | `new SpotLight({ color, intensity, range, coneAngle, penumbra })`            | `angle` radians → `coneAngle` **degrees** (60), both half-angles.                |
| `light.target`                                            | `light.lookAt(p)`                                                            | One-shot: call again after every move.                                           |
| `light.power`                                             | `intensity = power / (4π)` (point), `power / π` (spot)                       |                                                                                  |
| `light.color.set(x)`                                      | `light.color = x`                                                            |                                                                                  |
| any number of lights                                      | 32 directional, point and spot lights per view                               | Extra lights are ignored; ambient doesn't count.                                 |

## Shadows

| Three.js                                        | @pixi/3d                                                            | note                                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `light.castShadow` (false)                      | `castShadow` (false)                                                | Directional and spot lights only.                                                                                           |
| `mesh.castShadow` / `receiveShadow` (**false**) | `castShadow` / `receiveShadow` on `Mesh3D` and `Model3D` (**true**) | Set `castShadow: false` on floors and terrain.                                                                              |
| `shadow.mapSize`                                | `view.shadowQuality` (`'medium'`, 1024)                             | One size for every light.                                                                                                   |
| `shadow.bias` (0, set negative)                 | `shadow.bias` (0.001, **positive**)                                 | Opposite sign: negate, or keep the default.                                                                                 |
| `shadow.normalBias` (0)                         | `shadow.normalBias` (directional 3 texels, spot 0.15)               | Start from the defaults.                                                                                                    |
| shadow.camera.left/right/top/bottom/near/far    | `shadow: { bounds: Box.fromCenterSize(center, size) }`              | A world-space box. The default fits every caster each frame; past 256 casters call `light.fitShadowBounds()` after changes. |
| CSM addon                                       | `shadow: { cascades: 1–4, maxDistance, lambda }`                    | Directional only.                                                                                                           |
| `shadow.autoUpdate = false` + needsUpdate       | `shadow.update = 'manual'` + `light.refreshShadows()`               |                                                                                                                             |
| spot shadow far `distance \|\| 500`, near 0.5   | far `range \|\| 1000`, near 1                                       |                                                                                                                             |
| shadow-casting lights                           | 16 shadow maps (4 lights × 4 cascades)                              |                                                                                                                             |

## No direct equivalent

- RectAreaLight: a wide `SpotLight` with `penumbra: 1`.
- Point light shadows: use spot lights.
- `decay` other than 2, `shadow.intensity`, VSMShadowMap: none.
- LightProbe, `lightMap`: bake into `baseColorTexture` or an emissive map.
- Per-material envMap, envMapIntensity, scene.environmentIntensity for cube maps: only `view.environment`, and `intensity` for a hemisphere.
- EXRLoader, UltraHDRLoader, HDRCubeTextureLoader, an equirect background: `.hdr` and `.cubemap` only, both as cubes.
- bumpMap: convert to a normal map. displacementMap: a vertex shader bit (the shadow pass ignores it). alphaMap: bake into base colour alpha.
- alphaHash, alphaToCoverage, `premultipliedAlpha`, `dithering`, toneMapped: false, `stencil*`, depthFunc, colorWrite, clippingPlanes: none.
- `transparent` and alphaTest together: pick `'blend'` or `'mask'`, or add a discard bit.
- MeshNormalMaterial, MeshDepthMaterial, MeshMatcapMaterial, LineDashedMaterial, ShadowMaterial: a custom bit.
- PointsMaterial.size, sizeAttenuation: `ParticleContainer3D` ([objects-and-animation](objects-and-animation.md#points-and-lines)). `linewidth`: ribbon geometry.
- Per-texture `repeat`/`offset`/`rotation`/`center`, a second UV set: one `material.uvTransform`, one UV set.
- `defines`: one bit per variant, each on its own material.
- `dispersion`, diffuseRoughness: none.
