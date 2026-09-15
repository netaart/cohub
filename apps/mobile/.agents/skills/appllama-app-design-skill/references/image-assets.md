# Image & illustration assets — generation pipeline

App-quality artwork is generated, curated, and post-processed — never "one
prompt, ship it". This is the pipeline.

## 1. Define the style system BEFORE generating anything

Write down, once per app:

- **Style family**: flat-duotone / gradient-mesh / 3D-clay / paper-collage /
  hand-drawn-ink / photographic. Pick ONE.
- **Palette**: 3–5 hexes lifted from the app's design tokens, including the
  exact surface color assets will sit on.
- **Lighting/texture**: soft top-left studio light, matte, no specular — or
  whatever fits; but the same words in every prompt.
- **Subject grammar**: mascot? abstract shapes? objects? People (and if so,
  what rendering style)?

Every asset prompt = style system + subject. This is what makes 12 assets
read as one commissioned set instead of 12 stock images.

## 2. Generate with the best tool available

Use whatever image generation capability is present in your environment — an
imagegen tool, the Higgsfield MCP/CLI, or another state-of-the-art model.
Rules:

- **Highest quality settings, largest size**, then downscale. Target at least
  2× the largest rendered size (an asset shown at 200 pt needs ≥ 1200 px for
  @3x). Never upscale a small generation.
- Generate **3–4 candidates** per asset, pick the best, regenerate the rest of
  the set to match the winner if the winner drifted in style.
- For icon sets and repeated elements, generate a **sheet** in one prompt
  (same lighting/palette guaranteed), then slice.
- Backgrounds: ask for the exact surface hex as a solid background, or true
  transparency if the tool supports it. Inspect edges at 400% — halos, matte
  fringes, or JPEG blocking around the subject mean regenerate or run a
  background-removal pass.

## 3. Prompt patterns that work

```
[subject], [style family] illustration, [palette words + hexes],
[lighting], solid background #0F0F13, centered composition,
generous negative space, app illustration, no text, no watermark
```

- Always append `no text` — models love baking in gibberish labels.
- For empty states: subject should be *quiet* (a resting object, a soft
  scene), not a busy hero.
- For celebration/success: motion implied by composition (confetti arcs,
  tilt), not literal speed lines.
- For onboarding heroes: leave the upper or lower third empty for the
  headline; say so in the prompt ("composition weighted to bottom half").

## 4. Post-process

1. Trim to content + consistent padding.
2. Export @1x/@2x/@3x PNG (or a single high-res + let expo-image scale, for
   full-bleed art). WebP for large photographic assets.
3. Verify on-device in BOTH themes: an asset generated on a dark ground often
   shows a halo on light ground. If the app is dual-theme, either generate
   theme twins or use assets on theme-invariant surfaces.
4. Check file sizes: a decorative illustration should not cost 2 MB. Target
   < 200 KB per screen-level asset after compression.

## 5. App icon & store assets

- App icon: generate at 1024×1024, no transparency, no rounded corners (the
  OS masks it). Test it at 60 px — if the concept dies small, simplify.
- Screenshot frames/marketing come later; do not let store-asset style drift
  from in-app style.

## 6. Quality gate

Reject an asset if ANY of:
- Style drifts from the set (different lighting, palette, line weight)
- Halo/fringe on its background at 400% zoom
- Baked-in text or watermark artifacts
- Composition fights the layout (subject cropped by safe areas, focal point
  under a button)
- Looks like clip-art / default-model-style with no art direction
