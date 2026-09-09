# Releasing Cohub Mobile

## Overview

The repository does not require Expo Application Services (EAS) for builds.

1. `CI` validates every PR and push to `main`, then exports Web, Android, and iOS JavaScript bundles.
2. `Native CI` runs for pull requests targeting `main` and manual dispatches. It compiles Android debug APKs and an iOS simulator app for internal validation, without repeating the builds on the subsequent `main` push.
3. `Release Please` maintains a version/changelog PR from Conventional Commits.
4. Merging the Release Please PR creates `vX.Y.Z` and a GitHub Release. It does not build APKs. Signed Android packages are produced by the manual Native Release workflow when SDK or native code changes. Set `NATIVE_RELEASE_ON_VERSION_TAG=true` only if a version tag must also attach APKs.

An ordinary `main` push runs quality checks, bundle exports, security checks, Release Please, and production Android and iOS OTA. It does not compile native packages. Native CI remains available through Actions > Native CI > Run workflow for pull requests and manual native validation.

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

Signing secrets are still required for the manual Native Release path. Version tags do not build APKs unless `NATIVE_RELEASE_ON_VERSION_TAG=true`.

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

### In-app Android updates

About > Application and the existing update banner use GitHub's latest stable release. The app selects the device ABI, downloads the APK into its private cache, verifies its published size and GitHub `sha256:` digest, and grants Android's package installer temporary access through a `content://` URI. The primary update action does not open a browser. Missing or malformed digests block installation.

Downloads show progress and can be cancelled. Failed or cancelled downloads are removed; a verified APK is retained for installation retries. Closing the installer does not snooze the release or count as a successful update. Android checks package/signature compatibility and requires user confirmation. The update sheet includes an Installation permission action for Android's "Install unknown apps" setting. Keep the same signing key for every release.

Migration: users must install a new signed native APK containing `expo-intent-launcher`, `expo-updates`, and `REQUEST_INSTALL_PACKAGES` once before they can use this flow. Existing installations cannot acquire these native capabilities through OTA. iOS package distribution is unchanged.

### Optional OTA service

`expo-updates` is installed, but OTA is disabled until `EXPO_PUBLIC_UPDATES_URL` is set to an absolute HTTPS Expo Updates protocol endpoint at native build time. `Native Release` reads the same-named GitHub repository variable for Android and iOS builds. A GitHub Release URL or ordinary JSON version manifest is not an OTA service.

