---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Board scripts read the device as the browser reports it. Listening to `browser:devicemotion`, `browser:deviceorientation`, `browser:gamepads`, `browser:audio` (mono PCM), `browser:video` (camera frames as ImageBitmaps) or `browser:position` starts that source while the Board is on screen, and stops it when no script listens. While one runs, the screen stays on. `ctx.env` reports the mode, pointer, orientation, screen angle, reduced motion, locale and the state of each source, and `envchange` reports changes. iOS asks for motion on the viewer's first tap. The microphone, camera and location also need the viewer's consent for each Board. `cohub boards examples senses --module` prints optional helpers for screen-axis motion and audio level, pitch, onsets and spectrum. Live scripts may `fetch()` and open WebSockets; exports have no network. In play, keys without modifiers reach listening scripts unless a field or button has focus. `navigator.vibrate`, `haptics` and `fullscreen` are available as capabilities.

Record input in a Board saves what the scripts received to `<board>.inputs/`. `cohub boards export --inputs` and video exports replay it. `cohub boards simulate` accepts `{"input": …, "data": …}` and `{"inputs": …}` steps, and the test harness adds `device`, `input()` and `replay()`. The stage adds `senseConsent`, `locale`, `senses`, `key()`, `whenGesture()` and `recordInputs()`.

Apps can declare `location` in `cohub:devices`. Motion sensors, gamepads and the screen wake lock work in interactive App frames without declaring anything. `client.app.devices.haptics(kind)` asks the host to vibrate, or vibrates directly when the App runs on its own origin.
