---
"@neta-art/cohub": patch
"@neta-art/cohub-cli": patch
---

Generation SDK 0.2.12. `qwen-audio-3.1-tts-flash` takes text of any length, and with neither a reference recording nor `voice_prompt` a default voice speaks it; before, text under 15 characters and requests with no voice were refused. The board sends such requests too. `scene3` has no fixed character limit: one request speaks at most about 14.7 minutes of audio, and a text that does not fit is refused with a 400 naming the limit.
