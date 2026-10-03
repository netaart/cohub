# Cohub Android shell

A thin native host for the Cohub web app. Compose owns start-up, sign-in, deep
links and system capabilities; the product UI stays in a WebView island so
Boards, docs and editors keep one implementation. All cross-boundary traffic
uses the versioned `cohub.host.v1` bridge — see `docs/native-host-bridge.md`.

```
app/src/main/kotlin/live/cohub/android/
  MainActivity.kt          activity host, edge-to-edge, deep links
  host/
    HostProtocol.kt        wire constants (mirrors packages/protocol)
    HostCapabilities.kt    what this build advertises
    HostBridge.kt          request dispatch, events, capability handshake
    WebSurface.kt          the WebView island
    CohubWebViewClient.kt  navigation policy, renderer-crash recovery
  auth/
    AuthSession.kt         tokens + identity, in memory only
    CredentialStore.kt     EncryptedSharedPreferences persistence
    Pkce.kt                PKCE + authorization URL
  ui/WebSurfaceHost.kt     Compose wrapper for the WebView
```

Not part of the pnpm workspace: Gradle is a separate toolchain.

```bash
cd apps/android
./gradlew :app:assembleDebug   # needs JDK 17+ and ANDROID_HOME
```

Build config (`cohubEnv`, `cohubApiOrigin`, `cohubWebOrigin`, `cohubLogtoAppId`,
…) comes from Gradle properties and defaults to prod.
