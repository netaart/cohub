---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

`cohub boards simulate` previews what a viewer sees: `--mode edit|play|view`, `--viewport WxH` and `--pointer coarse|fine` set the device (`ctx.env`, `ctx.view`), `--camera` draws the screen following the camera scripts direct, HUDs included (`--no-screen` drops them), and `-o` takes `--at` frames as a `%d` sequence or a video, with the same options as `export`. `export --inputs` also runs simulate steps files, `export` and `simulate` take `--view x,y,zoom[,pitch,bearing]` for a temporary camera, and `export --screen` draws screen layers. Browser frames are capped at 16 megapixels; a forced GPU export with 3D no longer starts a second browser that kept the command from exiting, the shared browser frees a caller's models when it leaves, and shaders outside the exported area are no longer reported. The SDK harness takes `mode`, `viewport` and `view` in place of `readonly` and `tool`, follows directed cameras and exposes `view` and `env`; `prepareBoardExport` takes `view`, `viewport` and `screen`. `simulate -o --json` reports the files as `export --json` does.
