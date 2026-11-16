Three.js scene graph, maths, geometry, instancing, picking, loaders and animation mapped to `@pixi/3d`. Defaults are in brackets. Each note states what differs; a blank note means a plain rename. Behaviour that changes the picture is listed in [from-threejs.md](../from-threejs.md).

## Object3D → `Container3D`

| Three.js                                                 | @pixi/3d                                                                            | note                                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `Group`                                                  | `Container3D`                                                                       | Options: `{ label, position, rotation, quaternion, scale, visible, children, parent }`.       |
| `name` (`''`)                                            | `label`                                                                             | Unnamed glTF nodes are `node_<index>`; names aren't sanitised or de-duplicated as three does. |
| `add`, `remove`, `clear`, `removeFromParent`             | `addChild`, `removeChild`, `removeChildren`, `removeFromParent`                     |                                                                                               |
| `attach(child)`                                          | `reparentChild(child)`                                                              | Keeps the world transform.                                                                    |
| getObjectByName(n)                                       | `getChildByLabel(n, true)`                                                          | Pass `true` to search deep; never tests the node itself. Accepts a `RegExp`.                  |
| getObjectsByProperty('name', n)                          | `getChildrenByLabel(n, true)`                                                       |                                                                                               |
| `traverse(cb)`                                           | `traverse(cb)`                                                                      |                                                                                               |
| `position`, `scale`                                      | `position`, `scale`                                                                 | `scale.set(2)` and `scale = 2` set all three axes.                                            |
| `rotation` (`Euler`, any order)                          | `rotation` (radians, XYZ only); `angle` (degrees)                                   | Not synced with `quaternion`.                                                                 |
| `quaternion`                                             | `quaternion`                                                                        | Whichever of `rotation` and `quaternion` was written last wins.                               |
| `lookAt(v)`                                              | `lookAt({ x, y, z }, up?)`                                                          | Objects aim +Z; cameras and lights aim −Z, as in three.                                       |
| `matrix`, matrixWorld                                    | `localTransform`, `worldTransform`                                                  | `worldTransform` is current as of the last render; `getGlobalTransform(out)` computes it now. |
| updateMatrix(), updateMatrixWorld()                      | `updateLocalTransform()`, `getGlobalTransform()`                                    |                                                                                               |
| getWorldPosition(v)                                      | `getGlobalPosition(out?)`                                                           |                                                                                               |
| getWorldQuaternion, getWorldScale                        | `getGlobalTransform(m).decompose(p, q, s)`                                          |                                                                                               |
| getWorldDirection(v)                                     | `v.setFromMatrixColumn(node.getGlobalTransform(m), 2).normalize()`                  | Negate for cameras and lights.                                                                |
| localToWorld(v)                                          | `toGlobal(p, out?)`                                                                 | Returns a new `Vector3` unless you pass `out`.                                                |
| `worldToLocal(v)`                                        | `toLocal(p, from?, out?)`                                                           | The second argument is a source node.                                                         |
| rotateX/Y/Z, rotateOnAxis                                | `node.quaternion.multiply(q.setFromAxisAngle(axis, a))`                             |                                                                                               |
| rotateOnWorldAxis                                        | `node.quaternion.premultiply(q)`                                                    |                                                                                               |
| translateOnAxis                                          | `position.add(dir.applyQuaternion(node.quaternion).multiplyScalar(d))`              |                                                                                               |
| `castShadow`, `receiveShadow` (**false**)                | same names (**true** on `Mesh3D` and `Model3D`)                                     |                                                                                               |
| frustumCulled = false                                    | `view.cull` (`'gpu'`), `dynamic: true` geometry, or a bigger `bounds3D`             | No per-node switch.                                                                           |
| `clone()`                                                | `new Mesh3D({ geometry: m.geometry, material: m.material })`, `new Model3D(source)` |                                                                                               |
| `addEventListener('added' \| 'removed' \| 'childadded')` | `on('added' \| 'removed' \| 'childAdded')`                                          | Positional payload: `(child, container, index)`.                                              |
| Box3 scale fitting                                       | `width`, `height`, `depth`, `getSize()`, `setSize()`                                | Per-axis sizes stretch; scale uniformly for characters.                                       |

## Maths

Methods take an optional `out`; without it they change `this`.

