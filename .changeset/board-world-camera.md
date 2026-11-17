---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

The Board camera can tip and turn: camera tracks, `ctx.present("camera", …)` and `#view=x,y,zoom,pitch,bearing` links take `pitch` (0–60° toward the horizon) and `bearing` (degrees clockwise), both about the middle of the view. A tipped camera shows the flat Board as ground in perspective with lifted items and model objects standing on it, keeps script screen layers on screen, and lets viewers pan and zoom across the ground; editing levels it first, and `--camera` exports keep it. Model objects lean toward a camera that looks down and stand up under a low one, with `rotation` turning them about their own axis. `attach: { item, node? }` makes an item follow another's origin, and with `node` ride a named node of a model object in 3D; loaded models record their nodes in `props.snapshot.nodes`, which the CLI reads from sandbox glTF files.

Depth geometry is now in board units with z up, the same at every camera: `boardDepthSurface(placement)` no longer takes a view, `boardDepthPose`, `hitBoardDepthSurface`, `boardDepthScreenPoint` and `boardDepthShadow` take a `BoardProjection` from `boardProjection(camera, size)`, and `BoardDepthStage.aim(projection)` replaces `resize`. `BoardViewport` adds optional `pitch` and `bearing`; `boardViewToWorld`, `boardViewRect`, `panBoardView` and `zoomBoardView` handle every camera. `toBoardPointerEvent` takes a screen-to-Board function instead of a camera, `editor.adoptModelFacts` replaces `adoptModelClips`, and `readBoardModelFacts` replaces `readBoardModelClips`.
