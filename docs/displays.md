# Displays

A display is a screen a Space's machine shares: a phone through the Android app, a Mac or Linux
desktop through `cohub runtime up --display`, or a virtual screen sandboxd starts. People watch and steer it live over WebRTC; agents use the
same display through screenshots and input. Nothing about a display is stored — every call reaches
the machine live, and media never touches Cohub servers.

显示（Display）是 Space 所在机器共享出来的屏幕：Android 应用共享的手机屏幕，`cohub runtime up --display` 共享的 Mac / Linux 桌面，或 sandboxd 启动的虚拟屏。
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
looked at; `compileDisplayActions` (`@cohub/protocol/display`) turns tap (or multi-click), long
press, swipe, scroll, type, key (or a shortcut such as `Control+a`), system and wait actions into
one scheduled batch, so gestures land exactly.

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
`screenRecording` and `accessibility` the user has to grant, which clients turn into guidance.
`desktop` displays take mouse and keyboard input — hover, every
mouse button, function keys and shortcuts — while touch screens take taps, gestures, text and
editing keys, plus the system buttons they list in `system` (names a client does not know are
dropped, so newer machines stay compatible). Viewers follow suit: the web forwards hover, right
clicks and shortcuts only to desktops, and shows only the system buttons a display lists. Paste
always types the viewer's own clipboard.

| `COHUB_DISPLAY` | Provider |
| --- | --- |
| unset | none |
| `auto` | this computer's screen: the main display on macOS, `$DISPLAY` on Linux |
| `macos` / `x11[:<display>]` | the same, explicitly |
| `xvfb[:<W>x<H>]` | a virtual screen (1280×800 by default) from start; see [Virtual screens](#virtual-screens) for one on request |
| `unix:<path>` | a provider socket (the Android app) |
| `test` | the built-in test pattern, the reference provider |

## API

All routes are under `/api/spaces/:id`.

| Route | Permission | Notes |
| --- | --- | --- |
| `GET displays` | `sandbox.view` | Live list from the machine, with `viewers` |
| `GET displays/:display/capture` | `sandbox.view` | `format`, `quality`, `maxSize` (default 1920) |
| `GET displays/:display/tree` | `sandbox.view` | `maxElements`, `actionable=true` for only what takes an action |
| `POST displays/:display/input` | `command.execute` | `{ events }`, resolves once performed |
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

Screen sharing rides on the device Runtime and needs Android 11.

- From a Space's Runtime menu the user chooses **Share screen**; the system asks for capture
  consent for the whole display, and the Runtime's foreground service adds the media projection
  type for as long as the share lasts. A screen is shared with one Space at a time, and only a Space
  this device serves. Stopping the share (Cohub's notification, the system's own indicator, or
  disconnecting the Space) ends every stream at once.
- Each served Space has its own provider socket in the app's private storage
  (`files/runtime/<space>/display.sock`); its peer must be the app's own uid. A Space only lists the
  screen while it is shared with it.
- Video: MediaProjection mirrors into a virtual display that renders into the hardware H.264 encoder
  (Constrained Baseline, longest edge 1920) while anyone watches, into an ImageReader for a
  screenshot, and into nothing otherwise. Bitrate and key frame requests are applied live;
  rotation restarts the encoder in place.
- Control: the user enables Cohub in Accessibility settings. Taps, swipes and long presses become
  gestures; a live drag streams as continued strokes; text goes into the focused field; back,
  home, recents, notifications, quick settings and lock are global actions. Keys without an
  Android equivalent are refused rather than dropped.
- Host bridge: `display.status`, `display.share`, `display.stop`, `display.openControlSettings`,
  and the `display.changed` event (capability `display`).
- pion enumerates interfaces through `wlynxg/anet`, which links a private symbol of `net`; the
  Android build passes `-ldflags=-checklinkname=0` for it.

## Desktops

Desktop providers implement `display.Screen` (`apps/sandbox/display/desktop.go`): report the
screen, give ffmpeg input arguments, capture a still, and perform pointer, scroll, key and text
input. The shared runtime adds the wire protocol, change polling (resolution, permission grants),
scheduled input and the encoder. An encoder is a process writing H.264 in FLV, which frames every
access unit so it leaves the moment it is encoded:

- **ffmpeg** — `h264_videotoolbox` on macOS or `libx264` (Constrained Baseline, zero latency,
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

- **`cohub runtime up --display`** shares this computer's screen. Sharing a real screen asks for
  consent (default no) unless `--yes` is passed; `--display xvfb` starts a virtual one instead.
  The flag is part of the Runtime's configuration, so reusing a running Runtime with a different
  screen is refused.
- **macOS** — Quartz Event Services through `purego` (no cgo): mouse with click counting, scroll in
  pixels, keys by virtual key code, text as Unicode events in any layout; stills from
  `screencapture`, video from AVFoundation. The terminal running the Runtime needs **Screen
  Recording** (the first share shows the system prompt; the grant applies after a restart) and
  **Accessibility** for control and the element tree. Until granted, the display is listed
  without that ability. Stills come straight from Quartz where the system still offers it, from
  `screencapture` otherwise.
- **Linux (X11)** — a pure Go X11 client (`jezek/xgb`): XTest for input, buttons 4–7 for scrolling,
  a spare keycode remapped per character so any Unicode text types regardless of keyboard layout;
  `GetImage` for stills, `x11grab` for video. Wayland sessions are not supported yet.
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
  tap at its center.
- **Providers**:
  - **Android** reads the active window through its accessibility service, which the user already
    enables for control.
  - **macOS** reads the window in front through the Accessibility API, with the same grant as
    control; `AXPress`, `AXShowMenu` and `AXValue` act on elements, a tap at the center otherwise.
  - **Linux** reads the showing windows, the active one first, over AT-SPI, the accessibility bus
    GTK, Qt, Firefox and Chrome speak (Chrome when started with `--force-renderer-accessibility`).
    A display reports `tree` where a bus is reachable (`AT_SPI_BUS_ADDRESS`, or a desktop session's
    `org.a11y.Bus`).
  - The test pattern implements a small reference tree.

  For web pages in a sandbox browser, `agent-browser` drives the page through CDP more precisely
  still.
- **`actionable`** keeps only the elements that take an action, flat but with their refs, which is
  what an agent looking for a target needs and far fewer tokens.

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

## Agents

Agents use displays through the CLI and the `cohub` skill, like every other Space capability:

```bash
cohub spaces displays ls
cohub spaces displays start                          # a virtual screen, where available
cohub spaces displays capture                        # later coordinates are its pixels
cohub spaces displays tree                           # elements with refs and boxes
cohub spaces displays tree --actionable              # only what takes an action
cohub spaces displays tap e3.12 --screenshot         # act, then save what the screen shows
cohub spaces displays type "hello" --into e3.4       # replace a field's text
cohub spaces displays tap 300 200 --count 2          # double-click a point
cohub spaces displays key Control+a
cohub spaces displays press back
echo '[{"type":"tap","ref":"e3.12"},{"type":"type","text":"hello"}]' | cohub spaces displays act
```

`capture` defaults to a 1280 px longest edge, within what agents downscale images to, and the CLI
remembers each display's latest screenshot size, so coordinates mean what the agent saw without
`--size`; the memory resets when the display itself changes size.

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
