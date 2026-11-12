---
"@neta-art/cohub": minor
---

Board touch input is more forgiving: a press shorter than a long press opens a card, a finger may wobble 12px (`BOARD_INPUT.dragSlop.touch`) before a press turns into a drag, a touch on a nearly stopped fling taps through, card keys take touches within `BOARD_INPUT.touchHitSlop`, the hand tool opens a selected card, and a drag away from the selection pans without dropping it. New: `handClick: "pick"` on `createBoardEditor` lets a mouse click with the hand tool select and then open items (with a pointer cursor over them), `registry.activation()` receives the pointer type, and `createGhostClickGuard` is exported from `@neta-art/cohub/board/stage`.

Hosts: no action
