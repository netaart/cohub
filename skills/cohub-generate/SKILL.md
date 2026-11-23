---
name: cohub-generate
description: Generate or transform images, video, speech, and music with Cohub multimodal models via `cohub generate`. Use when the user asks to create, edit, restyle, animate, remove backgrounds, synthesize speech (TTS), or generate songs.
---

# Cohub Multimodal Generation

Use `cohub generate` to create or transform images, video, speech, and music.

Prefer simple, explicit commands. Use `--json` when reading output for decisions, extracting URLs, or chaining commands. Commands target the current Space; for another, pass `-s <id>` or `-s <username>/<slug>`.

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
cohub models ls --model-type multimodal --category video --json
```

Each model declares the `category` it produces: `image`, `video`, `audio` (speech and music), `3d`, or `decision`. Filter by category first, then compare the candidates' inputs: text-to-video and image-to-video are both `video`.

Before using non-default parameters or reference media, inspect the model schema for supported inputs, roles, parameters, defaults, and examples:

```bash
cohub models show <model> --json
```

## Generate

Default to returning generated result links directly, with Markdown preview when possible (`![alt](url)` for images, direct links for video and audio). For several images, give each a short distinct alt (shown as its title) and list them with no text in between so chat groups them as a gallery. Save locally only when the user asks for a file download, local editing, or post-processing.

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

Supported inputs: `--image`, `--video`, `--audio`, and `--3d`, each repeatable. Pass a URL or a local path; local files upload to an unlisted public URL first, so tasks store a reference instead of inline data. For files that must stay private, add `--inline` to keep them inside the task.

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

Roles include `first_frame`, `last_frame`, `reference_image`, `reference_video`, `reference_audio`, and `motion` (3D). `models show` lists the roles a model accepts and its rules for combining them. To chain steps, such as rigging then animating a 3D model, pass the previous output's URL rather than a downloaded file.

## Text roles

Some models take several text inputs by role; `models show` lists them. Pass each as its own `--text <role>=<text>`; values may contain `=` and newlines. A positional prompt is sent first, without a role.

```bash
cohub generate -m song2 --text "prompt=uplifting synthwave" --text "lyrics=$LYRICS"
```

Pass generation parameters with `--param key=value` (repeatable; JSON, number, or boolean values) or `--parameters '<json>'`:

```bash
cohub generate "cinematic drone shot over misty mountains" \
  --model <model> \
  --param duration=5 \
  --param resolution=720p \
  --param ratio=16:9
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

## Speech (TTS)

Pick the speech model from the catalog instead of a fixed id: run `cohub models ls --model-type multimodal --category audio`, then `cohub models show <model>` on the candidates. To design a voice, use one that declares `meta.voice_prompt`; to clone, use one whose input takes `audio`.

```bash
TTS_MODEL=<model id from the catalog>
```

Design a voice from text:

```bash
cohub generate "Welcome to Cohub. This voice was created from a description." \
  --model "$TTS_MODEL" \
  --meta '{"voice_prompt":"A calm, clear male narrator with a warm tone"}'
```

Clone one voice from a public reference URL:

```bash
cohub generate "Welcome to Cohub. This voice follows the reference recording." \
  --model "$TTS_MODEL" \
  --audio "$REFERENCE_AUDIO_URL"
```

When `cohub models show "$TTS_MODEL"` lists an `instructions` parameter, it directs how the whole text is spoken. Pass it with `--parameters` so the value stays a string:

```bash
cohub generate "The wind is cool today. Let's walk by the river and get something warm to drink." \
  --model "$TTS_MODEL" \
  --audio "$REFERENCE_AUDIO_URL" \
  --parameters '{"instructions":"Speak very slowly, word by word."}'
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
