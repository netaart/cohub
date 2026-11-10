---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Board scripts can share effects with other viewers: `ctx.broadcast(type, data)` delivers an event to the same script on every viewer's screen, and `peerschange` / `ctx.peers` report the other viewers' cursors. Presence cursors carry `pressed`, and `presence.presses` places a peer's press for a click ripple. The script harness and `cohub boards simulate` gain `peers` and `broadcast` steps, and `cohub boards examples sparks` shows both. `createBoardPresence({ publish: "reactions" })` is now `"events"`, which shares broadcasts too.
