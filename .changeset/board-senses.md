---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Board scripts sense the device. `ctx.env` reports the mode (`edit`, `play`, `view`, `export`), pointer, orientation, reduced motion, locale and which senses are available, and `envchange` reports changes. Listening to `motion`, `gamepad`, `audio` or `location` starts that sense while the Board is on screen, and stops it when no script listens. Motion samples arrive in screen axes, batched once per frame. Audio sends features only: level, pitch, onsets and a 32-band spectrum. While a sense runs, the screen stays on. iOS asks for motion on the viewer's first tap. The microphone and location also need the viewer's consent for each Board. Cohub never saves or shares readings, and a commit made from them does not count as viewer input. In play, keys without modifiers reach listening scripts even when no hit region has focus.

The stage adds `senseConsent`, `locale`, `senses`, `key()` and `whenGesture()`, and exports `BOARD_CONSENT_SENSES`. The test harness adds `device` and `sense()`. `cohub boards simulate` accepts `{"sense": …, "data": …}` steps.

Apps can declare `location` in `cohub:devices`. Motion sensors, gamepads and the screen wake lock work in interactive App frames without declaring anything. `client.app.devices.haptics(kind)` asks the host to vibrate, or vibrates directly when the App runs on its own origin.
