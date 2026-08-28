# Releasing Cohub Mobile

## Overview

The repository does not require Expo Application Services (EAS) for builds.

1. `CI` validates every PR and push to `main`, then exports Web, Android, and iOS JavaScript bundles.
2. `Native CI` compiles an Android debug APK on a GitHub Linux runner and an iOS simulator app on a GitHub macOS runner.
3. `Release Please` maintains a version/changelog PR from Conventional Commits.
4. Merging the Release Please PR creates `vX.Y.Z` and a GitHub Release. When the repository variable `NATIVE_AUTO_RELEASE_ENABLED` is `true`, the release also builds an Android debug APK and attaches it to that GitHub Release. iOS and store submissions are not part of this automatic path.

Expo is used as the open-source React Native toolchain and for native modules. `expo prebuild` generates standard Gradle and Xcode projects inside CI. No Expo subscription or EAS project is required.

## One-time repository setup

### Android APK now

No signing or store credentials are needed for the current Android distribution path. In GitHub, open **Settings -> Secrets and variables -> Actions -> Variables**, create a repository variable, and set:

| Variable | Value |
| --- | --- |
| `NATIVE_AUTO_RELEASE_ENABLED` | `true` |

You can also set it with the GitHub CLI:

```bash
gh variable set NATIVE_AUTO_RELEASE_ENABLED --repo markbang/cohub-mobile --body true
```

On the next Release Please release, GitHub Actions builds an Android debug APK for `arm64-v8a` devices on Ubuntu and attaches it to the GitHub Release as `cohub-vX.Y.Z-android.apk`. This is a direct APK download, not a Google Play upload. The automatic path does not build iOS and does not use any store credentials. Most current Android phones use arm64; an x86 emulator or older 32-bit-only device needs a separately configured architecture build.

For the existing `v1.1.0` release, run `Native Release` manually with `platform=android`, `profile=preview`, `submit=false` if you want an APK before the next version release.

### Android / Google Play later

A Google Play release requires an upload keystore and these GitHub Actions secrets:

| Secret | Purpose |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded `.jks` file |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Upload key alias |
| `ANDROID_KEY_PASSWORD` | Upload key password |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Google Play Developer API service account JSON |

The service account must be invited to the app in Google Play Console. The package name is `io.github.markbang.cohubmobile`. Use the manual `Native Release` workflow with `platform=android`, `profile=production`, and `submit=true` after these credentials are configured.

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
7. If `NATIVE_AUTO_RELEASE_ENABLED=true`, the same workflow builds an Android debug APK and attaches it to the GitHub Release. It does not build iOS or upload to Google Play/TestFlight. With the variable unset or `false`, only the GitHub Release is created.

The release workflow validates that the tag is exactly `v<package version>`, and that `package.json` and `app.json` have identical versions. Native build numbers are derived deterministically from the app version in `app.config.ts`.

GitHub-hosted macOS runner usage may be subject to your GitHub plan's Actions quota. This is separate from Expo billing.

## Manual native builds

Open Actions -> `Native Release` -> Run workflow. Choose:

- `preview` for an Android debug APK and an iOS simulator ZIP
- `production` for signed store artifacts
- one platform or `all`
- `submit=true` only when a production artifact should be sent to a store; the automatic Release Please path always uses `submit=false`
- `internal` or `production` for the Google Play track when manually submitting a `profile=production` Android build

Equivalent local preview commands:

```bash
npm run native:android
npm run native:ios
```

The iOS command requires macOS and Xcode. The Android command requires the Android SDK and Java 17.

## Recovery

If the automatic unsigned Android APK build fails, no signing or store credential is involved. Inspect the build error and rerun `Native Release` manually with `ref` set to the existing `vX.Y.Z` tag, `platform=android`, `profile=preview`, and `submit=false`. The manual rerun only produces a downloadable Actions artifact and does not attach it to the GitHub Release; keeping `NATIVE_AUTO_RELEASE_ENABLED=true` lets the next Release Please release rebuild and attach its APK automatically. The automatic preview build targets `arm64-v8a` only.

For a Google Play failure, configure the Android signing and Play service-account secrets first, then rerun `Native Release` with:

- ref: the existing `vX.Y.Z` tag
- profile: `production`
- platform: `android`
- submit: `true` when the store upload should be retried
- release tag: the same `vX.Y.Z`

Do not create a second tag for the same source version.
