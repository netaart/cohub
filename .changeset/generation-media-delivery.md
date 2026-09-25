---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Lighter media delivery for generation results.

- SDK: `mediaPreviewCandidates()`, `imageVariantUrl()`, and `videoFrameUrl()` derive CDN image variants and video stills for OSS-backed hosts, in priority order with the original as fallback. `probeMediaInfo()` reads dimensions, duration, frame count, and first/last frames from OSS meta headers, then `image/info`. `publicAssets.uploadGenerationInput()` uploads a local generation input to an unlisted public URL.
- CLI: `cohub generate` uploads local `--image`/`--video`/`--audio` files instead of inlining base64 (inline stays the fallback), and prints each output's size, duration, and last frame; `--json` adds them as `outputMedia`.
- Task list views (`tasks.list`, `tasks.getMany`) no longer carry inline generation inputs; such blocks are marked `deferredBase64` and the full run stays available from `tasks.get`.
