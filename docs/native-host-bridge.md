# Native host bridge

Cohub ships a web surface and native shells (Android, macOS, Windows and Linux
today, iOS later). The bridge lends a web surface what a browser cannot have: the
credential store, the OAuth round trip, deep links, and system integration.

Contract: `packages/protocol/src/host-bridge.ts` (single source of truth), with
its names in `packages/protocol/host-bridge.json` for native tests to pin.
Web client: `packages/sdk/src/host-bridge.ts`.
Android: `apps/android/app/src/main/kotlin/live/cohub/android/host/`.
Desktop: `apps/desktop/` (see its README) and `packages/cli/src/host/`.

## Shape

```
Web surface                          Native host
    │  request  { id, method, params }   │
    ├────────────────────────────────────►│
    │  response { id, result|error }      │
    │◄────────────────────────────────────┤
    │  event    { name, payload }         │
    │◄────────────────────────────────────┘
```

The web side calls `host.describe` once at start-up. With no channel it resolves
immediately, so a browser pays nothing; with a silent host it gives up after
`HOST_BRIDGE_HANDSHAKE_TIMEOUT_MS` and runs as a plain browser.

## Rules

1. **Capabilities gate calls, not versions.** Adding a capability is safe —
   a surface drops names it does not know — but removing one breaks shipped
   web bundles. Hosts pin their names in tests, so a typo cannot ship.
2. **Advertise only what is implemented.** A premature capability sends the web
   side down a path that fails at runtime — worse than the browser fallback.
3. **The web surface must run unchanged in a browser.** Every host branch is
   additive and behind a capability check.
4. **Tokens never reach the WebView's storage.** The host keeps the only copy,
   encrypted at rest; the web side asks per request.

## Methods

| Method | Capability | Notes |
| --- | --- | --- |
| `host.describe` | — | Handshake: platform, host id, capabilities |
| `auth.getAccessToken` | `auth.token` | `null` means "no session", not an error |
| `auth.getSessionVersion` | `auth.token` | Bumps on any session change |
| `auth.getSession` | `auth.session` | Identity for the cache partition key |
| `auth.signIn` | `auth.signIn` | System browser + PKCE; returns immediately |
| `auth.signOut` | `auth.token` | Clears the host store and revokes the grant, pushes `auth.signedOut`; the next sign-in prompts for login |
| `notifications.register` | `notifications` | Asks the system for permission; `true` when notifications can show |
| `notifications.show` | `notifications` | A system notification opening an in-app `path`; a later one with the same `id` replaces it |
| `share.text` | `share` | Native share sheet |
| `navigation.openPath` | `navigation` | In-shell path navigation |
| `cache.clear` | `cache` | Host state only; IndexedDB is the web app's |
| `runtime.list` | `runtime` | This device's folders bound to Spaces, with live state |
| `runtime.browse` | `runtime` | Asks for storage access, then lists a device folder |
| `runtime.start` | `runtime` | Binds a folder to a Space and serves it; refuses taking over a running one |
| `runtime.stop` | `runtime` | Disconnects a Space; its binding and files stay |
| `runtime.pickFolder` | `runtime.picker` | The system folder dialog, answering a `runtime.browse` listing; preferred over the in-app browser |
| `appearance.set` | `appearance` | Edge color (`#rrggbb`) for the window and system bars |
| `app.ready` | `launch` | First screen painted; the host lifts its launch screen |
| `haptics.perform` | `haptics` | `tick`, `confirm`, `reject` or `longPress`, in the system's own feel |
| `files.save` | `files` | Saves an https `url` (downloaded natively) or base64 `data` to shared storage |
| `navigation.interceptBack` | `navigation.back` | While enabled, system back emits `navigation.back` |
| `shortcuts.push` | `shortcuts` | Launcher shortcut to an in-app path, ranked by recency |
| `display.status` | `display` | The Space this screen is shared with, and whether control is on |
| `display.share` | `display` | Asks for screen capture consent, then shares with a Space this device serves |
| `display.stop` | `display` | Stops sharing; every stream ends |
| `display.openControlSettings` | `display` | Opens Accessibility settings, where the user allows control |

