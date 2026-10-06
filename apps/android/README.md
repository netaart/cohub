# Cohub Android shell

A thin native host for the Cohub web app. Compose owns start-up, sign-in, deep
links and system capabilities; the product UI stays in a WebView island so
Boards, docs and editors keep one implementation. All cross-boundary traffic
uses the versioned `cohub.host.v1` bridge — see `docs/native-host-bridge.md`.

```
app/src/main/kotlin/live/cohub/android/
  CohubApplication.kt        process-wide AuthSession and DeviceRuntime
  MainActivity.kt            activity host, edge-to-edge, deep links
  host/
    HostProtocol.kt          wire constants (mirrors packages/protocol)
    HostCapabilities.kt      what this build advertises
    HostBridge.kt            request dispatch, events, capability handshake
    WebSurface.kt            the WebView island
    CohubWebViewClient.kt    navigation policy, renderer-crash recovery
    CohubWebChromeClient.kt  page console → logcat (debug builds)
  auth/
    AuthSession.kt           tokens + identity, in memory only
    CredentialStore.kt       EncryptedSharedPreferences persistence
    Pkce.kt                  PKCE + authorization URL
  runtime/
    DeviceRuntime.kt         folder → Space bindings, like `runtime up` per directory
    RuntimeService.kt        foreground service running every enabled binding
    RuntimeConnection.kt     /runtime/relay client (no local Harness)
    SandboxBridge.kt         supervises sandboxd over one folder
  ui/
    WebSurfaceHost.kt        Compose wrapper for the WebView, edge-to-edge insets
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

Debug builds (including CI dev APKs) are inspectable at `chrome://inspect` and
mirror the page console, uncaught errors included, to `adb logcat -s CohubWeb`.

`-PcohubEnv=dev|prod` (default prod) selects origins and the Logto native app;
single values can still be overridden (`cohubWebOrigin`, `cohubApiOrigin`, `cohubGatewayOrigin`,
`cohubLogtoEndpoint`, `cohubLogtoAppId`, …), as can `cohubVersionName`,
`cohubVersionCode` and `cohubVersionSuffix`.

## CI

`.github/workflows/android.yml` has two jobs:

- **dev** — every PR and main push that touches the shell tests, lints and
  assembles a dev APK (and checks the R8 release build). Same-repo builds are
  signed with the dev key (repository secrets `ANDROID_DEV_KEYSTORE_BASE64` /
  `ANDROID_DEV_KEYSTORE_PASSWORD`) and published to the CDN as
  `android/pr/<n>/cohub-dev-pr-<n>-<sha>.apk` or
  `android/main/cohub-dev-main-<sha>.apk`; the PR comment and the run summary
  link the APK with a QR code. Fork builds use a throwaway debug key, so they
  install but cannot sign in.
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