- The client uses `ON_LOAD` with a zero startup wait: launch cached/embedded code, download an update in the background, and load it on a subsequent cold launch. It does not reload an active chat.
- `runtimeVersion` uses the `fingerprint` policy. `fingerprint.config.js` skips app version fields (`version`, `android.versionCode`, `ios.buildNumber`), so a Release Please version bump does not change the runtime and JS-only commits keep riding the installed binary. Changing Expo SDK, native dependencies, permissions, or other native configuration changes the fingerprint and requires a new APK or TestFlight build. Android and iOS fingerprints differ, so each platform publishes its own runtime.
- Use the same production environment values when building the native binary and exporting OTA bundles. `EXPO_PUBLIC_*` values are public.
- The deployed service is [markbang/cloudflare-expo-ota-updates](https://github.com/markbang/cloudflare-expo-ota-updates). The manifest endpoint is `https://expo-ota.talesofai.com/manifest`; assets are served from the existing R2 bucket `expo-updates` at `https://expo-updates.talesofai.com`. Repository variables `EXPO_PUBLIC_UPDATES_URL` and `OTA_SERVER` are configured. See the service's `docs/COHUB.md` for redeployment.
- A push to `main` publishes production Android and iOS OTA automatically. The workflow exports that commit, resolves each platform's runtime from its installed native binary (`assets/fingerprint` in the latest arm64 APK, `cohub-ios-native-fingerprint.txt` from the newest release that has it), then uploads both platforms immediately. A missing iOS fingerprint fails the iOS export job only; Android publishing still completes. Manual Actions > Publish OTA remains for staging or a specific SHA. There is no environment approval gate.
- Native Release attaches `cohub-android-native-fingerprint.txt` to signed Android distributions and `cohub-ios-native-fingerprint.txt` to the GitHub Release when a production iOS build is submitted to TestFlight. Bootstrap each platform once with an OTA-capable native binary; after that, JS-only work does not need a new package. OTA is indexed with the runtime embedded in that binary (`assets/fingerprint` in the APK, `EXUpdates.bundle/fingerprint` in the IPA) so installed devices can receive it.
- An existing iOS build cannot gain `expo-updates` configuration through OTA. Ship one new TestFlight build with `EXPO_PUBLIC_UPDATES_URL` set before iOS OTA can serve devices.
- Mobile publication needs `OTA_API_KEY` and `OTA_SERVER`. The CLI is the pinned `markbang/cloudflare-expo-ota-updates` revision in `.github/workflows/publish-ota.yml`, not the unmodified npm `easc` package.
- When OTA is enabled, `app.config.ts` sends app ID `cohub-mobile` and channel `production`, and requires manifests signed against `certs/ota-certificate.crt`. The matching private key is held in the server repository's `OTA_SIGNING_PRIVATE_KEY` secret and installed as the Worker secret `CODE_SIGNING_PRIVATE_KEY`. Never put the private key in this repository or replace the certificate without a native migration.
- The publishing credential is stored in this repository's `OTA_API_KEY` Actions secret. It is not an app environment variable and must never use an `EXPO_PUBLIC_*` name. The fork's CLI supports function-based Expo configuration and per-platform publishing; use a reviewed, pinned fork revision rather than the unmodified npm CLI.
- Validate on two same-key Android release builds: deny/grant installation permission, cancel/retry downloads, return from the installer without installing, then install the newer APK. For OTA, test offline launch, matching/mismatching runtime versions, failed downloads, and server rollback on both platforms; iOS requires a TestFlight build. Expo Go and browser previews cannot verify these native paths.

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

The native workflow uses `apple-actions/import-codesign-certs`, `apple-actions/download-provisioning-profiles`, and `apple-actions/upload-testflight-build`. The bundle identifier is `io.github.markbang.cohubmobile`. `app.json` declares `ITSAppUsesNonExemptEncryption=false`, so each build carries its export-compliance answer and the upload action does not patch build metadata through the App Store Connect API (that request needs an App Manager or Admin key).

Register `cohub://callback` in the Native Logto application. Logto credentials are runtime application configuration, not build-service credentials.

## Normal release

1. Merge feature PRs with Conventional Commit titles.
2. Wait for Release Please to open or update the Release PR.
3. Review the generated `CHANGELOG.md`, `package.json`, `package-lock.json`, and `app.json` version changes.
4. Confirm the required CI, Security, and Native CI checks are green.
5. Merge the Release Please PR.
6. GitHub creates the `vX.Y.Z` tag and release.
7. GitHub creates the `vX.Y.Z` tag and release without APKs. JS-only updates publish as production Android and iOS OTA on the `main` push. When SDK or native code changes, run Native Release to attach signed APKs to that tag and to ship a new iOS TestFlight build whose fingerprint is attached to the release.

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

If a Native Release APK build fails, inspect the build error and rerun `Native Release` with `release_tag` set to the existing `vX.Y.Z` tag, `platform=android`, `profile=distribution`, and `submit=false`. The manual rerun produces downloadable Actions artifacts; it does not attach them to the GitHub Release. Keep the same release keystore and passwords for all future versions.

For a Google Play failure, configure the Android signing and Play service-account secrets first, then rerun `Native Release` with:

- ref: the existing `vX.Y.Z` tag
- profile: `production`
- platform: `android`
- submit: `true` when the store upload should be retried
- release tag: the same `vX.Y.Z`

Do not create a second tag for the same source version.
