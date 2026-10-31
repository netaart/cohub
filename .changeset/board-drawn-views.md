---
"@neta-art/cohub": minor
---

Board DOM views can be drawn into the canvas where the browser supports HTML-in-Canvas: a view that calls `context.setDrawable(true)` takes its item's z-order, frame clip, opacity, animations and the presentation mask, while its content keeps input and accessibility. `context.drawn` and `context.canDraw` tell the view how it is shown, `BoardStage.viewTextures` and the `viewTextures` export option draw it in exports, and `BoardStageStats.views` reports drawn views and raster time. Low-tier devices and Save-Data skip drawing (`BoardDeviceBudget.drawViews`), and the stage's `drawViews: false` turns it off. `BoardScene.syncViews` places the textures.
