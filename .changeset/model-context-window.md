---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

A model's `contextWindow` can now be set by a mod's `.cohub/models.json` as well as the user's, layered platform < mod < user < prompt and capped at the platform value. `models.list({ spaceId })` and `cohub -s <space> models ls` show each model's effective window and where it came from. A prompt can pass `contextWindow` (`cohub spaces prompt --context-window <tokens>`); like thinking level, it applies to the rest of the session until a later prompt changes it. The SDK rejects a non-integer or non-positive value before sending.

Hosts: deploy the API first. An older API ignores `contextWindow` and `spaceId`.
