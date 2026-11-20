---
"@neta-art/cohub": minor
---

Board stages honor reduced motion and Save-Data by default. Asset managers render model stills on demand and keep recorded covers available even when Save-Data skips model rendering and video decoding. Hosts can override individual item activation rules, opt in to publishing model covers with `publicAssets.uploadBoardModelCover`, and reuse `createBoardTransport` for playback controls without a UI framework.

Hosts: Existing stage callbacks and custom preview loaders still take precedence. Set `modelPreviews: false` to opt out of automatic model stills.
