# Sandbox environments

## Images

The existing `SANDBOX_IMAGE` remains the default. No new configuration is required for existing deployments. Set `SANDBOX_GAME_IMAGE` to register the optional game image. Use immutable image digests in production, or the release tags published by CI.

| Image | Contents |
| --- | --- |
| `default` | Existing language runtimes, NumPy, Chrome, Xvfb, FFmpeg and build tools; OpenGL/EGL loader libraries |
| `game` | All default tools plus Godot 4.5.2, Blender, Mesa software rendering, Vulkan diagnostics, SDL development libraries, CMake and Ninja |

Both images use the same runtime, UID, entrypoint and persistent storage mounts. The game profile adds a 256 MiB memory-backed `/dev/shm`, charged against container memory. Images do not request a GPU. Prefer Godot's Compatibility renderer; software rendering is not suitable for demanding real-time 3D workloads. Game images are available to all plans when configured; compute remains subject to the space owner's entitlement.

The current Blender build does not include OpenImageDenoise. For Cycles CPU rendering, explicitly set `scene.cycles.device = 'CPU'` and `scene.cycles.use_denoising = False`; no global Blender defaults are changed.

Godot export templates, Android SDK, .NET, Unity and Unreal are not bundled. Install project dependencies and any required export tools in persistent workspace directories. Files installed in the container writable layer are temporary and disappear on replacement.

## Preferences

Place `.cohub/sandbox.json` in a project or mod:

```json
{
  "version": 1,
  "image": "game",
  "spec": "boost"
}
```

`image` and `spec` are optional. Only `default`/`game` and `standard`/`boost`/`ultra` are accepted. Files must be valid JSON, at most 16 KiB, and must not escape their workspace. Arbitrary image references, commands, environment variables, mounts and privileges are not accepted.

Preferences merge per field, from lowest to highest priority:

1. Platform defaults (`default`, `standard`).
2. Enabled mods in their existing sort order; later mods override earlier mods.
3. Project file.
4. Explicit space configuration.

Mod preferences are read from the space's published head checkpoint via the existing cached checkpoint reader, not the mutable `latest` directory. Unsaved mod changes do not apply. Status retains each source and revision. A project imported after initial provisioning takes effect on the next sandbox restart.

New spaces inherit unspecified preferences. Existing saved specs remain explicit to avoid changing historical choices. Set an override to `null` to inherit again; an explicit `standard` is different from inheritance.

Unavailable file-requested images fall back to default; excessive compute is capped by the owner's plan. The original request and fallback reason remain visible. Explicit API selections exceeding entitlement or selecting an unregistered image are rejected. Billing lookup failures log a warning and conservatively use standard compute.

Invalid file configurations remain visible in GET status and do not prevent editing settings. Provisioning rejects them before invalidating or deleting an existing Pod, unless both image and spec are explicitly overridden. Resolve the file error or explicitly override both fields before restarting.

File edits and new mod checkpoints do not automatically restart a running sandbox. GET config computes pending changes; the next create, resume, manual restart or recovery resolves preferences again. Mod mount operations retain their existing restart behavior. Local sandboxes are not modified by cloud preferences.

## API and CLI

`GET /api/spaces/:id/config` includes `sandbox.image` and `sandbox.preferences`: requested, effective and applied configuration, explicit overrides, source revisions/errors, warnings, registered images, applicability and pending restart.

```ts
await client.spaces.create({ name: "Game", config: { sandbox: { image: "game" } } });
await client.space(id).updateConfig({ sandbox: { image: "game", spec: "boost" } });
await client.space(id).updateConfig({ sandbox: { image: null, spec: null } });
```

```bash
cohub spaces create --name Game --image game
cohub spaces config SPACE_ID --image game --spec boost
cohub spaces config SPACE_ID --image auto --spec auto
cohub spaces config SPACE_ID --json
```

Image changes require restart. Explicit compute changes retain Kubernetes in-place resize when the image is unchanged. Workspace and asset PVCs are not removed or reinitialized when switching images.

## Build and release

```bash
docker buildx bake -f apps/sandbox/docker-bake.hcl --load

docker build apps/sandbox -t sandbox-default
docker build apps/sandbox --target game -t sandbox-game

docker run --rm --entrypoint bash --shm-size=256m \
  -v "$PWD/apps/sandbox/scripts:/smoke:ro" sandbox-game /smoke/smoke-image.sh game
```

CI builds and smoke-tests both targets on the same builder before publishing. Sharing the `base` build allows the images to reuse its layer digests on the registry and on nodes that use both profiles; actual savings depend on the resulting layers and node cache. A shared source revision produces `cohub-sandbox` and `cohub-sandbox-game` tags. Deployment only advances after the build job succeeds, updating both image configuration keys in one ConfigMap patch. Manual workflows refresh the CLI layer in both images. Default builds remain compatible without `--target`.

`apps/sandbox/docker-bake.ci.hcl` adds cache settings on top of the local Bake file, so local builds never require registry or Actions cache credentials. CI imports the inline cache from the published `:latest` images first, so unchanged layers keep their digests across releases and nodes only pull what changed (usually the `cohub-sandbox` binary). The `node` base image is pinned by digest for the same reason; bump it deliberately. Tool versions in the Dockerfile (Go, Chrome for Testing, Bun, pnpm) are pinned and bumped deliberately; `@neta-art/cohub-cli` intentionally tracks npm `latest` and is refreshed with `COHUB_CLI_REFRESH`.

### Release-time image prewarming

Before patching the prod API image configuration, CI runs `scripts/prewarm-sandbox.py` for both images; dev releases too often for prewarming to pay off. It creates a temporary DaemonSet in `cohub-sessions` on the API's `SANDBOX_NODE_SELECTOR` / `SANDBOX_TOLERATIONS` nodes, waits until every node is ready, then deletes it. Each Pod runs two unprivileged `/bin/sleep` containers with the exact images and `IfNotPresent`; no sandbox process or PVC is involved. The step is best-effort (`continue-on-error`) and times out after 600 seconds.

```bash
python3 scripts/prewarm-sandbox.py --env dev \
  --image REGISTRY/cohub-sandbox:VERSION \
  --image REGISTRY/cohub-sandbox-game:VERSION --dry-run
```

Settings must come from ConfigMaps or literal env values; an empty node selector is rejected. The CI identity needs DaemonSet create/get/delete and Pod/event read access in the sessions namespace. Nodes added later pull on first use. Use fresh tags or digests. If a killed runner leaves a DaemonSet, delete that printed name only.

### Verification and rollout

Smoke tests verify sandbox health, installed runtimes, NumPy, Godot import and software-rendered editor startup, OpenGL availability, Blender CPU rendering and GLB export. Record compressed image size and cold-start timings in the deployment environment before production rollout; these depend on registry and node cache state.

```bash
pnpm rollout:sandbox:dev --dry-run
pnpm rollout:sandbox:prod --image game --dry-run
pnpm rollout:sandbox:prod --image game --limit 5
```

Rollout resolves a target per running cloud space, uses bounded planning concurrency, supports `--image default|game` and leaves dormant/local sandboxes alone. Review the dry-run plan before replacement. Restore the relevant image configuration to its previous tag/digest and rerun the same filtered rollout to roll back; do not change game spaces to the default image as a version rollback.

## Deferred

GPU node pools/quotas/billing, custom images, Android/.NET toolchains and immutable mod mount generations are separate features. No arbitrary container configuration or dynamic image builder is introduced here.
