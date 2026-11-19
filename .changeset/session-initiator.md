---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Sessions and Turns record who started them: `human`, `agent` (another agent's Turn), or `automation` (schedules, hooks, API and WebSocket clients). `cohub me sessions` accepts `--initiator` and `--source`, and session and turn tables show a By column. `user.listSessions` accepts `initiator`, and the SDK exports `readSessionInitiator`, `readTurnInitiator`, and the shared source vocabulary. Desktop and mobile shells now report the `desktop` and `mobile` sources instead of `web`. An unknown `source` or `initiator` on `GET /api/me/sessions` returns 400 with `param` and `unknownKeys`, replacing `unknownSources`.
