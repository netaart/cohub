---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Board shows survive live writes: editing the playing animation, tracks included, no longer stops a shared playback (only deleting it does), and the `stopped` playback status is gone. A viewer who pans during a tipped shot keeps its angle, and every new playback brings viewers back to its camera. The stage loads the images of the next 3 seconds of a playback, past a pause marker it holds at, at the size they grow to. Exports give scripts the camera they draw, pitch and bearing included, and reach far frames without a script timeout; `ctx.view` is set only for `viewchange` listeners everywhere. `boards simulate` reports scripts' console lines (`logs` in `--json`), `boards get --only playback` reads just the playback, `-i` accepts pipes such as `<(…)`, and `spaces turns intermediate --tool-calls` adds every tool call's full input and result. The SDK adds `turns.intermediate.listToolCalls()`, signing archived tool calls in batches.
