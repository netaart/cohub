---
"@neta-art/cohub-cli": minor
---

`boards export --at 0:217s --fps 24` exports a range at a frame rate, and a written step that is rounded, such as `41.667ms`, no longer drops the last frame. `boards apply --replace` on a Board that has items now needs `--base-version`; without it the command names the Board and its version instead of deleting what the input leaves out. `boards apply` also prints a warning for style an item never draws, such as a text stroke or the fill of a `decoration: "none"` frame.
