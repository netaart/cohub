# Cohub desktop

Native shells for macOS and Windows. Like the Android shell, each one owns windows,
sign-in and system integration, and leaves the product UI to the web app in the
system WebView, so Boards, docs and editors keep one implementation. Unlike Android,
the account and local Runtimes come from the CLI the app bundles: the desktop and the
terminal share one sign-in and one set of Runtimes.

```
┌──────────── Cohub.app / Cohub.exe ────────────┐
│  window ── system WebView ──► https://cohub.live
│              ▲ cohub.host.v1                   │
│  shell: windows, menus, tray, notifications,   │
│         share, downloads, folder dialog, updates
│              │ account + Runtime methods       │
└──────────────┼─────────────────────────────────┘
               ▼ stdio, one JSON message per line
   node + @neta-art/cohub-cli: cohub host serve
               │
   cohub runtime up -d ──► Harnesses, sandboxd    (shared with the terminal)
   ~/.config/cohub/auth.json, runtime-spaces.json
```

| | macOS | Windows |
| --- | --- | --- |
| Shell | Swift 6, AppKit | C# (.NET 10), WPF |
| WebView | WKWebView | WebView2 |
| Updates | Sparkle (EdDSA-signed appcast) | Velopack (delta packages) |
| Tray | Menu bar item | Notification area icon |
| Notifications | UserNotifications | Toasts |
| Recent Spaces | Dock menu | Jump List |
| Share | Share picker | Windows share sheet |
| Platform-neutral core | `macos/Sources/CohubCore` | `windows/Cohub.Core` |

Both cores hold the same logic and build on every OS: bridge routing between native
handlers and the CLI service (`BridgeRouter`), the service process with restart and
backoff (`HostService`), the runtime copy (`RuntimeInstall`), the origin policy
(`WebOrigin`) and the tray model (`RuntimeOverview`). The app layers are thin adapters
onto AppKit and WPF. Their tests pin protocol names against `packages/protocol/host-bridge.json`.

