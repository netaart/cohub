# Cohub iOS shell

A thin native host for the Cohub web app, like the Android shell: it owns start-up,
sign-in, links and system integration, and leaves the product UI to the web app in a
WKWebView, so Boards, docs and editors keep one implementation. All traffic with the
page goes through the versioned `cohub.host.v1` bridge — see
[`docs/native-host-bridge.md`](../../docs/native-host-bridge.md).

This build is the client: it uses Spaces on Cohub's cloud and on computers that serve
them, but does not serve this device's own files (no `runtime`, `workspace` or `display`
capability), so the page never offers it. Nor does it advertise `notifications` or
`badge`: iOS suspends a hidden page within seconds, so those wait for push delivery.

```
Cohub/
  AppDelegate.swift        app and scene entry: links, quick actions, foreground
  Shell.swift              app-wide state: session, inbox, sign-in, where pages go
  ShellViewController.swift the WKWebView, launch cover, navigation policy, dialogs, crash recovery
  HostBridge.swift         what each bridge method does here; haptics, About
  SignIn.swift             ASWebAuthenticationSession + PKCE, HTTPS callback
  KeychainStore.swift      the session's only copy, this device only
  FileSaver.swift          files.save and downloads → Photos or Files
  QuickActions.swift       Home Screen quick actions: New chat and recent Spaces
  ShellConfig.swift        environment from Info.plist; ShellState.swift, what persists
CohubShare/                share extension: hands shared items to the app
Configs/                   prod and dev environments (xcconfig)
```

Platform-neutral logic is `CohubCore`, the package the macOS shell builds
(`apps/desktop/macos/Sources/CohubCore`): bridge routing and messages, the web origin
policy, `AuthSession` (single-flight refresh, every token rotation persisted before
use), the authorization request, notifications, permissions and the share inbox. It is
compiled into this project as a static framework and tested with SwiftPM, on Linux in CI:

```bash
swift test --package-path apps/desktop/macos
```

## Build

The Xcode project is generated from `project.yml` and not committed:

```bash
brew install xcodegen
cd apps/ios
echo 'DEVELOPMENT_TEAM = <your team id>' > Configs/Local.xcconfig   # device builds
xcodegen generate && open Cohub.xcodeproj
```

The **Cohub** scheme builds prod (`live.cohub.ios`), **Cohub Dev** builds the dev
environment (`live.cohub.ios.dev`, installs beside prod). iOS 18 or later.
Regenerate the icon and launch logo from `apps/web/static/favicon.svg` with
`node apps/desktop/scripts/icons.mjs --ios apps/ios/Cohub/Assets.xcassets`
(after `pnpm install`).

Sign-in and Universal Links need the signing team in the web app's
`/.well-known/apple-app-site-association` route (`APPLE_TEAM_ID`) and the redirect
`https://<origin>/mobile/auth/callback` on the Logto native application (the one
Android uses).

## Behaviour

- **Start-up.** The first launch after an install clears any Keychain session an
  earlier install left. The session loads while the window is made; the WebView is
  created and starts loading at once, over the last edge color the page reported for
  the current appearance, under a twin of the launch screen that lifts on `app.ready`
  or after 2.5 s. A cold start opens a link if there is one, else the last page, else `/`.
- **Pages.** Only the web origin loads in the WebView; other links open in their app or
  Safari. `WKAppBoundDomains` names the origin, which lets its service worker cache the
  app shell. iOS may end a hidden page's process; it reloads where it was when seen again.
- **Gestures.** The page owns insets and gestures: no automatic insets, document bounce,
  link previews or back swipe.
- **Sign-in.** The system browser session with PKCE (`prompt=consent`, and `login consent`
  after a sign-out), returning on the HTTPS callback. Tokens live only in the Keychain
  (`AfterFirstUnlockThisDeviceOnly`); the page asks per request.
- **Sharing in.** The share extension copies text, links and up to 16 files (each up to
  12 MiB is kept) into the App Group, commits them with one rename, and opens
  `cohub://open/sessions/new`; the new chat takes the newest share once.
- **Downloads.** `files.save` and downloads the page cannot show: images and videos go to
  Photos, anything else to Files.
- **Quick actions.** New chat, then the three Spaces opened last; cleared on sign-out with
  the last page.
