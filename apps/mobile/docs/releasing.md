# Releasing Cohub Mobile

## Overview

The repository does not require Expo Application Services (EAS) for builds.

1. `CI` validates every PR and push to `main`, then exports Web, Android, and iOS JavaScript bundles.
2. `Native CI` compiles an Android debug APK on a GitHub Linux runner and an iOS simulator app on a GitHub macOS runner.
3. `Release Please` maintains a version/changelog PR from Conventional Commits.
4. Merging the Release Please PR creates `vX.Y.Z` and a GitHub Release, then calls `Native Release` to build signed Android and iOS store artifacts on GitHub-hosted runners.

Expo is used as the open-source React Native toolchain and for native modules. `expo prebuild` generates standard Gradle and Xcode projects inside CI. No Expo subscription or EAS project is required.

## One-time repository setup

### Android

Create an upload keystore and add these GitHub Actions secrets:

| Secret | Purpose |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded `.jks` file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Upload key alias |
| `ANDROID_KEY_PASSWORD` | Upload key password |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Google Play Developer API service account JSON |

The service account must be invited to the app in Google Play Console. The package name is `io.github.markbang.cohubmobile`.

### iOS

Create an App Store Connect API key with App Manager access, an App Store distribution certificate, and an App Store provisioning profile. Add:

| Kind | Name | Purpose |
| --- | --- | --- |
| Actions variable | `APPSTORE_ISSUER_ID` | App Store Connect issuer ID |
| Actions variable | `APPSTORE_API_KEY_ID` | App Store Connect API key ID |
| Actions variable | `APPSTORE_TEAM_ID` | Apple development team ID |
| Actions secret | `APPSTORE_API_PRIVATE_KEY` | Contents of `AuthKey_<id>.p8` |
| Actions secret | `APPSTORE_CERTIFICATES_FILE_BASE64` | Base64-encoded distribution `.p12` |
| Actions secret | `APPSTORE_CERTIFICATES_PASSWORD` | `.p12` password |

The native workflow uses `apple-actions/import-codesign-certs`, `apple-actions/download-provisioning-profiles`, and `apple-actions/upload-testflight-build`. The bundle identifier is `io.github.markbang.cohubmobile`.

Register `cohub://callback` in the Native Logto application. Logto credentials are runtime application configuration, not build-service credentials.

## Normal release

1. Merge feature PRs with Conventional Commit titles.
2. Wait for Release Please to open or update the Release PR.
3. Review the generated `CHANGELOG.md`, `package.json`, `package-lock.json`, and `app.json` version changes.
4. Confirm the required CI, Security, and Native CI checks are green.
5. Merge the Release Please PR.
6. GitHub creates the `vX.Y.Z` tag and release.
7. The same workflow starts signed Android and iOS production builds. Android is sent to the `internal` track by default; iOS is uploaded to TestFlight when store credentials are configured.

The release workflow validates that the tag is exactly `v<package version>`, and that `package.json` and `app.json` have identical versions. Native build numbers are derived deterministically from the app version in `app.config.ts`.

GitHub-hosted macOS runner usage may be subject to your GitHub plan's Actions quota. This is separate from Expo billing.

## Manual native builds

Open Actions -> `Native Release` -> Run workflow. Choose:

- `preview` for an Android debug APK and an iOS simulator ZIP
- `production` for signed store artifacts
- one platform or `all`
- `submit=true` only when the artifact should be sent to a store
- `internal` or `production` for the Google Play track (the automatic Release Please path uses `internal` until the first Play Console release is promoted)

Equivalent local preview commands:

```bash
npm run native:android
npm run native:ios
```

The iOS command requires macOS and Xcode. The Android command requires the Android SDK and Java 17.

## Recovery

If a native build fails after a GitHub Release exists, fix the relevant signing or store credential and rerun `Native Release` with:

- ref: the existing `vX.Y.Z` tag
- profile: `production`
- platform: the failed platform or `all`
- submit: enabled when the store upload should be retried
- release tag: the same `vX.Y.Z`

Do not create a second tag for the same source version.
