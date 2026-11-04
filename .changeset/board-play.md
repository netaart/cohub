---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Board Apps open in play. Every visitor gets a local copy of the Board: dragging an unlocked item moves it, dragging elsewhere pans, script regions take every press, and script commits succeed on that copy. The new `play` tool does this in any editor, and `cohub boards simulate` accepts `{"tool": "play"}` to check what visitors get. Read-only viewers now see `ctx.capabilities.has("board.commit")` as false, in the app and in `boards simulate`. Board App content carries its `versionId`, and `client.rooms.open({ appId, code, create })` joins an App's room by code on the viewer's behalf, creating it when nobody has.

Hosts: no action.
