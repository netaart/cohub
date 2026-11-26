---
"@neta-art/cohub-cli": patch
"@neta-art/cohub": patch
---

Fork a Chat from any settled turn, whichever runtime ran it: `cohub spaces sessions turns fork <sessionId> <turnId>` and the SDK's `canForkTurn`. History handed to a new Claude Code file keeps thinking that Cohub-run Turns recorded from the same named endpoint, redacted reasoning included; Claude Code's own `redacted_thinking` is now kept when its transcripts sync. The Runtime logs what a handoff could not carry (`native.projection_loss`).
