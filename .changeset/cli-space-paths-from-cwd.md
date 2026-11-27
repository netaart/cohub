---
"@neta-art/cohub-cli": minor
---

Space path arguments are relative to the current directory, like shell paths, when it is inside the Space's workspace (`/workspace` in its sandbox, or a Runtime directory): `boards`, `spaces files`, `apps publish --file/--dir` and `desktop open` resolve `ep2.board` from where you are instead of the Space root. Paths written inside documents, such as a Board's `src`, stay relative to the Space root.
