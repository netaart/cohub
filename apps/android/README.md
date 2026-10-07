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
    HostProtocol.kt          wire constants (mirrors packages/protocol)
    HostCapabilities.kt      what this build advertises
    HostBridge.kt            request dispatch, events, capability handshake
    WebSurface.kt            the WebView island, async start-up
    WebWarmup.kt             prefetches the next document, preconnects the API
    WebOrigin.kt             the one origin that loads in-shell
    LastPage.kt              the page a cold start reopens
    LauncherShortcuts.kt     long-press shortcuts into recent Spaces
    CohubWebViewClient.kt    navigation policy, history, renderer-crash recovery
    CohubWebChromeClient.kt  file inputs, page console → logcat (debug builds)
  files/
    FileChooser.kt           <input type="file"> → Photo Picker / documents
    FileSaver.kt             downloads → MediaStore, no storage permission
  auth/
    AuthSession.kt           single-flight refresh, persists every rotation
    CredentialStore.kt       one sealed DataStore file outside backups
    CredentialCipher.kt      AES-256-GCM under an AndroidKeyStore key
    TokenEndpoint.kt         OIDC token exchange
    Pkce.kt                  PKCE + authorization URL
  runtime/
    DeviceRuntime.kt         folder → Space bindings, like `runtime up` per directory
    RuntimeService.kt        foreground service running every enabled binding
    RuntimeConnection.kt     /runtime/relay client (no local Harness)
    SandboxBridge.kt         supervises sandboxd over one folder
  display/
    DeviceDisplay.kt         this screen: shared with one served Space, control state
    ScreenCapture.kt         MediaProjection mirror → encoder, stills, rotation
    ScreenEncoder.kt         hardware H.264 from a Surface, live bitrate and key frames
    DisplayProvider.kt       the display wire protocol on a per-Space private socket
    DisplayWire.kt           frames, mirroring apps/sandbox/display/wire.go
    ControlService.kt        AccessibilityService: gestures, text, system buttons
    InputDriver.kt           live and scheduled input onto the service
    GesturePlanner.kt        input → exact gestures; live drags as continued strokes
  ui/
    SurfaceContainer.kt      holds the WebView, pads insets it misreports
    ShellAppearance.kt       the page's edge color, persisted for cold start
```

The device Runtime is described in `docs/local-runtime.md` ("Android device").

Not part of the pnpm workspace: Gradle is a separate toolchain.

```bash
cd apps/android
./gradlew :app:assembleDebug                  # prod; needs JDK 17+, ANDROID_HOME, Go and the NDK
./gradlew :app:assembleDebug -PcohubEnv=dev   # live.cohub.android.dev, installs beside prod
```

The APK embeds `apps/sandbox`, cross-compiled by `:app:buildSandboxd` with Go
(on `PATH`) and the NDK pinned in `app/build.gradle.kts`
(`sdkmanager "ndk;<version>"`).

Debug builds and every dev-environment build (`BuildConfig.WEB_DEBUGGING`) are
inspectable at `chrome://inspect` and mirror the page console, uncaught errors
included, to `adb logcat -s CohubWeb`.

A cold start opens a shared link if there is one, otherwise the last in-app page
(`LastPage`, cleared on sign-out), otherwise `/`. Start-up overlaps its slow
parts: the WebView provider loads on a background thread
(`WebViewCompat.startUpWebView`) while credentials decrypt on another, the first
document is prefetched and the API origin preconnected, and the launch screen
stays until the page reports its first screen (see the bridge doc's Launch section).

`-PcohubEnv=dev|prod` (default prod) selects origins and the Logto native app;
single values can still be overridden (`cohubWebOrigin`, `cohubApiOrigin`, `cohubGatewayOrigin`,
`cohubLogtoEndpoint`, `cohubLogtoAppId`, …), as can `cohubVersionName`,
`cohubVersionCode` and `cohubVersionSuffix`.

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
- **release** — every `vX.Y.Z` tag builds the prod APK (versionCode
  `X*1_000_000 + Y*1_000 + Z`), signed with the release key held by the
  `android-release` environment (`ANDROID_RELEASE_KEYSTORE_BASE64` /
  `ANDROID_RELEASE_KEYSTORE_PASSWORD`, tags `v*.*.*` only), and attaches it to
  the GitHub Release and `public.cohub.live/android/release/`.

Both keystores are PKCS12 with alias `cohub`. Sign-in returns through a
verified App Link, so each signing certificate must be listed in
`apps/web/src/routes/.well-known/assetlinks.json/+server.ts` for its
environment. Losing the release key means existing installs can never update,
so keep it backed up outside GitHub; rotating a key means updating that list
first.
