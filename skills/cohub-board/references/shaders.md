# Shaders and performance

A module that exports `shader` draws on the GPU: GLSL passes, instanced sprites,
filters, persistent state, and `surface()` collisions with cards. The `shader` section of
`cohub boards schema script` has the full API. `examples rain` is a complete Board
shader whose rain splashes on cards:

```bash
cohub boards examples rain --module > scripts/rain.js
cohub boards apply <board> '{"board":{"scripts":{"rain":{"src":"scripts/rain.js"}}}}'
cohub boards simulate <board>                  # compiles shaders and reports errors
cohub boards export <board> -o /tmp/rain.png
```

## Check

- After writing a shader, run `simulate` to compile it. Then check the pixels in an
  exported image, since `inspect` does not see them.
- Exports render shaders in a shared local Chrome. Their warnings name any shader that
  did not draw and why: hidden, clipped, every pass off, or failed to compile.
- A clipping Frame keeps its own passes in its box; `clip: false` lets them spill out.
  `export --frame <id>` draws the frame as a page, its shaders included.
- Browser frames are capped at 16 megapixels, and scale goes down past that. Prefer
  `--camera` or a region to a whole large Board.

## Keep it smooth

- A pass with a `name` switches with `ctx.passes()` and costs nothing while off. Turn a
  full-view `filter` on only while it shows.
- Drive motion through `ctx.uniforms()` instead of presenting items every frame.
  Present shadows or filters only while they change.
- Give a box pass `texel` when its picture changes only every few units, as with pixel
  art and maps.
- Keep shared data such as sprite sheets in an imported `.json` module.
- Measure with `cohub boards profile <board>`. It times each shader owner (median and
  range over rounds), says whether it ran on software WebGL, and names what to change.
  Compare its numbers with each other, not with a real display.