`runtime.changed` pushes the whole `DeviceRuntime` on every change, `display.changed` the whole
display status. `display` rides on `runtime`; see [Displays](displays.md). Android advertises
`runtime` only on Android 11+ builds that ship sandboxd; see
[Local Runtime](local-runtime.md#android-device--android-设备).

`app.foreground` and `app.background` follow the shell's visibility; the page
also sees `visibilitychange`, because the host pauses the WebView with it.

## Launch

The host holds its launch screen while the WebView starts and the page boots,
then lifts it on `app.ready` or after 2.5 s, whichever comes first, so a cold
start never flashes an empty surface. The page calls `app.ready` two frames
after its first screen renders — from local data, not after the network. The
same call marks the activity fully drawn, so time to full display is
measurable (`adb logcat -s ActivityTaskManager` prints `Fully drawn`).

## Back

A WebView alone maps back to history, so an open dialog or drawer would stay
put while the page behind it changes. Dismissible layers register with
`dismissOnBack` (`$lib/back-layers.svelte`); while any is open the page asks
the host to intercept, and each back gesture closes the topmost layer. A new
document resets interception, so a page that crashed or reloaded mid-dialog
can never trap back.

## Files

A WebView ignores `<input type="file">` and `download` on its own. The host
answers file inputs with the system Photo Picker when every accepted type is an
image or video, otherwise the document picker; neither needs a permission. The
page routes every `<a download>` (markup or programmatic) through `files.save`:
https URLs are fetched by the host, so large media never crosses the bridge;
`blob:` and `data:` bytes go inline as base64. Files land in
`Pictures/Cohub`, `Movies/Cohub`, `Music/Cohub` or `Download/Cohub` by type,
through MediaStore, which is why `files` needs Android 10.

## Edge to edge

The host draws the surface under transparent system bars. The page lays out
around them with `env(safe-area-inset-*)`: the surface pinned to the viewport
top pads itself with the `safe-area-top` utility and consumes the inset, so
chrome nested inside offsets by `--safe-area-top` (0 once consumed), while fixed
overlays read `env()` directly. The mobile tab bar likewise consumes
`--safe-area-bottom`. Whenever the shell background changes (theme,
system scheme, Space style) the page sends `appearance.set`; the host persists
the color for the next cold start and derives icon contrast from it. WebViews
older than Chromium 140 misreport the insets, so Android pads them natively
instead and the page sees zero.

## Sign-in

Runs natively against a Logto **native** application (distinct from the web SPA
application):

- System browser (Custom Tabs / `ASWebAuthenticationSession`), never a WebView.
- PKCE with the verifier held in memory on the device.
- Redirect is an HTTPS App Link / Universal Link (`/mobile/auth/callback`),
  verified via `assetlinks.json` / `apple-app-site-association`. A custom scheme
  would be claimable by any app.
- `prompt=consent` with `offline_access`, as the web SDK sends, so Logto issues
  a refresh token.
- Browsers may not hand a redirect the user did not trigger (a silent Logto
  session) to the app. The web route then renders a no-JS "Open the app" page
  whose link retries the same URL as a user navigation.

## Desktop

The macOS (Swift, AppKit, WKWebView), Windows (C#, WPF, WebView2) and Linux (C#,
GTK 4, WebKitGTK) shells load the web origin like Android does, and split the bridge in two:

- **Shell methods** stay native: windows, `appearance`, `navigation`, `share` (macOS,
  Windows), `files` (macOS; Windows and Linux keep the WebView's own downloads), `cache`
  (macOS, Windows), `notifications`, `shortcuts` (Dock menu, Jump List, launcher actions),
  `media.capture`, `runtime.pickFolder`, and `launch` (macOS, Linux).
- **Account and Runtime methods** are forwarded verbatim to the bundled CLI,
  `cohub host serve`, over stdio (one JSON message per line). It answers `auth.*` from
  the CLI's own session, so signing in on the desktop signs in the terminal too and
  the other way round, and `runtime.*` from the same `runtime up` Runtimes a terminal
  starts. Its first message, `hello`, names the capabilities and methods it answers;
  the shell adds those to its own when the page describes the host, and remembers the
  hello so later launches never wait for it.

The service pushes `auth.changed` (with the `redirectPath` a sign-in asked for) and
`runtime.changed` when the session file or a Runtime changes, from file watches and
each Runtime's status stream rather than polling. `shell.open` asks the shell to open
a URL in the browser (the device sign-in page); it is never relayed to the page. On
`auth.changed` every window reloads: the frontmost lands on `redirectPath`, and a
sign-out returns to `/`. Before a folder is first connected to a Space, the shell
asks for consent natively; reconnecting a folder already serving that Space does not.

Sign-in uses the CLI's device authorization in the system browser. The token never
leaves the CLI's session file; the page asks for it per request, like on Android.

## Adding a method

1. Add it to `HOST_BRIDGE_METHODS` with params and result schemas.
2. Implement it in the host; add the capability to `HostCapabilities.advertised`.
3. Add the web-side caller behind `supportsHostCapability()`.
4. Mirror the constant in `HostProtocol.kt` so `HostProtocolTest` passes, and run
   `pnpm --filter @cohub/protocol generate:host-bridge`; the macOS and Windows shells
   pin their names against `host-bridge.json`, and a protocol test fails until it is current.
5. A method only the CLI can answer goes in `packages/cli/src/host/serve.ts`;
   desktop shells forward it without changes.
