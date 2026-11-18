---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": patch
---

Board model cards show a recorded cover instead of downloading the model for a still. An editing stage given `uploadModelCover` stores the still it draws, or for an object model a still in the object's lighting, once per model file and look, and writes its URL to `props.snapshot.coverUrl`; a cover drawn for another look is ignored. `publicAssets.uploadBoardPreview` stores a cover under its content key, skipping the upload when one is already stored, and `renderModelStill` takes `clip` and `lighting` and returns the image with the model file's sha256. Model stills pose the item's clip, and Node exports draw a model's cover.
