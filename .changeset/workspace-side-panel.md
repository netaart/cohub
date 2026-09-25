---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Add generation task views and session file listings.

- SDK: `toGenerationTaskView()` projects a generation Task Run into display-ready outputs (prompt, model, cover-folded media), with `generationOutputSource()` for inline payloads. `space(id).session(id).files()` lists Space files a session's Agent wrote or edited.
- CLI: `cohub spaces sessions files <sessionId>` lists Space files a session's Agent wrote or edited.
