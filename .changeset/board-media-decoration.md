---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Images and videos take `props.decoration: "card" | "none"`, and frames take a `contentDecoration` the images and videos inside inherit. Bare media draw only the picture, keeping transparency, with no card, tag, play key or placeholder, in every theme and in far views. A script's temporary images and videos are bare by default, so game scenes no longer show photo cards in the pixel themes. `BoardScene.decorated(id)` and `boardItemDecorated(lookup, id)` resolve it for hosts with their own renderers, and `boardMediaActionAt` takes it as an optional `decorated`; the editor's `selectionBare` and `setSelectionBare()` toggle it for frames, images and videos, and the web selection toolbar's "Show contents only" does the same.
