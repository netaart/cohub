---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Board models play their clips by one rule everywhere: `props.model.animation` crossfades over `fade` ms when it changes, an `autoplay` model plays on the Board clock, `time` drives a clip from a track or a script, and `loop: false` holds the last pose. Loaded models record their clips in `props.snapshot.clips`. Scripts direct the camera with `ctx.present("camera", { focus, zoom, center, shake })`, which play and read-only views follow until the viewer pans (the app offers Back to the camera) and editing ignores. Exports draw model objects in their pose and model cards as stills, and `--camera` exports follow the script camera. `renderBoardExport` takes `models` from `loadBoardObjectModels`; the stage adds `loadModels` and `scriptCamera`; `BoardScriptHost` adds `camera`; the test harness adds `camera`. The CLI records clips of sandbox glTF files on `create` and `apply`, renders model cards and objects in local Chrome, reports the directed camera in `boards simulate`, and adds `boards examples arena`.

Hosts: an export bridge built on `exportBoardImage` passes `loadModels: (items) => stage.loadModels(items)`; show a "Back to the camera" control while `stage.scriptCamera` is true and `editor.cameraPolicy` is `"free"`, setting the policy to `"follow"`.
