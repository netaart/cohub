---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Displays record and replay. `cohub spaces displays record start | stop | ls` records a screen into the Space folder (`.cache/cohub/displays/recordings/`) from the video it already streams, with no second encoder; `--auto` records agents' plans instead; `record stop --auto` ends that. Recording pauses while the screen reports a focused password field, or a person steps in. The SDK adds `displays.record()`, `stopRecording()`, `recordings()` and `steps(turnId)`, the plans a Turn ran, which sandboxd logs for replay.

`cohub spaces displays windows` lists a desktop's windows, and `--window <id>` on `look`, `capture`, `tree` and `act` reads one alone, in its own coordinates. A plan that stops now says what to do next: sandboxd adds `stopped.hint`, which names no command, and `stopped.next` (`look`, `lookImage` or `list`), a read safe to run as is, which the CLI prints as a command. A step that set a field says `readBack` when the field holds the text. Live sessions get the agent's pointer (`pointer` events) and the other viewers' cursors (`cursors`, `sendCursor()`).

Needs a sandboxd with display recording; older ones answer `display_unsupported`.
