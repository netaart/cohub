---
"@neta-art/cohub": minor
---

Board presence moves into the SDK. `createBoardPresence({ editor, channel: space.board(id) })` from `@neta-art/cohub/board/presence` shares selection, tool, viewport, cursor and gestures, follows reactions, and shows Agent and CLI writes as they land. Pass it to `mountBoardStage({ presence })` and the stage sends the cursor and draws others' selections, drags, strokes and reactions; `presence.cursors` and `presence.activities` are in surface pixels for the host to draw names and markers. One client per Board saves script commits without a `scriptLeader`. `board.updateAwareness(update)` now orders updates per connection, so senders no longer drop each other's updates; the `seq` argument is ignored.

Also: `board.replica({ userKey })` shares one started replica among a Board's views and follows playback commands sent through `board.control(command)` and `play`/`pause`/…; `claimBoardCaches(userKey)` removes another user's cached Boards and file URLs; replicas accept `readonly: true`, and `staticBoardRemote(id, document)` serves a fixed document. `selectBoardEditor(editor, selector)` gives framework stores a value that recomputes only when what it read changes; `editor.visibleRect` and `layoutBoardImages(images, view, { inset })` are public.

Hosts: replace your own awareness controller and script leader with `createBoardPresence`, and send awareness only through it, or with `updateAwareness(update)`.
