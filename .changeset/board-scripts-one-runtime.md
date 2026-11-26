---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Board scripts run in one engine everywhere: `cohub boards export`, `simulate` and `profile` run them in a headless Chrome, as the Cohub app does, instead of Node. Without an installed Chrome, Chromium or Edge, Chrome's headless shell downloads once, the first time a Board with scripts, shaders or 3D needs it. Exports with scripts draw several times faster: frames without shaders or 3D draw with Canvas 2D, and videos stream raw frames to ffmpeg instead of writing a PNG per frame. `script.time` lets a timeline drive a script's clock (`boards place` adds the track for a scripted item), modules import fonts, images and `.bin` files as bytes with `with { type: "bytes" }`, script workers can draw Canvas text in Geist and Geist Mono on every screen, `fetch()` in an export or simulation says there is no network, and `profile` reports what each script's updates and draws cost. `--at 33:35s` now fails instead of reading 33 as milliseconds. The SDK's Node script host is gone, and `board/testing` takes `scripts: { files, element }` and runs them in the page.
