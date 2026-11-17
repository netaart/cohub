---
"@neta-art/cohub": patch
---

When the consent dialog could not load the viewer's Spaces, confirming it now loads them again instead of repeating the error, so a slow network no longer leaves the dialog without a way forward. A host can label its confirm action as a retry while `pendingAuth.spaces` is `null`.
