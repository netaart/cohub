# Cohub Android shell

A thin native host for the Cohub web app. The shell owns start-up, sign-in, deep
links and system capabilities; the product UI stays in a WebView island so
Boards, docs and editors keep one implementation. The WebView sits in a plain
view, not Compose: it composites synchronously on the UI thread, so every layer
above it costs frames. All cross-boundary traffic uses the versioned
`cohub.host.v1` bridge — see `docs/native-host-bridge.md`.

```
app/src/main/kotlin/live/cohub/android/
  CohubApplication.kt        process-wide AuthSession, DeviceRuntime, HTTP client
  MainActivity.kt            activity host, launch screen, deep links, back
  host/
    HostProtocol.kt          wire names, generated from packages/protocol
    HostValues.kt            parsed values that are not names
    BridgeMessages.kt        the envelope, pinned by packages/protocol/fixtures
    HostCapabilities.kt      what this build advertises
    HostBridge.kt            request dispatch, events, capability handshake
    WebSurface.kt            the WebView island, async start-up
    WebWarmup.kt             prefetches the next document, preconnects the API
    WebOrigin.kt             the one origin that loads in-shell
    LastPage.kt              the page a cold start reopens
    PageDialogs.kt           alert, confirm, prompt, beforeunload: one at a time, answered once
    LauncherShortcuts.kt     long-press shortcuts into recent Spaces
    CohubWebViewClient.kt    navigation policy, history, renderer-crash recovery, shared files
    CohubWebChromeClient.kt  file inputs, page dialogs, page console → logcat (debug builds)
  files/
    FileChooser.kt           <input type="file"> → Photo Picker / documents
    FileSaver.kt             downloads → MediaStore, no storage permission
    FileStreams.kt           files.stream: binary frames written straight to MediaStore
  auth/
    AuthSession.kt           single-flight refresh, persists every rotation
    CredentialStore.kt       one sealed DataStore file outside backups
    CredentialCipher.kt      AES-256-GCM under an AndroidKeyStore key
    TokenEndpoint.kt         OIDC token exchange
    Pkce.kt                  PKCE + authorization URL
    PendingSignIns.kt        the request in flight, surviving process death
    SignInBrowser.kt         default browser; its Auth Tab when offered
    SignInFlow.kt            one sign-in at a time, its auth.flow outcome once
    GoogleSignIn.kt          Credential Manager, then Logto's one-tap handoff in a hidden WebView
  runtime/
    DeviceRuntime.kt         folder → Space bindings, like `runtime up` per directory
    RuntimeService.kt        foreground service running every enabled binding
    RuntimeConnection.kt     /runtime/relay client (no local Harness)
    SandboxBridge.kt         supervises sandboxd over one folder
  display/
    DeviceDisplay.kt         the phone's screens as Spaces see them: shared, and each Space's agent screen
    Screen.kt                one display through mirrors: stills, streams, change detection
    ScreenSource.kt          where a screen's pixels come from: the helper, or screen recording
    ScreenEncoder.kt         hardware H.264 from a Surface, live bitrate and key frames
    DisplayProvider.kt       the display wire protocol on a per-Space private socket
    DisplayWire.kt           frames, mirroring apps/sandbox/display/wire.go
    ControlService.kt        AccessibilityService: controls, window changes, focus, the overlay's host
    ElementTree.kt           a display's windows as elements, the one in front first
    InputDriver.kt           touches and keys injected into one display, text through accessibility
    Injector.kt              how input reaches a display; the helper's real touches and keys
    GestureInjector.kt       without the helper: accessibility gestures, keys as actions and edits
    Indicator.kt             what the floating indicator says: which screen, sharing, working, asking, held
    Overlay.kt               the floating indicator's window: edge, dragging, tab, pill or panel, handing off to the page
    OverlayViews.kt          the tab, the pill and the panel with the agent screen live
  helper/
    PhoneControl.kt          pairing with Wireless debugging, starting the helper, its state
    HelperMain.kt            the helper process (shell user), started through app_process
    Helper.kt                ICohubHelper: screens, mirrors, input, launching, as the shell
    HelperHandoff.kt         the provider the helper hands its binder to
    adb/                     just enough adb: pairing (SPAKE2), TLS, one exec
  ui/
    SurfaceContainer.kt      holds the WebView, pads insets it misreports
    ShellAppearance.kt       the page's edge color, persisted for cold start
    HostLocale.kt            the language of host copy, the page's or the system's
    LaunchCover.kt           the splash's twin, slow and failed starts
    LaunchNet.kt             the launch mark growing into a woven context network
```

The device Runtime is described in `docs/local-runtime.md` ("Android device").

Not part of the pnpm workspace: Gradle is a separate toolchain.

