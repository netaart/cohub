---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": patch
---

Board model cards take `props.model`: `view` (yaw and pitch in degrees, zoom 1 fits the model) sets the camera for the card's still and the view an entered model turns back to, and `animation` picks the clip that plays. Stills cache per view. An entered model pans with Shift+drag or two fingers, and arrow keys, `+`, `-` and `0` turn, zoom and return it through `stage.model.key()`; `stage.model.view` reads the entered model's view so it can become the cover. `ModelScene.key()` and `homeView` back both, and `boardModelViewKey` keys a view for caching.