| Three.js                                  | @pixi/3d                                                 | note                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `v.copy(a)`                               | `v.copyFrom(a)`                                          |                                                                                                         |
| `set(x, y, z)`, setScalar(s)              | `set(x, y = x, z = x)`                                   |                                                                                                         |
| `sub`, subVectors(a, b)                   | `subtract`, `a.subtract(b, out)`                         |                                                                                                         |
| addVectors, crossVectors, multiplyVectors | `a.add(b, out)`, `a.cross(b, out)`, `a.multiply(b, out)` |                                                                                                         |
| `length()`, `lengthSq()`                  | `magnitude()`, `magnitudeSquared()`                      |                                                                                                         |
| setFromMatrixPosition(m)                  | `setFromMatrixColumn(m, 3)`                              |                                                                                                         |
| applyEuler(e)                             | `applyQuaternion(q.setFromEuler(e))`                     |                                                                                                         |
| `Euler` with an order                     | `{ x, y, z }`, XYZ only                                  | For `'YXZ'`, compose `qy · qx · qz` from `setFromAxisAngle`.                                            |
| `q.invert()`                              | `q.inverse()`                                            |                                                                                                         |
| slerpQuaternions(a, b, t)                 | `a.slerp(b, t, out)`                                     |                                                                                                         |
| `m.invert()`                              | `m.getInverse(m)`                                        | `m.getInverse(src)` sets `m` to `src`'s inverse.                                                        |
| `m.elements`                              | `m.elements`                                             | Float32, column-major.                                                                                  |
| `makePerspective(l, r, t, b, near, far)`  | makePerspective(fovyRadians, aspect, near, far)          |                                                                                                         |
| Box3.setFromObject(o)                     | `o.getLocalBounds()`                                     | The node's own space, its own transform left out. World space: `.applyMatrix4(o.getGlobalTransform())`. |
| Box3.setFromObject(o).getCenter(v)        | `o.toGlobal(o.getLocalBounds().getCenter())`             |                                                                                                         |
| Box3.setFromCenterAndSize                 | `Box.fromCenterSize(center, size)`                       |                                                                                                         |
| box.getBoundingSphere()                   | `new Sphere().setFromBox(box)`                           |                                                                                                         |
| `Sphere`, `Ray`, `Plane`                  | same classes                                             | `Ray` adds `intersectSphereT`, `intersectBoxT`.                                                         |
| `Color`                                   | pixi.js `Color`                                          | sRGB components; `{ h, s, l }` with s and l in 0–100, as sRGB (three's setHSL is linear).               |
| MathUtils.degToRad(x)                     | `x * DEG_TO_RAD` (pixi.js)                               |                                                                                                         |
| `MathUtils.clamp`, `seededRandom`         | `clamp`, `seededRandom(seed: string)`                    | `seededRandom` returns a generator.                                                                     |

## BufferGeometry → `Geometry3D`

| Three.js                                                | @pixi/3d                                                                                  | note                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `new BufferGeometry()` + `setAttribute(...)`            | `new Geometry3D({ positions, normals, uvs, tangents, colors, joints, weights, indices })` | Item sizes fixed: 3, 3, 2, 4, 4, 4, 4. Colours are RGBA.               |
| attribute `position`, `normal`, `uv`, `color`           | `aPosition`, `aNormal`, `aUV`, `aColor`                                                   |                                                                        |
| setIndex([...])                                         | `indices: Uint16Array \| Uint32Array`                                                     | Plain arrays aren't accepted.                                          |
| attr.needsUpdate = true, DynamicDrawUsage               | `dynamic: true` at construction, then `geometry.attributes.aPosition.buffer.update()`     | Edits to a non-dynamic geometry never show. [geometry](../geometry.md) |
| setDrawRange(0, count)                                  | `indexCount` on a dynamic geometry                                                        |                                                                        |
| computeVertexNormals(), computeTangents()               | none                                                                                      | Compute in JS before constructing, or `flatShading: true`.             |
| reading attribute data                                  | `getAttributeData(geometry, 'aNormal', 3)`                                                | A float copy whatever the stored format.                               |
| boundingBox, `boundingSphere`                           | `bounds3D`, `boundsSphere`                                                                | Computed once, at construction.                                        |
| `translate`, rotateX, `scale`, `center`, `applyMatrix4` | none                                                                                      | Transform the arrays first, or use the node transform or `origin`.     |
| morphAttributes.position                                | `morphTargets: [{ positions, normals? }]`                                                 | Always relative offsets.                                               |
| `groups` + a material array                             | none                                                                                      | One `Mesh3D` per group.                                                |
| `dispose()`                                             | `unload()` / `destroy(true)`                                                              |                                                                        |

## Built-in geometries

All take one options object.

| Three.js r187                         | @pixi/3d                                                                               | difference                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| BoxGeometry(w, h, d)                  | `CubeGeometry({ width, height, depth })`                                               | Face images upside down.                                                                 |
| `PlaneGeometry(w, h)`                 | `PlaneGeometry({ width, height, flipV })`                                              | XY plane, +Z normal in both. Image upside down unless `flipV: true`.                     |
| `SphereGeometry(r, ws, hs)`           | `SphereGeometry({ radius, widthSegments, heightSegments })`                            | Image mirrored. No phi or theta ranges.                                                  |
| `CylinderGeometry(rt, rb, h = 1, rs)` | `CylinderGeometry({ radiusTop, radiusBottom, height = 2, radialSegments, openEnded })` | Default height 2; no `radius` option.                                                    |
| `ConeGeometry(r, h = 1)`              | `ConeGeometry({ radius, height = 2 })`                                                 | Default height 2.                                                                        |
| `CapsuleGeometry(r, length)`          | `CapsuleGeometry({ radius, height })`                                                  | `height` includes the caps: pixi height = three length + 2r.                             |
| `TorusGeometry(r, tube, rs, ts, arc)` | `TorusGeometry({ radius, tube, radialSegments, tubularSegments, arc })`                | Lies in **XZ** (three: XY); `rotation.x = Math.PI / 2` to match.                         |
| `TorusKnotGeometry(...)`              | `TorusKnotGeometry({ radius, tube, tubularSegments, radialSegments, p, q })`           | Winds around +Y (three: Z).                                                              |
| `IcosahedronGeometry(r, detail)`      | `IcosahedronGeometry({ radius, detail })`                                              | Same shape only at detail 0 and 1; smooth-shaded, so add `flatShading: true` for facets. |

## InstancedMesh → `BatchedMesh3D`

| Three.js                                         | @pixi/3d                                                                                                                                      | note                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| new InstancedMesh(geometry, material, count)     | `new BatchedMesh3D({ size })`, then per slot `setGeometryAt`, `setMaterialAt`, `setPassesAt(i, RenderPassBit.OPAQUE \| RenderPassBit.SHADOW)` | A slot without passes draws nothing. `count` → `size`.                            |
| `setMatrixAt(i, m)` + instanceMatrix.needsUpdate | `setMatrixAt(i, m)`                                                                                                                           | Uploads by itself. Bulk: `matrices.data` + `matrices.update()`.                   |
| dummy Object3D + updateMatrix()                  | `m.compose(position, quaternion, scale)` or `m.makeScale(...).setPosition(p)`                                                                 |                                                                                   |
| setColorAt(i, c) + instanceColor.needsUpdate     | `instanceData: { tint: {...} }` + a shader bit reading `instance.tint` + `setInstanceDataAt(i, 'tint', r, g, b, a)`                           | Linear colour. [instancing](../instancing.md)                                     |
| `count = n`                                      | `setVisibleAt(i, false)`                                                                                                                      |                                                                                   |
| frustumCulled = false                            | default (`cull: 'off'`)                                                                                                                       |                                                                                   |
| raycast instanceId                               | none                                                                                                                                          | Slots aren't pickable; test `view.screenToRay(px)` against your own volumes.      |
| plain `Mesh` copies                              | `Mesh3D` copies                                                                                                                               | Batched automatically when they share geometry, material kind and texture source. |

## Points and lines

| Three.js                            | @pixi/3d                                                                                 | note                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| LineSegments + LineBasicMaterial    | `Mesh3D` + `Geometry3D({ topology: 'line-list' })` + `FlatMaterial`, `castShadow: false` | 1 px.                                                        |
| `Line`                              | `topology: 'line-strip'`                                                                 |                                                              |
| LineLoop                            | `'line-strip'` with the first vertex repeated                                            |                                                              |
| `Points` + PointsMaterial({ size }) | `ParticleContainer3D`, below; `ParticleSystem3D` (extras) for emitters                   | `'point-list'` draws 1 px dots. [particles](../particles.md) |

`Points` with a ShaderMaterial carrying per-particle size, colour and alpha ports to `ParticleContainer3D` with no shader:

| Three.js                                             | @pixi/3d                                                            | note                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `Points(geometry, material)`                         | `new ParticleContainer3D({ texture, capacity, blendMode, parent })` |                                                                                                                                |
| position, size, colour, alpha attributes             | `setParticleAt(i, x, y, z, size, rotation, color, alpha)`           | `size` is a world-space diameter: the gl_PointSize scale uniform and its resize code go away.                                  |
| attribute.needsUpdate = true                         | `container.upload()` once per frame, after every write              | Nothing shows until `upload()`. On WebGL a second `upload()` in one frame drops the first range.                               |
| geometry.setDrawRange(0, count)                      | write `size` 0 into every slot freed since the last frame           | Otherwise dead particles stay frozen on screen.                                                                                |
| AdditiveBlending / NormalBlending, depthWrite: false | `blendMode: 'add' \| 'normal'`                                      | Depth writes are already off.                                                                                                  |
| renderOrder                                          | the container's `position`                                          | Blended containers sort back to front by node position; world-space particles ignore it, so offset `position.z` to order them. |
| colours through colorspace_fragment                  | hex numbers                                                         | Drawn as authored under `toneMapping: 'none'`.                                                                                 |
| frustumCulled = false                                | not needed                                                          |                                                                                                                                |

`ParticleSystem3D` emits and simulates for you, but has no live-particle count and a two-stop colour ramp; a CPU simulation with a longer ramp stays on `ParticleContainer3D`.

## Raycaster → picking

| Three.js                                       | @pixi/3d                                                                                     | note                                                                                                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| raycaster.setFromCamera(ndc, camera)           | `view.screenToRay(px)`                                                                       | Pixels in global space (`event.global`), not NDC.                                                                                                                       |
| intersectObjects(list, true)[0]                | `view.raycast(px)` → `RaycastHit3D \| null`                                                  | Closest hit only, among interactive nodes only.                                                                                                                         |
| a `pointerdown` listener + raycast             | `mesh.on('pointerdown' \| 'pointertap' \| 'pointerover', e => …)` with `eventMode: 'static'` | Default `eventMode` is `'passive'`, which neither hits nor blocks hits behind it. `e.hit3D` is reused; copy what you keep. [picking-and-input](../picking-and-input.md) |
| one listener for the whole scene               | `view.on('pointermove' \| 'pointertap', e => …)` reading `e.target3D`                        | Use `view.on`: the view's own `onpointermove`-style handlers run before the 3D dispatch.                                                                                |
| a DOM `click` (primary button)                 | `pointertap`                                                                                 | Fires for every button: check `e.button === 0`.                                                                                                                         |
| `hit.object`                                   | `hit.target`                                                                                 | The nearest interactive ancestor.                                                                                                                                       |
| `hit.point`, `distance`, `uv`                  | `point`, `distance`, `uv`, `localPoint`                                                      |                                                                                                                                                                         |
| `face.normal`, faceIndex                       | `normal` (flat, **world** space), `triangleIndex`                                            | Zero and −1 for box or sphere hits.                                                                                                                                     |
| triangle-accurate                              | bounding box by default                                                                      | `hitVolume: 'geometry'` for triangles; also `'box'`, a `Box`, a `Sphere`, a proxy geometry.                                                                             |
| invisible objects still hit; back faces culled | hidden nodes skipped; back faces hit                                                         |                                                                                                                                                                         |

## Loaders

| Three.js                                                                         | @pixi/3d                                                                                               | note                                                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| new GLTFLoader().loadAsync(url)                                                  | `await Assets.load<Scene3DSource>(url)`                                                                | Blob URLs: `Assets.load({ src, parser: 'glb' })`.                                                       |
| `gltf.scene`                                                                     | `new Model3D(source)` or `new Model3D({ source, autoPlay, castShadow, ... })`                          | The source is a shared template; build as many models as you like.                                      |
| `gltf.scenes`                                                                    | `source.scene` (by name), `new Model3D({ source, scene: 'Name' })`                                     |                                                                                                         |
| `material.name`, a clone per model (traverse, `o.material = o.material.clone()`) | `material.label`; `model.materials = (m) => m.clone()`                                                 | Models share the source's materials until given their own; a record keyed by label replaces named ones. |
| `gltf.animations`                                                                | `source.animations` (by name; unnamed `anim_<i>`, three animation_<i>), `model.player.animationLabels` |                                                                                                         |
| `gltf.cameras`                                                                   | `model.cameras`                                                                                        |                                                                                                         |
| DRACOLoader, setMeshoptDecoder                                                   | automatic                                                                                              | `setDracoDecoderPath({ jsUrl, wasmUrl })` overrides the gstatic default.                                |
| KTX2Loader                                                                       | `import 'pixi.js/ktx2'`                                                                                |                                                                                                         |
| LoadingManager.onProgress                                                        | `Assets.load(urls, (progress) => …)`                                                                   | 0 to 1; no per-item callback.                                                                           |
| glTF `extras`, userData                                                          | none                                                                                                   | Keep a `WeakMap` keyed by node.                                                                         |
| dispose a loaded model                                                           | `model.destroy({ children: true })`; `Assets.unload(url)` frees the source                             |                                                                                                         |

## Animation

| Three.js                                       | @pixi/3d                                                                                                        | note                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| new AnimationMixer(root)                       | `model.player`                                                                                                  | `undefined` when the file has no clips.                                                             |
| `mixer.update(dt)`                             | `autoUpdate: false` on the model + `model.player.update(ticker)`                                                | By default the player advances on `Ticker.shared` by itself; calling `update()` too advances twice. |
| mixer.clipAction(clip).play()                  | `player.play(label)` or `autoPlay: label`                                                                       | Neither stops other clips.                                                                          |
| clipAction(clip) without playing               | `player.getState(label)`                                                                                        |                                                                                                     |
| AnimationClip.findByName(clips, n)             | `source.animations[n]`, `player.getAnimation(n)`                                                                |                                                                                                     |
| `action.stop()`                                | `state.gotoAndStop(0)`                                                                                          | `state.stop()` only freezes.                                                                        |
| `action.paused = true`                         | `state.stop()`                                                                                                  |                                                                                                     |
| `action.reset().play()`                        | `state.gotoAndPlay(0)`                                                                                          |                                                                                                     |
| mixer.stopAllAction()                          | `player.stop()`                                                                                                 | Holds each pose.                                                                                    |
| action.isRunning()                             | `state.playing`                                                                                                 |                                                                                                     |
| `action.time`, `clip.duration`                 | `state.time`, `state.animation.duration`                                                                        | Seconds.                                                                                            |
| `timeScale`                                    | `animationSpeed`                                                                                                | Negative plays backwards.                                                                           |
| `weight`, setEffectiveWeight                   | `weight`                                                                                                        | A relative share between states, not a fade against the rest pose.                                  |
| setLoop(LoopOnce)                              | `loop = false`                                                                                                  | Always holds the last pose (clampWhenFinished).                                                     |
| crossFadeTo, `fadeIn`, fadeOut                 | ramp two states' `weight` in the ticker                                                                         | [models-and-animation](../models-and-animation.md)                                                  |
| `mixer.addEventListener('finished' \| 'loop')` | `state.onComplete`, `state.onLoop`                                                                              |                                                                                                     |
| new AnimationClip(name, duration, tracks)      | `new Animation({ label, tracks, duration })`                                                                    |                                                                                                     |
| VectorKeyframeTrack('node.position', t, v)     | `Vector3Track({ label: 'node.position', times, values, interpolation })`; also `QuaternionTrack`, `NumberTrack` | An unmatched node label is ignored silently.                                                        |
| InterpolateLinear, InterpolateDiscrete         | `'LINEAR'`, `'STEP'`                                                                                            |                                                                                                     |
| skeleton.getBoneByName(n), `bone.quaternion`   | `model.skeletons[0]`: `indexOf(n)`, `localRotation[i * 4]`, `dirty = true`                                      | Bones aren't scene nodes.                                                                           |
| mesh.morphTargetInfluences[i]                  | `mesh.weights[i]`                                                                                               | Write into the array; no morphTargetDictionary.                                                     |

## No direct equivalent

- Euler orders other than XYZ, quaternion to Euler: compose from `setFromAxisAngle` and keep your own angles.
- userData: a `WeakMap`.
- `layers`, renderOrder: `visible`, a second `View3D`, `mesh.enablePass` / `disablePass(name)`; transparent meshes sort by distance.
- matrixAutoUpdate = false, `applyMatrix4`: decompose into position, quaternion and scale.
- toNonIndexed, mergeVertices, geometry transforms: do it in JS before constructing.
- Circle, Ring, Lathe, Tube, Extrude, Shape, other polyhedra, EdgesGeometry, WireframeGeometry: a custom `Geometry3D`.
- Sized points, fat lines: particles, `Sprite3D`, ribbon geometry.
- getMatrixAt: keep your own matrices.
- `LOD`: swap `mesh.geometry` by camera distance ([instancing](../instancing.md#level-of-detail)).
- Every hit from a ray, or a ray from any origin into the scene: `Ray` maths against your own shapes.
- Attaching to a bone, `skeleton.pose()`, `SkeletonHelper`: none public.
- `warp`, syncWith, LoopPingPong, `repetitions`, additive clips, a mixer-wide `timeScale`: weight ramps and `onLoop` counts.
- Colour, boolean and string keyframe tracks: `NumberTrack` on numeric properties only.
- `MathUtils.lerp`, `smoothstep`, mapLinear, `damp`, randFloat, generateUUID: write them inline.
