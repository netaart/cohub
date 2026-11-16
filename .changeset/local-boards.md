---
"@neta-art/cohub-cli": minor
---

Local Boards: a `.board.json` path is a Board without a Space. `boards create`, `get`, `apply`, `inspect`, `frames`, `export`, `simulate` and `history` work on the file, with media and script paths relative to its folder, a lock around every write and a history beside it. `boards open <file>` serves the Board on 127.0.0.1 with the web Board panel; edits there and from the CLI merge live, and pasted images are saved to the Board's `assets/` folder.
