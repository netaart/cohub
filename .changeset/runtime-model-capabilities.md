---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Local Runtimes keep their model catalogs current and support the `ultra` thinking level.

- A running Runtime rediscovers every Harness's models hourly; a change reaches the Space without restarting, and a Harness whose discovery fails keeps its previous models.
- `ultra` can be selected and sent (`--thinking-level ultra`) for models that declare it. Requests are fitted to the levels a model declares, as for Cloud models.
- Runtime capabilities carry each model's `serviceTiers` and `defaultServiceTier`.
- The SDK exports `MODEL_THINKING_LEVELS`, `isModelThinkingLevel`, `supportedThinkingLevels`, `clampThinkingLevel` and `findRuntimeModel`.
