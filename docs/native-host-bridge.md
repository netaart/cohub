# Native host bridge

Cohub ships a web surface and native shells (Android today, iOS later). The
bridge lends a web surface what a browser cannot have: the credential store, the
OAuth round trip, deep links, and system integration.

Contract: `packages/protocol/src/host-bridge.ts` (single source of truth).
Web client: `packages/sdk/src/host-bridge.ts`.
Android: `apps/android/app/src/main/kotlin/live/cohub/android/host/`.

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

1. **Capabilities gate calls, not versions.** Adding a capability is safe;
   removing one breaks shipped web bundles.
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
| `auth.signOut` | `auth.token` | Clears the host store, pushes `auth.signedOut` |
| `share.text` | `share` | Native share sheet |
| `navigation.openPath` | `navigation` | In-shell path navigation |
| `cache.clear` | `cache` | Host state only; IndexedDB is the web app's |

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

## Adding a method

1. Add it to `HOST_BRIDGE_METHODS` with params and result schemas.
2. Implement it in the host; add the capability to `HostCapabilities.advertised`.
3. Add the web-side caller behind `supportsHostCapability()`.
4. Mirror the constant in `HostProtocol.kt` so `HostProtocolTest` passes.
