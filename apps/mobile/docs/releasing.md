# Releasing Cohub Mobile

## Overview

The app lives in `apps/mobile` of the [Cohub monorepo](https://github.com/netaart/cohub). One workflow, `Mobile CI` (`.github/workflows/mobile-ci.yml` at the repository root), builds and releases it, running every step from `apps/mobile`. The repository does not require Expo Application Services (EAS) for builds.

1. Pull requests and `main` pushes that touch `apps/mobile` run Quality and Android/iOS bundle exports in parallel.
2. A `main` push also publishes production OTA, then runs the Android device E2E against it.
3. Pushing a stable `cohub-mobile-vX.Y.Z` tag runs the release jobs. They create the GitHub Release with notes from the app's commits, attaches signed Android APKs, and uploads a signed iOS IPA to TestFlight. Both platforms record their OTA fingerprints.

Manual runs (Actions -> `Mobile CI` -> Run workflow) pick one `task`: `ci`, `native-debug` (Android debug APKs and an iOS simulator app for internal validation), `native-release`, `ota` (staging or a specific SHA), or `e2e`. Pull requests and `main` pushes never compile native packages. Every stable app tag, including a PATCH tag, starts both native distributions. Keep JS-only work on `main` without creating a tag until a native release is intended.

The monorepo's own `vX.Y.Z` tags release and deploy the Cohub services. Never push a `vX.Y.Z` tag for the app: it would start production service deployments and no app build.

Expo is used as the open-source React Native toolchain and for native modules. `expo prebuild` generates standard Gradle and Xcode projects inside CI. No Expo subscription or EAS project is required.

## v2.2.0 native baseline

This release consolidates the SDK 57 patch updates on Expo 57.0.22, Expo Router 57.0.21, and Logto RN 1.3.0. SDK 58 is still a preview and is not part of this release. React and the React Native libraries stay on Expo's supported SDK 57 versions.

Migration: install the new same-key Android APK; do not bypass the OTA fingerprint check for older binaries. Validate sign-in, deep links, chat selection/scroll diagnostics, clipboard, files, and voice on device. iOS needs a separately built and validated native distribution before claiming the new baseline.

Logto 1.3 supports SDK 57 peer dependencies, so `npm ci` no longer uses `legacy-peer-deps`. The `react-dom` override tracks `$react` because Expo Router's transitive web peers otherwise select React DOM 19.3 against SDK 57's React 19.2.3; this does not add a web target. Batch future native dependency updates into planned APK releases, leaving JS-only changes on the installed native baseline for OTA.

## One-time repository setup

Actions secrets and variables for the app carry a `MOBILE_` prefix so they stay apart from the monorepo's service credentials. The tag release passes only its signing secrets to the native build instead of inheriting every repository secret. The external TestFlight group is the `MOBILE_TESTFLIGHT_EXTERNAL_BETA_GROUP` variable, and device E2E reads the `MOBILE_E2E_ACCOUNT_EMAIL` and `MOBILE_E2E_ACCOUNT_PASSWORD` secrets.

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
base64 < cohub-release.keystore | tr -d '\n' | gh secret set MOBILE_ANDROID_KEYSTORE_BASE64 --repo netaart/cohub
gh secret set MOBILE_ANDROID_KEYSTORE_PASSWORD --repo netaart/cohub
gh secret set MOBILE_ANDROID_KEY_ALIAS --repo netaart/cohub --body cohub-release
gh secret set MOBILE_ANDROID_KEY_PASSWORD --repo netaart/cohub
```

The two password commands read their values interactively. Do not commit `cohub-release.keystore` or put it in the repository. Losing this keystore means future APKs cannot update an installed version.

Signing secrets are required for tag-triggered and manual native builds. Missing signing inputs fail the affected platform with an actionable error; they do not silently disable it.

On a stable tag push, GitHub Actions builds four signed standalone Android release APKs on Ubuntu, one for each ABI, and attaches them to the GitHub Release. These packages include the JavaScript bundle and can start without a Metro development server:

```text
cohub-vX.Y.Z-android-arm64-v8a.apk
cohub-vX.Y.Z-android-armeabi-v7a.apk
cohub-vX.Y.Z-android-x86.apk
cohub-vX.Y.Z-android-x86_64.apk
```

Each APK contains only its own native libraries, so each download is much smaller than one universal APK. The files are named directly, so the downloaded filename includes the ABI. This is direct APK distribution, not a Google Play upload. iOS builds in parallel and uploads to TestFlight; the automatic Android path does not use a Google Play service account.

The first formally signed package must be produced by a new release created after this distribution workflow is merged. The existing `v1.1.0` APKs were produced before formal signing was enabled and use the old debug key; uninstall them before installing the first formally signed release. The manual run produces Actions artifacts and does not modify an existing GitHub Release.

### In-app Android updates

About > Application and the in-app update banner scan Yaota (`https://mobile.talesofai.com/api/apks`) for the newest signed APK for the device, so they only prompt when a new native package is required; JS-only releases stay silent and arrive through OTA. The tag release attaches the four ABI APKs to the GitHub Release, then publishes the same files to Yaota. The app selects the device ABI, downloads the APK from Yaota into its private cache, verifies the published size and SHA-256 digest, and grants Android's package installer temporary access through a `content://` URI. The primary update action does not open a browser. Missing or malformed digests block installation.

Downloads show progress and can be cancelled. Failed or cancelled downloads are removed; a verified APK is retained for installation retries. Closing the installer does not snooze the release or count as a successful update. Android checks package/signature compatibility and requires user confirmation. The update sheet includes an Installation permission action for Android's "Install unknown apps" setting. Keep the same signing key for every release.

Migration: users must install a new signed native APK containing `expo-intent-launcher`, `expo-updates`, and `REQUEST_INSTALL_PACKAGES` once before they can use this flow. Existing installations cannot acquire these native capabilities through OTA. iOS package distribution is unchanged.

### Optional OTA service

`expo-updates` is installed, but OTA is disabled until `EXPO_PUBLIC_UPDATES_URL` is set to an absolute HTTPS Expo Updates protocol endpoint at native build time. Native builds read it from the `MOBILE_EXPO_PUBLIC_UPDATES_URL` repository variable for Android and iOS builds. A GitHub Release URL or ordinary JSON version manifest is not an OTA service.

- The client uses `ON_LOAD` with a zero startup wait: launch cached/embedded code, download an update in the background, and load it on a subsequent cold launch. It does not reload an active chat.
- `runtimeVersion` uses the `fingerprint` policy. `fingerprint.config.js` skips app version fields (`version`, `android.versionCode`, `ios.buildNumber`), so a release version bump does not change the runtime and JS-only commits keep riding the installed binary. Changing Expo SDK, native dependencies, permissions, or other native configuration changes the fingerprint and requires a new APK or TestFlight build. Android and iOS fingerprints differ, so each platform publishes its own runtime.
- Use the same production environment values when building the native binary and exporting OTA bundles. `EXPO_PUBLIC_*` values are public.
- The deployed service is [markbang/yaota](https://github.com/markbang/yaota). The manifest endpoint is `https://mobile.talesofai.com/manifest`; the Worker serves content-addressed assets from the `expo-updates` R2 bucket through `/ota-assets/ID/HASH`. Repository variables `MOBILE_EXPO_PUBLIC_UPDATES_URL` and `MOBILE_OTA_SERVER` are configured.
- A push to `main` that touches `apps/mobile` publishes production Android and iOS OTA automatically. The workflow exports that commit, resolves each platform's runtime from its installed native binary (`assets/fingerprint` in the arm64 APK of the newest `cohub-mobile-v*` release that has one, `cohub-ios-native-fingerprint.txt` likewise), then uploads both platforms immediately. A missing iOS fingerprint fails the iOS export job only; Android publishing still completes. A manual `Mobile CI` run with `task=ota` remains for staging or a specific SHA. Main pushes and OTA runs queue per channel, so an older commit's OTA never overtakes a newer one. There is no environment approval gate.
- Each platform's upload retries transient failures (network errors, timeouts, HTTP 5xx/429) up to three times with a growing delay. Auth errors, fingerprint mismatches, and other rejections fail or skip immediately. Repeating is safe: blobs are content-addressed, an interrupted attempt leaves at most an unserved Staged release, and the per-channel concurrency group keeps a retry from overtaking a newer commit.
- The native release attaches `cohub-android-native-fingerprint.txt` to signed Android distributions and `cohub-ios-native-fingerprint.txt` to the GitHub Release when a production iOS build is submitted to TestFlight. Bootstrap each platform once with an OTA-capable native binary; after that, JS-only work does not need a new package. OTA is indexed with the runtime embedded in that binary (`assets/fingerprint` in the APK, `EXUpdates.bundle/fingerprint` in the IPA) so installed devices can receive it.
- An existing iOS build cannot gain `expo-updates` configuration through OTA. Ship one new TestFlight build with `EXPO_PUBLIC_UPDATES_URL` set before iOS OTA can serve devices.
- Mobile publication needs the `MOBILE_OTA_API_KEY` secret and the `MOBILE_OTA_SERVER` variable. CI runs the pinned Yaota `scripts/publish.ts` on Node 24, reusing the existing Expo export. It computes the source native fingerprint independently from the installed runtime, exports the public Expo config, and records the source commit. `--delta-bases 3` generates verified BSDIFF40 patches against up to three compatible historical releases. The release stays staged until patch preparation succeeds, then activates automatically. See [the delta integration notes](yaota-delta.md).
- When OTA is enabled, `app.config.ts` sends app ID `cohub-mobile` and channel `production`, and requires manifests signed against `certs/ota-certificate.crt`. The matching private key is held in the server repository's `OTA_SIGNING_PRIVATE_KEY` secret and installed as the Worker secret `CODE_SIGNING_PRIVATE_KEY`. Never put the private key in this repository or replace the certificate without a native migration.
- The publishing credential is stored in the repository's `MOBILE_OTA_API_KEY` Actions secret. It is not an app environment variable and must never use an `EXPO_PUBLIC_*` name. Keep the Yaota publisher pinned to a reviewed commit.
- Validate on two same-key Android release builds: deny/grant installation permission, cancel/retry downloads, return from the installer without installing, then install the newer APK. For OTA, test offline launch, matching/mismatching runtime versions, failed downloads, and server rollback on both platforms; iOS requires a TestFlight build. Expo Go and browser previews cannot verify these native paths.

### Android remote push later

Remote Android push is separate from APK signing. Create a Firebase Android app for package `io.github.markbang.cohubmobile`, download its `google-services.json`, and store it as a GitHub Actions secret without committing the file:

```bash
base64 < google-services.json | tr -d '\n' | gh secret set MOBILE_COHUB_GOOGLE_SERVICES_JSON_BASE64 --repo netaart/cohub
```

The release workflow injects this file only when the secret exists. The deployed Cohub API must also expose `POST /api/me/devices` and have a configured FCM/APNs delivery provider; the current production API returns `404` for that registration route, so adding the Firebase file alone cannot activate push delivery.

### Android / Google Play later

A Google Play release requires an upload keystore and these GitHub Actions secrets:

| Secret | Purpose |
| --- | --- |
| `MOBILE_ANDROID_KEYSTORE_BASE64` | Base64-encoded `.jks` file |
| `MOBILE_ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `MOBILE_ANDROID_KEY_ALIAS` | Upload key alias |
| `MOBILE_ANDROID_KEY_PASSWORD` | Upload key password |
| `MOBILE_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Google Play Developer API service account JSON |

The service account must be invited to the app in Google Play Console. The package name is `io.github.markbang.cohubmobile`. Run `Mobile CI` manually with `task=native-release`, `platform=android`, `profile=production`, and `submit=true` after these credentials are configured.

### iOS

Create an App Store Connect API key with App Manager access, an App Store distribution certificate, and an App Store provisioning profile. Add:

| Kind | Name | Purpose |
| --- | --- | --- |
| Actions variable | `MOBILE_APPSTORE_ISSUER_ID` | App Store Connect issuer ID |
| Actions variable | `MOBILE_APPSTORE_API_KEY_ID` | App Store Connect API key ID |
| Actions variable | `MOBILE_APPSTORE_TEAM_ID` | Apple development team ID |
| Actions secret | `MOBILE_APPSTORE_API_PRIVATE_KEY` | Contents of `AuthKey_<id>.p8` |
| Actions secret | `MOBILE_APPSTORE_CERTIFICATES_FILE_BASE64` | Base64-encoded distribution `.p12` |
| Actions secret | `MOBILE_APPSTORE_CERTIFICATES_PASSWORD` | `.p12` password |

The native workflow uses `apple-actions/import-codesign-certs`, `apple-actions/download-provisioning-profiles`, and `apple-actions/upload-testflight-build`. The bundle identifier is `io.github.markbang.cohubmobile`. `app.json` declares `ITSAppUsesNonExemptEncryption=false`, so each build carries its export-compliance answer and the upload action does not patch build metadata through the App Store Connect API (that request needs an App Manager or Admin key).

Register `cohub://callback` in the Native Logto application. Logto credentials are runtime application configuration, not build-service credentials.

## Version policy

The app's version is independent of the monorepo's service version. Pick it when cutting a release: ordinary features and fixes advance the PATCH (`2.2.14` to `2.2.15`). For the rare breaking change, take the next MINOR and include a migration note in the release PR. Do not bump MAJOR unless separately agreed.

Commit types only choose the release-notes section. Version numbering does not determine native compatibility: native dependency/configuration changes still require a new APK even for a PATCH release. Native build numbers are derived deterministically from the version in `app.config.ts`, so a version cannot be released twice.

## Tag automation setup

The release jobs of `Mobile CI` start on `cohub-mobile-v*` tag pushes. Their plan job builds Android `distribution` / `submit=false` and iOS `production` / `submit=true`. Android attachment and iOS TestFlight publication finish independently; check both platform results before declaring a dual-platform release complete. TestFlight processing or review may delay tester availability after upload.

A tag must point to a commit reachable from `origin/main`, must match `package.json` and `app.json`, and must be a stable `cohub-mobile-vX.Y.Z` without a prerelease suffix or leading zeros. A moved tag or version mismatch fails before signing. Do not retag a published version.

The prepare job creates the GitHub Release when the tag has none. Its notes list the Conventional Commits under `apps/mobile` since the previous `cohub-mobile-v*` tag (`scripts/release-notes.mjs`); the same notes reach the in-app update sheet through Yaota. The release is created with `--latest=false` so it never replaces the services' release as the repository's Latest.

Push tags as a person or with a token that triggers workflows. Tags created with the default `GITHUB_TOKEN` do not start downstream workflows.

The app's history was imported with its tags renamed: the former `vX.Y.Z` tags of `markbang/cohub-mobile` are `cohub-mobile-vX.Y.Z` here, and their GitHub Releases stay in that repository. OTA publication and device E2E read the newest app release's APK and fingerprint files from this repository, so at least one `cohub-mobile-v*` release carrying them must exist here.

## Normal release

1. Merge feature PRs with Conventional Commit titles.
2. Open a release PR that sets the new version in `package.json`, `package-lock.json`, and `app.json`, titled `chore(mobile): release X.Y.Z`. From `apps/mobile`, `npm version X.Y.Z --no-git-tag-version` updates both npm files; edit `expo.version` in `app.json` to match.
3. Confirm `Mobile CI` is green, then merge.
4. Tag the merged commit and push the tag:

   ```bash
   git tag cohub-mobile-vX.Y.Z <release-commit>
   git push origin cohub-mobile-vX.Y.Z
   ```

5. Wait for the tag's `Mobile CI` run: the GitHub Release, Android APK attachment, Yaota publication, and iOS TestFlight processing/fingerprint attachment. No manual build dispatch is required.

Replace the placeholders with the validated release version and commit. Merely creating a local tag does not trigger GitHub Actions.

GitHub-hosted macOS runner usage may be subject to your GitHub plan's Actions quota. This is separate from Expo billing.

## Manual native builds

Open Actions -> `Mobile CI` -> Run workflow with `task=native-release` and an existing `release_tag`. Choose:

- `distribution` for signed standalone Android release APKs
- `production` for signed store artifacts (AAB/IPA)
- one platform or `all`
- `submit=true` when a production artifact should be sent to a store; automatic tag builds use `true` for iOS TestFlight and `false` for Android APK distribution
- `internal` or `production` for the Google Play track when manually submitting a `profile=production` Android build

Equivalent local commands, from `apps/mobile`:

```bash
npm run native:android:distribution
```

The regular `npm run native:android` command remains a debug build for local development. It is not a release artifact.

The iOS command requires macOS and Xcode. The Android command requires the Android SDK and Java 17.

## Recovery

If a tag-triggered native build fails, inspect the failed job and rerun failed jobs in that tag's `Mobile CI` run. Do not rerun an already successful TestFlight upload with the same build number. If only APK attachment failed, rerun that job without rebuilding. For manual recovery, a `task=native-release` run accepts the existing tag and platform/profile inputs; manual runs produce Actions artifacts and never attach to the GitHub Release or publish to Yaota. Keep the same release keystore and passwords for all future versions.

For a Google Play failure, configure the Android signing and Play service-account secrets first, then run `Mobile CI` from `main` with:

- task: `native-release`
- profile: `production`
- platform: `android`
- submit: `true` when the store upload should be retried
- release tag: the same `cohub-mobile-vX.Y.Z`

Do not create a second tag for the same source version.
