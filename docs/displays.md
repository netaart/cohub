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
  next key frame instead of decoding garbage; the bitrate follows the slowest viewer; the encoder stops
  2 s after the last viewer leaves.
- **`rtc.Manager`** — pion WebRTC, H.264 only, with NACK, RTCP reports and send-side congestion
  control (GCC) whose estimate drives the encoder, up to 16 Mbps on a direct path (a LAN) and
  6 Mbps through a TURN relay, whose traffic is billed. Signaling is one complete offer and answer
  (WHEP-shaped), so no trickle channel exists. At most 4 viewers per Space; a session closes on
  DELETE, a failed connection, 30 s without a ping, 12 h, or shutdown.

Coordinates are normalized to the display (0..1, origin top-left) everywhere on the wire, so
viewers and agents never need its pixel size. Agents and the CLI speak pixels of the image they
looked at; `compileDisplayActions` (`@cohub/protocol/display`) turns tap (or multi-click), long
press, swipe, scroll, type, key (or a shortcut such as `Control+a`), system and wait actions into
one scheduled batch, so gestures land exactly.

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
| `GET displays` | `sandbox.view` | Live list from the machine |
| `GET displays/:display/capture` | `sandbox.manage` | `format`, `quality`, `maxSize` |
| `POST displays/:display/input` | `sandbox.manage` | `{ events }`, resolves once performed |
| `POST displays/:display/sessions` | `sandbox.manage` | `{ offer, control? }` → `201 { sessionId, answer }` |
| `DELETE displays/:display/sessions/:session` | `sandbox.manage` | |
| `GET rtc/ice-servers` | `sandbox.manage` | Short-lived TURN credentials, see below |

Errors: `sandbox_offline` (503), `display_not_found` (404), `display_unavailable` (409, e.g. the
screen is not shared), `display_busy` (429), `display_unsupported` (501, an older sandboxd).
Session opens and closes are logged with user, Space, display and session as the audit trail.

The display snapshot also rides on the Runtime: sandboxd sends a `displays` control frame on every
change and pong, the gateway keeps it 60 s under `runtime:displays:<space>` and publishes
`space.runtime.changed` only when it changes, and `GET /runtime` returns it as `displays`.

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
scheduled input and the encoder: ffmpeg with `h264_videotoolbox` on macOS or `libx264`
(Constrained Baseline, zero latency, one second GOP, longest edge 1920), restarted in place when
congestion control moves the bitrate by more than a third. Without ffmpeg a desktop still serves
screenshots and input, so agents work; only live video needs it.

- **`cohub runtime up --display`** shares this computer's screen. Sharing a real screen asks for
  consent (default no) unless `--yes` is passed; `--display xvfb` starts a virtual one instead.
  The flag is part of the Runtime's configuration, so reusing a running Runtime with a different
  screen is refused.
- **macOS** — Quartz Event Services through `purego` (no cgo): mouse with click counting, scroll in
  pixels, keys by virtual key code, text as Unicode events in any layout; stills from
  `screencapture`, video from AVFoundation. The terminal running the Runtime needs **Screen
  Recording** (the first share shows the system prompt; the grant applies after a restart) and
  **Accessibility** for control. Until granted, the display is listed without that ability.
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
- **Providers**: Android reads the active window through its accessibility service, which the
  user already enables for control. The test pattern implements a small reference tree. Desktop
  trees (macOS AX, Linux AT-SPI) are not implemented yet; for web pages in a sandbox browser,
  `agent-browser` drives the page through CDP.

## Virtual screens

A machine that has Xvfb, no configured provider and no desktop session (`DISPLAY` unset) — a
cloud sandbox or a headless server — reports `virtual: "available"` in
`display.list`; `display.start` (`POST displays/virtual`, optional `size`) starts one on request and
`display.stop` (`DELETE displays/virtual`) ends it. Programs started in the sandbox afterwards
inherit its `DISPLAY`, so a headed browser or a desktop app an agent launches can be watched and
steered live. Nothing runs until someone starts it. Cloud sandboxes offer it from the header's
screen button; a sandbox that predates virtual screens (no `virtual` field, or `display_unsupported`)
is updated by recovering it from the Space settings.

## Agents

Agents use displays through the CLI and the `cohub` skill, like every other Space capability:

```bash
cohub spaces displays ls
cohub spaces displays start                          # a virtual screen, where available
cohub spaces displays capture                        # later coordinates are its pixels
cohub spaces displays tree                           # elements with refs and boxes
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

## Release order

Deploy the API and Gateway first, then publish sandboxd and update the CLI pin and the Android app.
An older sandboxd answers display routes with `display_unsupported`; older web clients ignore the
`displays` field.

## Verification

```bash
cd apps/sandbox && go test ./rtc   # pion-to-pion end to end through the hub
pnpm --filter @cohub/protocol test
cd apps/android && ./gradlew :app:lintDebug
```
