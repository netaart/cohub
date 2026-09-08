# Cohub Mobile

[![CI](https://github.com/markbang/cohub-mobile/actions/workflows/ci.yml/badge.svg)](https://github.com/markbang/cohub-mobile/actions/workflows/ci.yml)
[![Security](https://github.com/markbang/cohub-mobile/actions/workflows/security.yml/badge.svg)](https://github.com/markbang/cohub-mobile/actions/workflows/security.yml)
[![Release](https://github.com/markbang/cohub-mobile/actions/workflows/release-please.yml/badge.svg)](https://github.com/markbang/cohub-mobile/actions/workflows/release-please.yml)

A native iOS and Android client for Cohub, built with React Native and Expo.

The app uses native screens for Chats, Spaces, Activity, Profile, session timelines, files, and settings. Published HTML/Work previews are opened in a constrained WebView because their content is inherently web-based.

## Included

- Native Chats inbox with paginated cross-Space selection, search, running/attention filters, optimistic sends, stop, rename, attachments, camera, photo library, and live Cohub stream patches
- Turn-based Chat history with older/newer pagination, searchable turn navigation, direct window jumps, and stable scroll position
- Model picker with availability lights, provider/context metadata, and per-model thinking levels
- Native PCM voice input connected to Cohub ASR
- Spaces with Chats, Files, Saves, Works, and Task Runs
- Native file viewer plus constrained WebView for published Works
- Activity and usage overview
- Native Settings sections for Profile, Appearance, Activity, Notifications, Rules, Channels, Billing, and Referrals
- Cache-first SQLite hydration, reconnect reconciliation, and user-scoped cache clearing
- Native Logto PKCE, `cohub://` deep links, notification tap routing, APNs/FCM token acquisition, and GitHub-native build profiles

## Stack

- Expo SDK 57 and React Native New Architecture (Expo is used as an open-source toolchain; EAS is not required)
- Expo Router for native navigation and deep links
- `@neta-art/cohub` for Cohub HTTP and WebSocket APIs
- SQLite for user-scoped offline cache
- SecureStore for the installation identity and native auth storage
- Logto React Native SDK for PKCE sign-in
- APNs / FCM device permission plumbing
- In-app Android APK downloads with SHA-256 verification and system installation
- Optional Expo OTA updates, downloaded in the background for the next app launch

## Run

```bash
npm install
npm run start
```

Use a development build for native modules:

```bash
npm run prebuild
npm run ios
npm run android
```

The web command is only a lightweight preview. The product target is native iOS/Android.

Run the same checks as CI before opening a PR:

```bash
npm run check
npm run export:web
npm run export:android
npm run export:ios
npm run native:android
npm run native:ios
```

## CI and releases

- `CI` runs lint, strict TypeScript, release metadata validation, Expo Doctor, dependency audit, and three-platform JavaScript exports.
- `Native CI` compiles Android and iOS debug artifacts for pull requests and manual runs; it does not run on every `main` push.
- `Publish OTA` exports a selected `main` commit and publishes it to staging or production after fingerprint checks; production waits for environment approval.
- `Security` runs dependency review and CodeQL.
- Release Please maintains `CHANGELOG.md`, synchronizes the Expo and npm versions, and creates `vX.Y.Z` GitHub Releases.
- Version tags create GitHub Releases without APKs. Signed Android APKs are built by the manual Native Release workflow when SDK or native code changes. JS-only updates go out through Publish OTA.
- Dependabot updates npm and GitHub Actions dependencies weekly.

See [docs/releasing.md](docs/releasing.md) for signing secrets, store credentials, native runner details, normal releases, manual builds, and recovery. Android updates download directly in the app; users still confirm installation in Android. OTA requires an Expo Updates protocol service configured through `EXPO_PUBLIC_UPDATES_URL` at build time and is disabled without one. OTA publication is separate and manual; `main` pushes do not automatically publish updates.

## Logto setup

Register this callback URI in the Logto application (or provide a dedicated native Logto app ID through `EXPO_PUBLIC_LOGTO_APP_ID`):

```text
cohub://callback
```

The production defaults mirror the Cohub web client. The hosted Logto application must explicitly allow `cohub://callback`; otherwise create a Native Logto application and set its public app ID in `.env`. Override the other endpoints when using a self-hosted or development deployment. Do not place client secrets in the app.

## Push setup

The client requests native notification permission, reads an APNs/FCM device token, and registers the device with Cohub. Remote push requires all of the following:

- A physical device and a development or standalone build. Expo Go cannot provide Android remote push tokens.
- Android: a Firebase `google-services.json` for `io.github.markbang.cohubmobile`, supplied to the build as `COHUB_GOOGLE_SERVICES_JSON_BASE64`.
- iOS: valid APNs entitlements and signing credentials.
- A deployed Cohub API with `POST /api/me/devices` enabled and a configured notification delivery provider.

The expected server registration contract is:

```text
POST /api/me/devices
{
  "installationId": "stable app installation id",
  "platform": "ios" | "android",
  "token": "APNs or FCM token",
  "appVersion": "..."
}
```

The mobile Settings screen reports which prerequisite failed: permission, native token, Firebase/APNs configuration, authentication, or server registration. Push payloads should contain `notificationId`, `type`, `spaceId`, `sessionId`, `turnId`, and `deepLink`. The app routes foreground and cold-start notification taps into the target Chat and fetches authoritative state from Cohub rather than trusting message text in the payload.

Universal links also require `cohub.live` to publish the Apple AASA and Android asset-links files for `io.github.markbang.cohubmobile`. Custom `cohub://` links work without those hosted files.

## Architecture

`src/data/context.tsx` owns the first vertical slice: cache-first home hydration, Cohub SDK access, session subscriptions, optimistic sends, attachment uploads, and foreground refresh. UI stays in route files and components so the same protocol semantics can later be shared with the web client through a framework-free runtime package.

Native-specific work is isolated under `src/platform/`:

- `installation.ts` stores a stable per-installation identity.
- `notifications.ts` handles APNs/FCM permission and token acquisition.

## Security notes

- Access and refresh tokens are managed by the native Logto SDK and platform storage.
- SQLite data is scoped by the authenticated user UUID and is cleared on sign out.
- Push payloads should not contain prompt, code, file, or secret content.
- Work previews must keep an origin allowlist and must not receive unrestricted native bridge access.
