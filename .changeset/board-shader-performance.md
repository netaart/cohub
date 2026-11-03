---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Board shaders open without a dark first frame and stay smooth: a Board script's filter covers the whole view instead of only the items drawn so far, full-box passes shade at most 1.5 device pixels per CSS pixel scaled by quality, programs compile once and in the background, script modules load in parallel, uniform changes skip recomposing the Board, collision fields rebuild at most 30 times a second, and invisible shadows or neutral filters no longer cost an offscreen pass. Shader passes can take their own `layer` and be switched with `ctx.passes()`; hit regions take `over: true`; `emit` reaches Board scripts; items' `script.params.*` animate; `Math.random()` is seeded in scripts; exports replay animated params and drop events instead of failing. The CLI shares one headless Chrome across commands, `boards simulate` hovers with `move` steps and draws shaders with `-o`, `boards profile` times each shader owner, and `boards export --async` runs as a Task.

Hosts: no action.