```bash
cd apps/android
./gradlew :app:assembleDebug                  # prod; needs JDK 17+, ANDROID_HOME, Go and the NDK
./gradlew :app:assembleDebug -PcohubEnv=dev   # live.cohub.android.dev, installs beside prod
./gradlew :app:ktlintFormat                   # style; :app:ktlintCheck (part of check) verifies it
```

Kotlin and Android Lint warnings fail the build; suppress one only at the smallest
scope, with the reason beside it.

The APK embeds `apps/sandbox`, cross-compiled by `:app:buildSandboxd` with Go
(on `PATH`) and the NDK pinned in `app/build.gradle.kts`
(`sdkmanager "ndk;<version>"`). `:app:stageCli` adds `cohub` for what a Runtime runs: this
commit's CLI (build it first: `pnpm install && pnpm --filter @neta-art/cohub-cli... build`) and
the Node that `scripts/stage-runtime.mjs` pins, built for Android arm64 by
`.github/workflows/node-android.yml`; `runtime/BundledCli.kt` installs and links them.

Debug builds and every dev-environment build (`BuildConfig.WEB_DEBUGGING`) are
inspectable at `chrome://inspect` and mirror the page console, uncaught errors
included, to `adb logcat -s CohubWeb`.

A cold start opens a shared link if there is one, otherwise the last in-app page
(`LastPage`, cleared on sign-out), otherwise `/`. Start-up overlaps its slow
parts: the WebView provider loads on a background thread
(`WebViewCompat.startUpWebView`) while credentials decrypt on another, the first
document is prefetched and the API origin preconnected, and `ui/LaunchCover.kt`
takes over from the system splash until the page reports its first screen; a slow
or failed start is explained there (see the bridge doc's Launch section).

`-PcohubEnv=dev|prod` (default prod) selects origins and the Logto native app;
single values can still be overridden (`cohubWebOrigin`, `cohubApiOrigin`, `cohubGatewayOrigin`,
`cohubLogtoEndpoint`, `cohubLogtoAppId`, …), as can `cohubVersionName`,
`cohubVersionCode` and `cohubVersionSuffix`.

Sign-in opens an Auth Tab when the default browser offers one; its result returns to the
shell directly on `<applicationId>://auth/callback`. Otherwise its Custom Tab
returns through the `/mobile/auth/callback` App Link. The Logto native
app lists both redirect URIs for each environment. A `provider` opens that
connector directly (`direct_sign_in`).

Google skips the browser: Credential Manager's account sheet returns an ID token
for the Google web client Logto's sign-in experience publishes
(`/api/.well-known/sign-in-exp`, `googleOneTap.clientId`), with a nonce bound to
the request's state. A hidden WebView that loads nothing but Logto then hands it
over (`google_one_tap_credential`) and stops at the redirect, which completes
like any other. No Google account or services, a Logto page that needs someone,
or a minute without a redirect falls back to the browser; dismissing the sheet
cancels. Google accepts the token only from a build whose package and signing
certificate are registered as an Android client in the same Google Cloud
project as that web client.

The shell draws its own copy (launch cover, toasts, dialogs, notifications) in the
page's language (`app.setLocale`): the per-app language on Android 13+, which
keeps the activity and WebView alive; persisted and read through a configured
context before that. Every language ships in the Play bundle for this reason.

## CI

`.github/workflows/android.yml` has two jobs:

- **dev** — every PR and main push that touches the shell tests, lints and
  assembles a dev APK. Same-repo builds publish the R8 release variant (a
  debuggable build runs far slower than what ships), signed with the dev key
  (repository secrets `ANDROID_DEV_KEYSTORE_BASE64` /
  `ANDROID_DEV_KEYSTORE_PASSWORD`), to the CDN as
  `android/pr/<n>/cohub-dev-pr-<n>-<sha>.apk` or
  `android/main/cohub-dev-main-<sha>.apk`; the PR comment and the run summary
  link the APK with a QR code. Fork builds publish the debug variant with a
  throwaway debug key, so they install but cannot sign in.
- **release** — every `vX.Y.Z` tag builds the prod APK and Google Play AAB (versionCode
  `X*1_000_000 + Y*1_000 + Z`), signed with the release key held by the
  `android-release` environment (`ANDROID_RELEASE_KEYSTORE_BASE64` /
  `ANDROID_RELEASE_KEYSTORE_PASSWORD`, tags `v*.*.*` only), and attaches both files and their SHA-256 checksums to the GitHub Release.
  The AAB uses `playRelease` and supports cloud Spaces and system file picking.
  The direct APK uses `release` and also includes the device Runtime and screen control.
  The APK is also available at `public.cohub.live/android/release/`.

Both keystores are PKCS12 with alias `cohub`. Sign-in returns through a
verified App Link, so each signing certificate must be listed in
`apps/web/src/routes/.well-known/assetlinks.json/+server.ts` for its
environment. Losing the release key means existing installs can never update,
so keep it backed up outside GitHub; rotating a key means updating that list
first.
