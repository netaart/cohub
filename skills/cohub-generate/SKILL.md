---
name: cohub-generate
description: Generate or transform images, video, speech, music, and 3D models with Cohub multimodal models via `cohub generate`. Use when the user asks to create, edit, restyle, animate, remove backgrounds, synthesize speech (TTS), generate songs, or build 3D assets.
---

# Cohub Multimodal Generation

Use `cohub generate` to create or transform images, video, speech, music, and 3D models.

Prefer simple, explicit commands. Use `--json` when reading output for decisions, extracting URLs, or chaining commands. If a target Space is required, add `-s "$COHUB_SPACE_ID"` or an explicit Space ID.

## Installation

If `cohub` is unavailable, install it and check availability:

```bash
npm install -g @neta-art/cohub-cli
cohub --help
```

## Models

Always resolve models from the live list; do not hardcode a catalog.

```bash
cohub models ls --model-type multimodal --json
```

Typical categories: text-to-image / image editing, text-to-video / image-to-video, text-to-speech (TTS), background removal, music, 3D. Models with a `category` also carry it on each row of `models ls`.

Before using non-default parameters or reference media, inspect the model schema for supported inputs, roles, parameters, defaults, and examples:

```bash
cohub models show <model> --json
```

## Generate

Default to returning generated result links directly, with Markdown preview when possible (`![alt](url)` for images, direct links for video and audio). Save locally only when the user asks for a file download, local editing, or post-processing.

Generate from text:

```bash
cohub generate "a calm lake at sunrise" \
  --model <model>
```

Generate with reference media:

```bash
cohub generate "restyle this image" \
  --model <model> \
  --image ./input.png \
  --param size=1024x1024
```

Supported inputs: `--image`, `--video`, `--audio`, and `--3d`, each repeatable. Pass a URL or a local path; local files upload to an unlisted public URL first, so tasks store a reference instead of inline data. `--3d` takes GLB, glTF, OBJ, FBX, or STL, and a local file uploads with the type its extension implies. For files that must stay private, add `--inline` to keep them inside the task.

When a model requires input roles, prefix the path or URL:

```bash
cohub generate "smooth transition between two shots" \
  --model <model> \
  --image first_frame=https://example.com/first.png \
  --image last_frame=https://example.com/last.png

cohub generate "keep these characters consistent" \
  --model <model> \
  --image reference_image=https://example.com/a.png \
  --image reference_image=https://example.com/b.png

cohub generate "lip-sync to this spoken take" \
  --model <model> \
  --image reference_image=https://example.com/portrait.png \
  --audio reference_audio=https://example.com/speech.mp3
```

Roles include `first_frame`, `last_frame`, `reference_image`, `reference_video`, and `reference_audio`; a model may declare others, such as Meshy's `texture` image role. Check `models show` for what a model accepts. Do not mix first/last frame roles with reference roles. Seedance 2 reference audio needs an image or video in the same request.

Pass generation parameters with `--param key=value` (repeatable; JSON, number, or boolean values) or `--parameters '<json>'`:

```bash
cohub generate "cinematic drone shot over misty mountains" \
  --model <model> \
  --param duration=5 \
  --param resolution=720p \
  --param ratio=16:9
```

Array parameters take a JSON array, so quote the value:

```bash
cohub generate "a wooden treasure chest" \
  --model meshy \
  --param operation=text-to-3d \
  --param 'target_formats=["glb","usdz"]'
```

Results print their media facts when available, and videos their last frame:

```text
video 720×1280 · 11.0s: https://…/clip.mp4
  last frame: https://…/last.webp
```

With `--json`, the same facts are in `outputMedia` (`index` matches `output`).

Other useful flags:

```bash
cohub generate "..." --model <model> --output ./out.png   # save locally
cohub generate "..." --model <model> --async              # queue and return
cohub generate "..." --model <model> --timeout-ms 120000  # sync wait limit
cohub generate "..." --model <model> --meta '<json>'      # pass model metadata
```

## 3D models

A model with operations serves several functions. Its `operation` parameter names one, and that operation declares the inputs and parameters the request then accepts; `cohub models show <model>` lists them under Operations.

Meshy (`meshy`) offers `text-to-3d`, `text-to-3d-refine`, `image-to-3d`, `multi-image-to-3d`, `retexture`, `remesh`, `rigging`, `text-to-motion`, and `animation`. Its results list the model files first (one `3d` block per format, `meta.format` names it), then the stills and textures, then the turntable video:

```bash
cohub -s "$COHUB_SPACE_ID" generate "a wooden treasure chest with iron bands" \
  --model meshy \
  --param operation=text-to-3d \
  --param 'target_formats=["glb"]'
```

An operation that continues a Meshy task takes that task's output block back unchanged: its `meta.task_id` selects the task, and the provider rejects it after `meta.task_expires_at`. Pass it with `--block`:

```bash
cohub -s "$COHUB_SPACE_ID" generate "weathered oak planks and dark iron" \
  --model meshy \
  --param operation=text-to-3d-refine \
  --block "$(cohub tasks get <task-id> --json | jq -c '.run.result.output[0]')"
```

`retexture`, `remesh`, and `rigging` also take any model file through `--3d`. Operations that take no text omit the prompt:

```bash
cohub -s "$COHUB_SPACE_ID" generate -m meshy \
  --3d ./chest.glb \
  --param operation=remesh \
  --param topology=quad \
  --param target_polycount=10000
```

Animate a rigged character with preset actions, or with a `text-to-motion` clip passed as the `motion` role:

```bash
cohub -s "$COHUB_SPACE_ID" generate -m meshy \
  --block "$(cohub tasks get <rigging-task-id> --json | jq -c '.run.result.output[0]')" \
  --param operation=animation \
  --param 'action_ids=[10,25]'

cohub -s "$COHUB_SPACE_ID" generate -m meshy \
  --block "$(cohub tasks get <rigging-task-id> --json | jq -c '.run.result.output[0]')" \
  --block "$(cohub tasks get <motion-task-id> --json | jq -c '.run.result.output[0] | .meta.role = "motion"')" \
  --param operation=animation
```

## Speech (TTS)

Design a voice from text:

```bash
cohub generate "Welcome to Cohub. This voice was created from a description." \
  --model qwen-audio-3.0-tts-plus \
  --meta '{"voice_prompt":"A calm, clear male narrator with a warm tone"}'
```

Clone one voice from a public reference URL:

```bash
cohub generate "Welcome to Cohub. This voice follows the reference recording." \
  --model higgs-tts \
  --audio "$REFERENCE_AUDIO_URL"
```

## Workflows

Animate a still image:

```bash
cohub generate "<motion prompt>" \
  --model <model> \
  --image first_frame=./still.png
```

Continue a clip: pass its last frame as the next clip's first frame:

```bash
cohub generate "<next shot>" \
  --model <model> \
  --image first_frame=<last frame URL>
```

Edit or restyle with a reference image:

```bash
cohub generate "<edit instruction>" \
  --model <model> \
  --image ./input.png
```

For less common options, use `cohub generate -h`.

