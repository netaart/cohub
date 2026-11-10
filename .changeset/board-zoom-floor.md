---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": patch
---

A Board larger than what 5% zoom shows can now be zoomed out until it fits, by wheel, pinch or the zoom buttons, and Fit shows all of it. `boardZoomFloor(content, surface)` gives that limit, and `clampZoom` takes it as an optional floor. Animation cameras and exports keep the zoom they are given down to 0.1%, so a tour's overview stop shows the whole map.
