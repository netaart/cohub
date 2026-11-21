---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Images and videos take `props.presentation: "card" | "plain"`, and frames take a `presentation` their images and videos inherit. Plain media draw only the picture, keeping transparency, with no placeholder while loading and no tap to open, in every theme. A script's temporary images and videos are plain by default, so game scenes no longer show photo cards in the pixel themes. `boardMediaPresentation(item, lookup)` resolves the value for hosts with their own media renderers.
