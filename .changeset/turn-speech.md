---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Read chat replies aloud. `session.turn(turnId).speak()` and `cohub spaces sessions turns speak` render a reply with the voice configured in `.cohub/speech.json` (Space, then user, then platform). The audio is stored on the turn per voice and shared by every viewer with that voice. Space startup reports the caller's `speechVoice`.
