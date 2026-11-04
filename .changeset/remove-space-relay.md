---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Remove cross-Space relay and replies. A prompt that opens with a mention of another Space or Chat now runs here, with the mention as context. `space.prompt({ reply })`, `cohub spaces prompt --reply`, the `reply` origin kind, `SentTurnRef.reply`, and `readSessionTurnReply()`, `readSessionTurnRelay()` and `readReplyStatus()` are gone.
