# Releasing Cohub Mobile

## Overview

The repository does not require Expo Application Services (EAS) for builds.

1. `CI` validates every PR and push to `main`, then exports Web, Android, and iOS JavaScript bundles.
2. `Native CI` compiles an Android debug APK on a GitHub Linux runner and an iOS simulator app on a GitHub macOS runner for internal validation only.
3. `Release Please` maintains a version/changelog PR from Conventional Commits.
4. Merging the Release Please PR creates `vX.Y.Z` and a GitHub Release. When the repository variable `NATIVE_AUTO_RELEASE_ENABLED` is `true` and the Android release keystore secrets are configured, the release also builds signed Android distribution APKs and attaches them to that GitHub Release. iOS and store submissions are not part of this automatic path.

Expo is used as the open-source React Native toolchain and for native modules. `expo prebuild` generates standard Gradle and Xcode projects inside CI. No Expo subscription or EAS project is required.

## One-time repository setup

### Android formal distribution

The current direct-download release path does not need a Google Play service account, but it does need one stable Android release keystore for formal APK signing. The same keystore must be used for every future version so Android can install updates over the previous version. The current `v1.1.0` APKs were signed with the old debug key and are not upgrade-compatible with the future formal-distribution key; uninstall `v1.1.0` before installing the first formally signed build.

Generate the keystore locally and keep a protected backup of both the file and its passwords:

```bash
keytool -genkeypair -v \
  -keystore cohub-release.keystore \
  -alias cohub-release \
  -storetype JKS \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000
```

Add the keystore and its metadata as GitHub Actions secrets:

```bash
base64 < cohub-release.keystore | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64 --repo markbang/cohub-mobile
gh secret set ANDROID_KEYSTORE_PASSWORD --repo markbang/cohub-mobile
gh secret set ANDROID_KEY_ALIAS --repo markbang/cohub-mobile --body cohub-release
gh secret set ANDROID_KEY_PASSWORD --repo markbang/cohub-mobile
```

The two password commands read their values interactively. Do not commit `cohub-release.keystore` or put it in the repository. Losing this keystore means future APKs cannot update an installed version.

If `NATIVE_AUTO_RELEASE_ENABLED=true` before all four Android signing secrets exist, the release gate logs a notice and skips the APK build; it does not fail the GitHub Release. Add all four secrets before expecting APKs.

After the secrets are configured, enable automatic formal APK builds:

```bash
gh variable set NATIVE_AUTO_RELEASE_ENABLED --repo markbang/cohub-mobile --body true
```

On the next Release Please release, GitHub Actions builds four signed standalone Android release APKs on Ubuntu, one for each ABI, and attaches them to the GitHub Release. These packages include the JavaScript bundle and can start without a Metro development server:

```text
cohub-vX.Y.Z-android-arm64-v8a.apk
cohub-vX.Y.Z-android-armeabi-v7a.apk
cohub-vX.Y.Z-android-x86.apk
cohub-vX.Y.Z-android-x86_64.apk
```

Each APK contains only its own native libraries, so each download is much smaller than one universal APK. The files are named directly, so the downloaded filename includes the ABI. This is direct APK distribution, not a Google Play upload. The automatic path does not build iOS and does not use a Google Play service account.

The first formally signed package must be produced by a new release created after this distribution workflow is merged. The existing `v1.1.0` APKs were produced before formal signing was enabled and use the old debug key; uninstall them before installing the first formally signed release. The manual run produces Actions artifacts and does not modify an existing GitHub Release.

### Android remote push later

Remote Android push is separate from APK signing. Create a Firebase Android app for package `io.github.markbang.cohubmobile`, download its `google-services.json`, and store it as a GitHub Actions secret without committing the file:

```bash
base64 < google-services.json | tr -d '\n' | gh secret set COHUB_GOOGLE_SERVICES_JSON_BASE64 --repo markbang/cohub-mobile
```

The release workflow injects this file only when the secret exists. The deployed Cohub API must also expose `POST /api/me/devices` and have a configured FCM/APNs delivery provider; the current production API returns `404` for that registration route, so adding the Firebase file alone cannot activate push delivery.

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
7. If `NATIVE_AUTO_RELEASE_ENABLED=true` and the Android release keystore secrets exist, the same workflow builds four signed ABI-specific Android distribution APKs and attaches them to the GitHub Release. It does not build iOS or upload to Google Play/TestFlight. With the variable unset or `false`, only the GitHub Release is created.

The release workflow validates that the tag is exactly `v<package version>`, and that `package.json` and `app.json` have identical versions. Native build numbers are derived deterministically from the app version in `app.config.ts`.

GitHub-hosted macOS runner usage may be subject to your GitHub plan's Actions quota. This is separate from Expo billing.

## Manual native builds

Open Actions -> `Native Release` -> Run workflow. Choose:

- `distribution` for signed standalone Android release APKs
- `production` for signed store artifacts (AAB/IPA)
- one platform or `all`
- `submit=true` only when a production artifact should be sent to a store; the automatic Release Please path always uses `submit=false`
- `internal` or `production` for the Google Play track when manually submitting a `profile=production` Android build

Equivalent local commands:

```bash
npm run native:android:distribution
```

The regular `npm run native:android` command remains a debug build for local development. It is not a release artifact.

The iOS command requires macOS and Xcode. The Android command requires the Android SDK and Java 17.

## Recovery

If the automatic Android distribution build fails, inspect the build error and rerun `Native Release` with `release_tag` set to the existing post-distribution `vX.Y.Z` tag, `platform=android`, `profile=distribution`, and `submit=false`. The manual rerun produces downloadable Actions artifacts; it does not attach them to the GitHub Release. Keep the same release keystore and passwords for all future versions.

For a Google Play failure, configure the Android signing and Play service-account secrets first, then rerun `Native Release` with:

- ref: the existing `vX.Y.Z` tag
- profile: `production`
- platform: `android`
- submit: `true` when the store upload should be retried
- release tag: the same `vX.Y.Z`

Do not create a second tag for the same source version.
