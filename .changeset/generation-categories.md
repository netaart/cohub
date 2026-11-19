---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Generation models are organized by their declared `category`. `cohub models ls --model-type multimodal` adds a Category column, sorts by category, and accepts `--category image|video|audio|3d|decision`; `cohub models show` prints the category. The SDK exports `GENERATION_CATEGORIES`, `generationModelCategory`, and `groupGenerationModelsByCategory`. Generation billing derives its usage type from the same category, and audio models now record `generation.audio`.
