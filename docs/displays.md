# Displays

A display is a screen a Space's machine shares: a phone through the Android app, a Mac, Windows or Linux
desktop through `cohub runtime up --display`, or a virtual screen sandboxd starts. People watch and steer it live over WebRTC; agents use the
same display through screenshots and input. Nothing about a display is stored — every call reaches
the machine live, and media never touches Cohub servers.

显示（Display）是 Space 所在机器共享出来的屏幕：Android 应用共享的手机屏幕，`cohub runtime up --display` 共享的 Mac / Windows / Linux 桌面，或 sandboxd 启动的虚拟屏。
人通过 WebRTC 实时查看和操作，Agent 通过截图和输入使用同一块屏幕。显示相关内容一律不落库，媒体也不经过 Cohub 服务端。

## Shape

```text
Viewer (Web / SDK)                                   sandboxd (Go)
  connectDisplay ── POST …/displays/:id/sessions ──► API ── rtc.open (sandbox RPC) ──► rtc.Manager
  RTCPeerConnection ◄═══════ DTLS-SRTP, direct or via TURN ═══════► pion PeerConnection
     video ◄── H.264 ─────────────────────────────────────────────── display.Hub ◄── Provider
     control / input DataChannels ──────────────────────────────────► display.Hub ──► Provider
Agent ── display.capture / display.input (sandbox RPC) ─────────────► display.Hub ──► Provider
```

