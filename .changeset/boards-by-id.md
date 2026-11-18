---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": patch
---

Boards stand on their own: `client.boards.byId(boardId)` binds a Board without a Space, and requests go to `/api/boards/:boardId`. A Board's home is the Space that created it (`spaceId` on reads and on `replica.state`); a `.board` file in any Space links it. Task and session cards show runs and chats of any Space, and their snapshots name that `spaceId`. `space.board(id)` is deprecated, `BoardClient` no longer has `spaceId`, and the replica cache now keys Boards by id alone, dropping earlier cached copies.
