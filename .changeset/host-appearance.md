---
"@neta-art/cohub": minor
---

The host bridge adds the `appearance` capability: `appearance.set({ backgroundColor })` reports the `#rrggbb` color a surface paints at its edges, so a native host can match its window and system bars to it and pick legible status bar icons. `hostColorSchema` validates the color.

宿主桥新增 `appearance` 能力：`appearance.set({ backgroundColor })` 上报界面边缘使用的 `#rrggbb` 颜色，原生宿主据此统一窗口与系统栏的颜色，并选择清晰可辨的状态栏图标颜色。颜色格式由 `hostColorSchema` 校验。
