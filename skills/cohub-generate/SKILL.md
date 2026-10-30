---
name: cohub-generate
description: Generate or transform images, video, speech, and music with Cohub multimodal models via `cohub generate`. Use when the user asks to create, edit, restyle, animate, remove backgrounds, synthesize speech (TTS), or generate songs.
---

# Cohub Multimodal Generation

Use `cohub generate` to create or transform images, video, speech, and music.

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

Typical categories: text-to-image / image editing, text-to-video / image-to-video, text-to-speech (TTS), background removal, music.

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

Supported inputs: `--image`, `--video`, and `--audio`, each repeatable. Pass a URL or a local path; local files upload to an unlisted public URL first, so tasks store a reference instead of inline data. For files that must stay private, add `--inline` to keep them inside the task.

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

Roles include `first_frame`, `last_frame`, `reference_image`, `reference_video`, and `reference_audio`. Check `models show` for what a model accepts. Do not mix first/last frame roles with reference roles. Seedance 2 reference audio needs an image or video in the same request.

## Text roles

Some multimodal models declare roles for their text inputs. Inspect them with:

```bash
cohub models show <model> --json
```

Pass each role as its own repeatable `--text <role>=<text>`. The value may contain `=` and newlines; quote multi-line values. The positional prompt is optional with `--text`, but when both are present the prompt is sent first without a role.

`song2` uses `prompt` (style), `lyrics`, and `abc` (score). The first call makes a song and, with `return_abc=true`, also returns the score it used as a text block with `meta.role` `abc` (the song's own output stays in `first-song.json`); the second sings the same lyrics from that score in another style:

```bash
LYRICS='[Verse]
Neon on the water, morning in the wires
We carry the quiet through the city lights
[Chorus]
Sing it back to sunrise, sing it back to me
Every little spark becomes a melody'

cohub generate -m song2 \
  --text "prompt=uplifting synthwave with warm analog pads and a clear chorus" \
  --text "lyrics=$LYRICS" \
  --param seed=42 \
  --param return_abc=true \
  --json > first-song.json
ABC=$(jq -r '.output[] | select(.type == "text" and .meta.role == "abc") | .text' first-song.json)

cohub generate -m song2 \
  --text "prompt=mellow acoustic folk, soft female vocal" \
  --text "lyrics=$LYRICS" \
  --text "abc=$ABC"
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

Pick the speech model from the catalog instead of a fixed id: run `cohub models ls --model-type multimodal`, then `cohub models show <model>` on the audio models. To design a voice, use one that declares `meta.voice_prompt`; to clone, use one whose input takes `audio`.

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
cohub generate "今天的风有点凉，我们去河边走一走，顺便买些热饮回来吧。" \
  --model "$TTS_MODEL" \
  --audio "$REFERENCE_AUDIO_URL" \
  --parameters '{"instructions":"请用非常缓慢的语速说话，每个字都慢慢说。"}'
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