- **Provider** — the platform side: capture, encoding, input, speaking the small wire protocol in
  `apps/sandbox/display/wire.go`. The Android app serves it on a Unix socket; desktops run in
  sandboxd itself (see [Desktops](#desktops)). `COHUB_DISPLAY` picks one, see below.
- **`display.Hub`** — one encoder per display however many viewers watch; every viewer starts at a
  key frame (parameter sets are cached for late joiners); a viewer that falls behind resumes at the
  next key frame instead of decoding garbage; bitrate and frame rate follow the slowest viewer; the
  encoder stops 2 s after the last viewer leaves. The hub also knows who watches: every display it
  reports carries `viewers` (`userId`, and `control` for those who may steer it).
- **`rtc.Manager`** — pion WebRTC, H.264 only, with NACK, RTCP reports and send-side congestion
  control (GCC) whose estimate drives the encoder, up to 16 Mbps on a direct path (a LAN) and
  6 Mbps through a TURN relay, whose traffic is billed; the cap follows ICE when it moves between a
  relay and a direct path. A direct path within 15 ms round trip, a LAN, gets 60 fps instead of 30.
  Frames come at a variable rate (a still screen sends almost none), so each RTP frame carries its
  own capture time. Signaling is one complete offer and answer (WHEP-shaped), so no trickle channel
  exists. At most 4 viewers per Space; a session closes on DELETE, a failed connection, 30 s
  without a ping, 12 h, or shutdown.

Coordinates are normalized to the display (0..1, origin top-left) everywhere on the wire, so
viewers and agents never need its pixel size. Agents and the CLI speak pixels of the image they
looked at; `compileDisplayPlan` (`@cohub/protocol/display`) turns tap (or multi-click), long
press, swipe, scroll, type, key (or a shortcut such as `Control+a`), system, wait, launch and open
actions into checked [`act`](#act) steps, each gesture one scheduled batch, so gestures land exactly.

### Input

Input reaches a provider as scheduled batches, one at a time per display, from two sources. A
person on a live session comes first: their input cancels the scripted batches in flight (from the
API, so agents and the CLI) and refuses new ones for 2 s with `display_preempted`, so the two never
interleave; the agent looks again and goes on. Every batch carries `startBy`: a provider refuses one
it could not start in time, since its caller has stopped waiting, and sandboxd sends `cancel` for any
call it stops waiting for. Nothing stays held down: a batch that ends early releases the keys and
button it pressed, a closing session releases what its viewer held, and a desktop provider releases
everything when it stops.

A display describes what it takes, and what it still `needs`: permissions such as
`screenRecording`, `accessibility` and `phoneControl` the user has to grant, which clients turn into guidance.
`desktop` displays take mouse and keyboard input — hover, every
mouse button, function keys and shortcuts — while touch screens take taps, gestures, text and
editing keys, plus the system buttons they list in `system` (names a client does not know are
dropped, so newer machines stay compatible). Viewers follow suit: the web forwards hover, right
clicks and shortcuts only to desktops, and shows only the system buttons a display lists. Paste
always types the viewer's own clipboard.

| `COHUB_DISPLAY` | Provider |
| --- | --- |
| unset | none |
| `auto` | this computer's screen: the main display on macOS, the primary monitor on Windows, `$DISPLAY` on Linux |
| `macos` / `windows` / `x11[:<display>]` | the same, explicitly |
| `xvfb[:<W>x<H>]` | a virtual screen (1280×800 by default) from start; see [Virtual screens](#virtual-screens) for one on request |
| `unix:<path>` | a provider socket (the Android app, which may also start an agent screen) |
| `test` | the built-in test pattern, the reference provider |

## API

All routes are under `/api/spaces/:id`.

| Route | Permission | Notes |
| --- | --- | --- |
| `GET displays` | `sandbox.view` | Live list from the machine, with `viewers` |
| `GET displays/:display/capture` | `sandbox.view` | `format`, `quality`, `maxSize` (default 1920) |
| `GET displays/:display/tree` | `sandbox.view` | `maxElements`, `compact=true` for what can be acted on or read |
| `POST displays/:display/input` | `command.execute` | `{ events }`, resolves once performed |
| `POST displays/:display/act` | `command.execute` | `{ steps, observe?, actor? }`, see [Act](#act) |
| `POST displays/:display/interrupt` | `command.execute` | A person stops what agents do there, and the Turn doing it |
| `POST`, `DELETE displays/:display/handover` | `command.execute` | `{ id, reason, timeoutMs?, waitMs?, actor? }` asks for a person or checks on it; `DELETE` is a person saying it is done, see [Handover](#handover) |
| `GET displays/:display/apps` | `sandbox.view` | What a display can launch |
| `POST displays/:display/sessions` | `sandbox.view`, `command.execute` with control | `{ offer, control? }` → `201 { sessionId, answer }` |
| `DELETE displays/:display/sessions/:session` | `sandbox.view` | |
| `POST`, `DELETE displays/virtual` | `command.execute` | Start or stop a virtual screen |
| `GET rtc/ice-servers` | `sandbox.view` | Short-lived TURN credentials, see below |

Watching takes what seeing the Runtime does, so builders and hosts may watch; steering takes what
running a command on the machine does, which builders and their agents have too.

Errors: `sandbox_offline` (503), `display_not_found` (404), `display_unavailable` (409, e.g. the
screen is not shared), `display_preempted` (409, a person took over), `display_busy` (429),
`display_unsupported` (501, an older sandboxd). Session opens and closes are logged with user,
Space, display and session as the audit trail.

The display snapshot also rides on the Runtime: sandboxd sends a `displays` control frame on every
change (a viewer joining or leaving is one) and pong, the gateway keeps it 60 s under
`runtime:displays:<space>` and publishes `space.runtime.changed` only when it changes, and
`GET /runtime` returns it as `displays`. A cloud sandbox reports its virtual screen through
`GET displays` when its panel opens; an open live session hears every change on its control channel.

## TURN

Without configuration viewers get Cloudflare's public STUN server, which connects most networks
directly. With a Cloudflare Realtime TURN key, every user gets credentials valid for 24 h, reissued
hourly and shared by concurrent requests, so sessions connect through any NAT:

```bash
RTC_TURN_KEY_ID=…
RTC_TURN_KEY_API_TOKEN=…
```

A failed credential request falls back to STUN for a minute. Media stays end-to-end encrypted with
DTLS-SRTP; a relay only sees ciphertext.

## Android

Screens on a phone need Android 14 and **phone control**: a helper process of the shell user that Cohub
starts through the phone's own Wireless debugging, the way scrcpy or a computer's adb would, but with
no computer.

- **Setup, once.** From a Space's Runtime menu the user chooses **Set up phone control** (which needs
  notifications, and on Android 17 local network access, asked for there: without it every
  discovery opens a device picker, so Cohub does not discover at all): Cohub opens Developer options (About phone where they cannot open) and waits for
  Wireless debugging's *Pair device with pairing code* dialog (discovered over mDNS, which needs
  Wi-Fi; the dialog being advertised moves setup on, whatever the settings flags say), guiding each
  stage in the menu and in one notification that takes the code from the start, since leaving
  Settings closes the dialog. Its steps tick off as they complete; when Cohub shares
  the screen with Settings (split screen or a window), the menu takes it too (`codeInput`, then
  `display.pair`). A code that fails is retried on the dialog's new port, and a closed dialog sends
  the setup back to waiting for it. It
  pairs (SPAKE2 over TLS 1.3, `helper/adb/AdbPairing.kt`) with a key kept under the Android Keystore,
  and the helper's first act grants the app `WRITE_SECURE_SETTINGS`, turns its accessibility
  service on and exempts it from battery limits. After that the app starts the helper by itself
  whenever it serves a Space, turning Wireless debugging on when the phone is on Wi-Fi; there is no
  prompt and nothing to grant again. Starting needs Wi-Fi (any network, a hotspot too), since
  Wireless debugging runs on nothing else (`wifi_off`). A start replaces any helper left behind; one
  that does not attach, or a Wireless debugging that does not answer, gets Wireless debugging
  restarted and one more try, and a helper attaching rebinds the accessibility service if it crashed,
  so nothing asks for a reboot. What last went wrong (`detail`: a refused key, a port that did not
  answer, where a helper that did not attach stopped) shows under the menu's Diagnostics, so a phone
  with no computer can still tell.
- **The helper** (`helper/Helper.kt`, `ICohubHelper.aidl`) runs `app_process` from Cohub's own APK
  and hands its binder over through a provider only the shell may call, with a nonce of the start.
  It answers the app alone, does only what its typed calls name (no commands), and lives as long as
  the app does: when the app goes, it releases every screen and mirror and unmutes what it muted.
- **The agent screen.** `display.start` gives a Space a screen of its own (kind `agent`): a trusted
  virtual display with its own focus, so apps launched there run in the background while the person
  keeps using the phone, and the keyboard shows there too. Apps on it are muted, until they show on
  the phone's own screen; a ledger brings their sound back after a helper that was killed. It lasts
  until `display.stop`, or ten minutes with no agent, viewer or person. `launch` refuses an app the
  person has open on the phone.
- **Mirrors.** Everything that looks at a screen — a still, a stream, the floating preview, change
  detection — is a mirror the compositor scales into its own surface, so none copies another's pixels
  and the phone's own screen needs no screen recording consent: sharing it is the user's choice in
  Cohub, shown in the notification and by the floating indicator. The H.264 encoder (Constrained
  Baseline, longest edge 1920) runs only while someone watches.
- **Input** is real touch and key events the helper injects into one display; between scheduled
  points a finger passes every frame, so swipes keep their speed. Text goes into the focused field
  through accessibility and is read back; a field that refuses it (web views, Flutter) gets it pasted
  with the user's clipboard put back after, never a password field. With no field in the tree focused,
  only what the keyboard map can type goes in. The agent screen lists only `back`.
- **Elements** come from every window on the display, the one in front first: a window floating over
  another is a `dialog`, and the tree names the app in front.
- **The floating indicator** is an accessibility overlay (no overlay permission) held to the left or
  right edge and dragged along it: a slim green tab while the screen is only shared, a pill with the
  agent's own `label` while it works, fading when idle. Opened, it offers **Stop sharing**, or the
  agent screen live, its last steps and **Stop** (the plan at once and its Turn), **Take over** (its app
  moves to the phone's screen; plans refuse with `preempted` until **Hand back**). Inside Cohub it
  leaves the shared screen to the Runtime menu and the screen the page shows to its window (unless
  a person holds it: only the indicator hands back), so an agent at work elsewhere stays in view,
  and its live preview opens that screen in its Space (`display.presenting`, `display.open`). The
  Runtime menu can float an agent screen too, idle or not (`display.float`). It shows
  the same `activity`, `held` and `handover` the web sees, which offers **Stop** and **Hand back** too.
- **Without phone control** (no Wi-Fi to start it, or never set up), the phone's own screen can still be
  shared, the way it was before the helper: `display.share` asks for screen recording each time
  (the whole screen, so input lands where it is aimed), the foreground service takes the media
  projection type only while it lasts, and input goes through the accessibility service, which the
  person turns on: fingers as gestures streamed in continued strokes, back, home and recents as global
  actions, Enter, deletion and characters as edits of the focused field. One projection gives one
  virtual display, so the newest stream or still holds it and change detection runs only when
  nothing else does (window changes still report). There is no agent screen, no app launching and
  no pasting; a share recorded stays so until it stops, even if the helper starts meanwhile.
  `ScreenSource` and `Injector` are the two seams; everything else is shared.
- Host bridge: `display.status` (with `phoneControl`), `display.setup`, `display.pair`, `display.share`,
  `display.stop`, `display.openControlSettings`, and the `display.changed` event (capability
  `display`); `display.presenting` and the `display.open` event (capability `display.presenting`);
  `display.float` (capability `display.float`).
- pion enumerates interfaces through `wlynxg/anet`, which links a private symbol of `net`; the
  Android build passes `-ldflags=-checklinkname=0` for it.

## Desktops

Desktop providers implement `display.Screen` (`apps/sandbox/display/desktop.go`): report the
screen, give ffmpeg input arguments, capture a still, and perform pointer, scroll, key and text
input. The shared runtime adds the wire protocol, change polling (resolution, permission grants),
scheduled input and the encoder. An encoder is a process writing H.264 in FLV, which frames every
access unit so it leaves the moment it is encoded:

- **ffmpeg** — `h264_videotoolbox` on macOS or `libx264` (on Windows, a GPL build such as gyan.dev's) (Constrained Baseline, zero latency,
  longest edge 1920). `mpdecimate` drops frames that repeat the last one, so a still screen sends one
  frame every 2 s, a key frame; key frames come every 2 s by time, since ffmpeg cannot make one on
  request. A new bitrate (by more than a third) or frame rate restarts it in place.
- **Native, on macOS 12.3+** — sandboxd runs itself as a child (`__display-encoder`) that captures
  with ScreenCaptureKit and encodes with VideoToolbox in low-latency mode. It changes bitrate and
  frame rate in place and encodes a key frame whenever one is asked for, re-encoding the last frame
  of a still screen, so a joining viewer sees it at once and a lost packet heals at once. It needs
  no ffmpeg. As a child it can only cost the stream: one that fails before its first frame hands over
  to ffmpeg for the rest of the Runtime's life.

Without an encoder a desktop still serves screenshots and input, so agents work; only live video
needs one.

- **Native, on Windows** — the same contract through Media Foundation: GDI capture of the primary monitor
  (`StretchBlt` down to the longest edge, with the cursor), the H.264 transform Windows ships, bitrate and
  key frames through `ICodecAPI`. A still screen sends one frame every 2 s. Windows N editions lack the
  transform and fall through to ffmpeg, as does any failure before the first frame.
- **The desktop apps** turn a screen on and off without restarting the Runtime: the shell asks for consent
  each time, the CLI service tells the Runtime (`display` on its private socket), and the supervisor tells
  sandboxd on its managed control pipe, which offers what it can do with a `features` frame and answers with
  the spec now in force and what it still `needs`. A sandboxd from before that frame refuses cleanly and asks
  for a reconnect. A screen is shared with one Space at a time. The tray shows it and can stop it, and quitting
  the app stops what the app shared; a terminal's `--display` is its own.
- **`cohub runtime up --display`** shares this computer's screen. Sharing a real screen asks for
  consent (default no) unless `--yes` is passed; `--display xvfb` starts a virtual one instead.
  The flag is part of the Runtime's configuration, so reusing a running Runtime with a different
  screen is refused.
- **macOS** — Quartz Event Services through `purego` (no cgo): mouse with click counting, scroll in
  pixels, keys by virtual key code, text as Unicode events in any layout; stills from
  `screencapture`, video from AVFoundation. Cohub, or the terminal running the Runtime, needs **Screen
  Recording** (the first share shows the system prompt; the grant applies after a restart) and
  **Accessibility** for control and the element tree. Until granted, the display is listed
  without that ability. Stills come straight from Quartz where the system still offers it, from
  `screencapture` otherwise.
- **Linux (X11)** — a pure Go X11 client (`jezek/xgb`): XTest for input, buttons 4–7 for scrolling,
  a spare keycode remapped per character so any Unicode text types regardless of keyboard layout;
  `GetImage` for stills, `x11grab` for video. Wayland sessions are not supported yet.
- **Windows** — Win32 through `golang.org/x/sys/windows` (no cgo), on the primary monitor in physical
  pixels (sandboxd turns on per-monitor DPI awareness, Windows 10 1703+): `SendInput` for absolute
  pointer, wheel and keys (virtual-key codes for named keys and shortcuts, Unicode events for text in
  any layout); GDI `BitBlt` for stills, the native encoder or `gdigrab` for video. No grant is needed; the locked or UAC
  secure desktop refuses capture, and elevated windows ignore input. No element tree yet.
- **`xvfb`** — sandboxd starts `Xvfb` on the first free display from `:99` (`-nolisten tcp`),
  exports `DISPLAY` so every program started in the sandbox draws on it, restarts it on the same
  display if it dies, and stops it on exit. It needs the `xvfb` package; the sandbox image ships it.

## Elements

Pixels are a fallback: where the platform has an accessibility API, a display reports `tree` and
`display.tree` reads its interface as elements — `ref`, `depth`, `role`, `name`, `value`,
`bounds` (normalized x, y, width, height), `states` and `actions`, depth first.

- **Refs** are `e<snapshot>.<index>`. Every read is a new snapshot; providers keep the last few, and
  acting on a ref re-checks that its element is still on screen, unchanged and in place, so a
  stale ref is refused rather than landing on whatever moved under it.
- **Vocabulary**: roles, states and actions are closed lists in `@cohub/protocol/display`.
  sandboxd sanitizes every tree — valid unique refs, known names (an unknown role becomes `other`,
  unknown states and actions are dropped), text clipped to 500 characters, bounds clamped, at most
  1000 elements — so clients can trust its shape. Password fields never report their value.
- **Acting**: `element` input events (`click`, `longPress`, `focus`, `setText`, `scrollForward`,
  `scrollBackward`) ride the same input path as pointers, with the same permission, rate limits
  and timeline. An element that cannot click itself falls back to a clickable ancestor, then to a
  tap at its center. In a plan, a touch screen's `click` and `longPress` are a finger at the
  element's center instead, as apps answer a real touch even where their accessibility action
  reports success and does nothing; the action stays where a finger would reach something else
  (another control on top of the element or inside it at its center, a window other than the front
  one) or where a focused field may have a keyboard, which the tree does not show, over the screen. Desktops keep their accessibility
  actions, which do not move the person's pointer.
- **Providers**:
  - **Android** reads every window on the display through its accessibility service.
  - **macOS** reads the window in front through the Accessibility API, with the same grant as
    control; `AXPress`, `AXShowMenu` and `AXValue` act on elements, a tap at the center otherwise.
  - **Linux** reads the showing windows, the active one first, over AT-SPI, the accessibility bus
    GTK, Qt, Firefox and Chrome speak (Chrome when started with `--force-renderer-accessibility`).
    A display reports `tree` where a bus is reachable (`AT_SPI_BUS_ADDRESS`, or a desktop session's
    `org.a11y.Bus`).
  - The test pattern implements a small reference tree.

  For web pages in a sandbox browser, `agent-browser` drives the page through CDP more precisely
  still.
- **`compact`** is flat and far fewer tokens: elements that take an action, each named by the text
  inside it when it says nothing itself, and the text no such element already carries.

## Virtual screens

A machine that has Xvfb, no configured provider and no desktop session (`DISPLAY` unset) — a
cloud sandbox or a headless server — reports `virtual: "available"` in
`display.list`; `display.start` (`POST displays/virtual`, optional `size`) starts one on request and
`display.stop` (`DELETE displays/virtual`) ends it. Programs started in the sandbox afterwards
inherit its `DISPLAY`, so a headed browser or a desktop app an agent launches can be watched and
steered live. Where `dbus-daemon` and at-spi2-core are installed (the sandbox image has both), the
virtual screen brings its own accessibility bus and exports `AT_SPI_BUS_ADDRESS`,
`ACCESSIBILITY_ENABLED=1` and `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`, so those programs' interfaces
read as elements. Nothing runs until someone starts it. Cloud sandboxes offer it from the header's
screen button; a sandbox that predates virtual screens (no `virtual` field, or `display_unsupported`)
is updated by recovering it from the Space settings.

## Act

`display.act` (`POST displays/:id/act`, `command.execute`) runs a plan of up to 32 steps on the
machine, so an agent asks its model only where a decision is needed. sandboxd runs plans for every
provider (`apps/sandbox/display/act.go`); providers only read, act and report changes, so the same
plan works on a phone, a Mac or a virtual screen, and the better a display reports, the sooner each
wait ends.

- **Steps**: `element` (a `target` and an element action), `input` (scheduled events), `launch` (an
  app id), `open` (a link) and `wait`. A target is a ref, or what the element says — its `name`
  compared without case or extra spaces, a whole match first, then a start, then a part, with
  `role` and `nth` to narrow it; within a match, elements that take an action win and a row is kept
  over the children whose text it repeats. What a field holds counts only when a field is sought
  (`textField`, or an action on one), so a typed value never satisfies an `until` or a tap. With
  `scroll` a step pages the largest list on until the target shows or the list ends.
- **Each step** finds its target on the screen as it is when it runs (waiting a moment for a screen
  still loading), acts, then waits for its `until` — `text` shows, `gone` is gone, `app` is in front,
  `stable` — or for the screen to settle: 300 ms without a reported change, at most 3 s. Displays
  that report `changes` push them while a plan waits (desktops compare small grey thumbnails, phones
  their mirrors and window events), so waits end the moment the screen does.
- **A plan stops** at the first surprise, with a reason: `not_found`, `ambiguous` (with candidates),
  `moved` (a tap at a point that now lands on something other than the session was last shown there by
  `act`, checked until the plan itself changes the screen, while no other session looked since and no
  image without a tree was shown since),
  `timeout`, `dialog` (one opened that the next step does not act in), `app_changed`, `failed`,
  `preempted` — a person took over, live or at the machine (`held`) — or `interrupted`: a person
  stopped it. That Turn's later plans on the display are refused too, so what it tries before it
  hears does not reach the screen; a new Turn may act.
- **The result** lists each step's `effect` (`none`, `changed`, `navigated`), its `target` (the
  control it acted on, or the one its point landed on: the element on top there and the control
  holding it, named by what it says) and time spent finding, acting and waiting. A named control
  answers in the tree, so for element steps on a good tree pixels alone (a ripple, an animation) do
  not count as a change. Then the screen: the app in front, the tree (compact by default), its
  `quality`, and an image when the tree is `poor` or there is none (`observe.image` overrides). A
  plan that leaves a good tree as its session last saw it reports `unchanged` instead of the tree;
  the refs an agent holds are stale by then and refused, so it targets by name or looks again.
- **A caller going away stops its plan.** The API names each plan and cancels it when its request
  closes; the loopback API cancels through the request itself. Plans wait 5 s at most for one
  another (`display_busy`), so a request is bounded by a plan's 90 s.
- **Activity.** While a plan runs, and 30 s after, the display carries `activity` — the agent's
  session, Turn and step `label` — on every snapshot, so the web and the phone show who acts and why.
  One plan acts on a display at a time.

## Handover

`display.handover` asks a person to do what an agent must not: sign in, enter a code, pay. Plans on
the display are refused (`preempted`) while it stands. The display carries `handover` on every snapshot; on a phone the
floating indicator turns amber and opens, and a notification offers **Take over**.

The ask ends `returned` when a person hands the display back (`hold`, or `DELETE` from a viewer),
`stopped` when they stop it, `gone` with the display, or `expired`: at `timeoutMs` (10 min by
default, 12 h at most), or 15 s after a caller that was polling (each poll waits up to 25 s) stops,
so a killed CLI leaves nothing behind. Expiry never moves a person's app: `held` says they still have
it, and handing back then wakes no one. **Take over** from the indicator without an ask is the person
choosing to step in: its plan ends `preempted`, and handing back does not resume it.

## Agents

Agents use displays through the CLI and the `cohub` skill, like every other Space capability:

```bash
cohub spaces displays ls
cohub spaces displays start                          # the phone's agent screen, or a virtual one
cohub spaces displays launch com.android.settings    # starts the agent screen if needed; waits until it is in front
cohub spaces displays tap --name Wi-Fi --label "Opening Wi-Fi"
cohub spaces displays type hello --name Message
cohub spaces displays tap --name "Ada" --scroll      # pages the list until it shows
cohub spaces displays handover --reason "Sign in"    # waits until a person hands back
echo '[{"type":"tap","name":"Search"},{"type":"type","text":"Ada"},{"type":"key","key":"Enter","until":{"gone":"Loading"}}]' | cohub spaces displays act
cohub spaces displays look                           # the screen, without acting
cohub spaces displays tap 300 200 --count 2          # a point of the latest image
cohub spaces displays press back
```

Every action goes through `act` and prints the step results and the screen after, flagging a step
that changed nothing; an image is saved when the tree misses much of it (or with `--screenshot`), and
its pixels become the coordinates of later actions. Images go to `.cache/cohub/displays/` in the
working directory, where the agent's file tools reach them (a Runtime fences them to its folder),
outside git and photo galleries, the latest 20 kept. `capture` and
`tree` remain for looking alone. The CLI passes `COHUB_SESSION_ID` and `COHUB_TURN_ID` as the actor.

## Vocabulary

`@cohub/protocol/display` is the one source of the names (roles, states, actions, system buttons,
permissions) and limits every side shares; `pnpm --filter @cohub/protocol generate:display`
writes them into `apps/sandbox/display/vocabulary_gen.go` and the Android app's
`DisplayVocabulary.kt`, and the protocol tests fail when either is stale. Rules the vocabulary
cannot carry live in `packages/protocol/fixtures/display.json`, which the TypeScript and Go tests
both run. Lengths count characters (code points), as zod does.

## Release order

Deploy the API and Gateway first, then publish sandboxd and update the CLI pin and the Android app.
An older sandboxd answers display routes with `display_unsupported`; older web clients ignore the
`displays` field.

## Verification

```bash
cd apps/sandbox && go test ./rtc ./display   # pion-to-pion end to end; the shared cases
pnpm --filter @cohub/protocol test           # the shared cases; generated files are current
cd apps/android && ./gradlew :app:lintDebug
```