The contract and the desktop split are documented in
[`docs/native-host-bridge.md`](../../docs/native-host-bridge.md#desktop); how the app
serves folders is in [`docs/local-runtime.md`](../../docs/local-runtime.md#desktop-app--桌面应用).

## Behaviour

- **Start-up.** The CLI service starts with the app and says hello in about 100 ms; the
  last hello is remembered, so a page never waits to learn what the host can do. The window
  opens at its saved frame over the page's last edge color, so a cold start never flashes
  white; on macOS the page fades in once it reports its first screen (`app.ready`).
- **Navigation.** Only the web origin loads in a window, and only its top-level page gets
  the bridge. Other links open in the browser; `window.open` to a Cohub page opens a new
  window (a tab on macOS when windows are tabbed). `cohub://open/<path>` deep links
  (`cohub-dev://` for dev builds) open a page in the frontmost window.
- **Closing.** Closing the last window hides it, so reopening is instant and realtime stays
  connected. Quitting leaves Runtimes running; disconnecting a folder is explicit (in the
  page, the tray, or `cohub runtime down`).
- **Account.** Signing in opens the CLI's device sign-in in the browser; when it completes,
  the frontmost window lands where the sign-in started and Cohub comes forward. Signing in
  or out in a terminal does the same to the app.
- **Folders.** The system folder dialog picks a folder, the CLI describes it (and the Space it
  already serves), and a native consent follows before any Space depends on it. A folder dropped on
  the Dock icon, opened from Finder, or sent with "Open in Cohub" in File Explorer lands on a new Space
  with that folder chosen, and asks the same consent.
- **Screen.** Sharing asks each time, turns on without restarting the Runtime, shows in the tray, and
  ends when the app quits. macOS asks for Screen Recording and Accessibility; Windows needs neither.
- **Direct files.** A Space this computer serves is read and written without leaving it: `fs.*` calls
  go through the CLI to the Runtime's loopback API, and media streams with ranges through a scheme
  handler (macOS) or `WebResourceRequested` (Windows). The shell asks the CLI for the endpoint; the
  page never sees its token.
- **Staying awake.** While a Runtime has work, its sandboxd holds off idle sleep. Settings → General
  turns it off, and holds the options to open at login and to bring Cohub up with ⌃⌥Space (Ctrl+Alt+Space).
- **Badge.** The Dock icon and taskbar button count what is waiting to be looked at.
- **Runtime copy.** Runtimes outlive the app, so they never run from inside it: on its first
  start each app version copies its bundled runtime to a directory of its own
  (`~/Library/Application Support/<bundle id>/runtime/<version>`,
  `%LOCALAPPDATA%\Cohub\Desktop\<env>\runtime\<version>`) and runs the CLI from there. An update
  replaces the app without replacing or stopping code a Runtime is running; copies no process
  runs from any more are removed.
- **Command line.** On start the app rewrites a `cohub` shim beside those copies that runs the
  current one. "Install Command Line Tool" links `/usr/local/bin/cohub` to it (macOS) or puts its
  directory on the user PATH (Windows), so the terminal's `cohub` updates with the app.

## Develop

The cores build and test anywhere their toolchains run:

```bash
swift test --package-path apps/desktop/macos           # Swift 6.0+
cd apps/desktop/windows && dotnet test --project Cohub.Core.Tests
dotnet build apps/desktop/windows/Cohub/Cohub.csproj   # compiles on macOS and Linux too
```

Run an app against a CLI from this checkout instead of a bundled one:

```bash
pnpm --filter @neta-art/cohub-cli... build
COHUB_DESKTOP_NODE=$(which node) COHUB_DESKTOP_CLI=$PWD/packages/cli/bin/cohub.js \
  swift run --package-path apps/desktop/macos Cohub
```

On Windows, set the same variables and `dotnet run --project apps/desktop/windows/Cohub`.
`COHUB_DESKTOP_ENV=dev` and `COHUB_DESKTOP_WEB_ORIGIN` select another environment or a local web
server. Without a CLI the app still runs; the page then signs in as it would in a browser.
`swift run` has no app bundle, so updates and notifications are off there.

## Package

Both packagers bundle the runtime with `scripts/stage-runtime.mjs`: a pinned Node, verified
against its published checksums, this commit's CLI packed as npm publishes it, with the
native packages of the target platform, and this commit's sandboxd built with Go. Icons come from `apps/web/static/favicon.svg`
through `scripts/icons.mjs`.

```bash
pnpm install && pnpm --filter @neta-art/cohub-cli... build
apps/desktop/macos/scripts/bundle.sh --arch arm64 --version 1.2.3 [--env dev]
pwsh apps/desktop/windows/scripts/pack.ps1 -Version 1.2.3 [-Environment dev]
```

`bundle.sh` builds `Cohub.app`, signs it inside-out with the hardened runtime (ad hoc without
`CODESIGN_IDENTITY`), notarizes and staples when `NOTARY_KEY` is set, then writes a DMG and the
update zip. `pack.ps1` publishes a self-contained ReadyToRun build and packs it with `vpk`,
signing through Azure Trusted Signing when `AZURE_TRUSTED_SIGNING_METADATA` is set.

## CI

`.github/workflows/desktop.yml` runs for every change to the shells, the CLI or the bridge:

| Trigger | Channel | Version | Published to |
| --- | --- | --- | --- |
| Pull request | `pr/<n>` | `0.<run>.<attempt>` | Installers only; same-repo PRs get a comment with the links |
| Push to main | `dev` | `0.<run>.<attempt>` | Installers, update packages and feeds |
| `vX.Y.Z` tag | `prod` (`desktop-release` environment) | `X.Y.Z` | The same, also attached to the GitHub Release |

Each build tests both cores and compiles the Windows app on Linux, then packages macOS
(arm64, x64) and Windows (x64). With signing secrets it signs, notarizes and publishes to
`public.cohub.live/desktop/{macos,windows}/<channel>/<arch>/`:

- `Cohub-<version>-<env>-<arch>.dmg` and `Cohub-<version>-<env>-x64-Setup.exe`, each with a `.sha256`, cached for good
- `Cohub.dmg` and `Cohub-Setup.exe`, the latest of the channel, never cached
- `appcast.xml` (Sparkle) and `releases.win.json` (Velopack) with their packages; Windows builds a delta from the previous release

Without secrets the installers are workflow artifacts, unsigned. The run summary lists every link.

| Secret / variable | Use |
| --- | --- |
| `MACOS_CERTIFICATE_P12`, `MACOS_CERTIFICATE_PASSWORD`, `MACOS_CODESIGN_IDENTITY` | Developer ID Application certificate |
| `MACOS_NOTARY_KEY_P8`, `MACOS_NOTARY_KEY_ID`, `MACOS_NOTARY_ISSUER` | App Store Connect API key for notarization |
| `SPARKLE_PRIVATE_KEY`, `vars.SPARKLE_PUBLIC_KEY` | EdDSA key pair signing updates (`generate_keys`) |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET` | Azure Trusted Signing identity |
| `vars.AZURE_TRUSTED_SIGNING_ENDPOINT`, `…_ACCOUNT`, `…_PROFILE` | Azure Trusted Signing account |
| `PUBLIC_ASSET_OSS_ACCESS_KEY_ID`, `PUBLIC_ASSET_OSS_SECRET_ACCESS_KEY` | CDN upload, shared with Android |

Losing the Sparkle private key means existing macOS installs can no longer update; keep it
backed up outside GitHub.

## Next

- Windows on Arm.
