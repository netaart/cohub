---
"@neta-art/cohub": patch
---

`toGenerationTaskView()` outputs are media only. Text blocks, such as a revised prompt next to an image or a text-only refusal, stay in the raw result instead of listing as outputs; `GenerationOutputType` drops `"text"` and `GenerationTaskOutput` drops `text`.
