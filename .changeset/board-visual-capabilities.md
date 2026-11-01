---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Boards gain visual capabilities that agents, scripts and exports share: `style.filter` (blur, brightness, contrast, saturate, hue, grayscale, sepia, invert), `style.shadow` and `style.blend` on any item, animatable by path, with a frame and its contents taking them as one layer; `board.atmosphere` (vignette, grain); effect `shape` and `colors`; and text `revealBy` (char, word, line) with `revealMotion` (cut, fade, rise). Canvas exports draw what WebGL shows, and `inspect` reports `visualBounds`. Reads keep fields written by newer clients, so older SDKs and caches open newer Boards and carry those fields through edits. `BoardStage.burst` plays transient particle bursts such as reactions, and `BoardDeviceBudget.blurs` turns blur and shadows off on low-tier devices. Effects render on a pooled `ParticleContainer`, card shadows from a shared atlas, and typing text no longer re-rasterizes every frame.
