# Releasing Cohub Mobile

## Overview

The repository does not require Expo Application Services (EAS) for builds.

1. `CI` validates every PR and push to `main`, then exports Android and iOS JavaScript bundles.
2. `Native CI` runs for pull requests targeting `main` and manual dispatches. It compiles Android debug APKs and an iOS simulator app for internal validation, without repeating the builds on the subsequent `main` push.
3. `Release Please` maintains a version/changelog PR from Conventional Commits.
4. Pushing a stable `vX.Y.Z` tag starts `Native Tag Release`: signed Android APKs are attached to the GitHub Release, and a signed iOS IPA is uploaded to TestFlight. Both platforms record their OTA fingerprints. Release Please creates the version tag when its release PR is merged; it does not start a separate native build.

An ordinary `main` push runs quality checks, bundle exports, security checks, Release Please, and production Android and iOS OTA. It does not compile native packages unless it produces a release tag. Every stable release tag, including a PATCH tag, starts both native distributions. Keep JS-only work on `main` without creating a tag until a native release is intended. Native CI remains available for pull requests and manual validation.

Expo is used as the open-source React Native toolchain and for native modules. `expo prebuild` generates standard Gradle and Xcode projects inside CI. No Expo subscription or EAS project is required.

## v2.2.0 native baseline

This release consolidates the SDK 57 patch updates on Expo 57.0.22, Expo Router 57.0.21, and Logto RN 1.3.0. SDK 58 is still a preview and is not part of this release. React and the React Native libraries stay on Expo's supported SDK 57 versions.

Migration: install the new same-key Android APK; do not bypass the OTA fingerprint check for older binaries. Validate sign-in, deep links, chat selection/scroll diagnostics, clipboard, files, and voice on device. iOS needs a separately built and validated native distribution before claiming the new baseline.

Logto 1.3 supports SDK 57 peer dependencies, so `npm ci` no longer uses `legacy-peer-deps`. The `react-dom` override tracks `$react` because Expo Router's transitive web peers otherwise select React DOM 19.3 against SDK 57's React 19.2.3; this does not add a web target. Batch future native dependency updates into planned APK releases, leaving JS-only changes on the installed native baseline for OTA.

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

Signing secrets are required for tag-triggered and manual native builds. Missing signing inputs fail the affected platform with an actionable error; they do not silently disable it. `NATIVE_AUTO_RELEASE_ENABLED` and `NATIVE_RELEASE_ON_VERSION_TAG` no longer control release behavior and can be removed from repository variables.

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

About > Application and the in-app update banner scan recent GitHub releases for the newest one that carries a signed APK for the device, so they only prompt when a new native package is required; JS-only releases stay silent and arrive through OTA. The app selects the device ABI, downloads the APK into its private cache, verifies its published size and GitHub `sha256:` digest, and grants Android's package installer temporary access through a `content://` URI. The primary update action does not open a browser. Missing or malformed digests block installation.

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

## Version policy

Automatic releases use `always-bump-patch`: ordinary features and fixes advance `2.2.0` to `2.2.1`, not `2.3.0`. Commit types still determine changelog sections. No automatic MAJOR bump is performed.

For the rare breaking change, explicitly request the next MINOR in the commit body (or the squash commit body when merging the PR), alongside the breaking-change description and migration note:

```text
feat(chat)!: change the message format

BREAKING CHANGE: Describe the incompatible behavior and the required migration.
Release-As: 2.3.0
```

The version is an example; use the next minor after the latest release. `!` or `BREAKING CHANGE` alone does not override `always-bump-patch`. Release Please honors the explicit `Release-As` version before applying the automatic strategy. Verify the release PR's version before merging; do not request a MAJOR unless separately agreed.

Version numbering does not determine native compatibility: native dependency/configuration changes still require a new APK even for a PATCH release.

## Tag automation setup

`Native Tag Release` is triggered only by tag pushes, not GitHub Release events or a second call from Release Please. It reuses `Native Release` with Android `distribution` / `submit=false` and iOS `production` / `submit=true`. Android attachment and iOS TestFlight publication finish independently; check both platform results before declaring a dual-platform release complete. TestFlight processing or review may delay tester availability after upload.

Release Please requires the `RELEASE_PLEASE_TOKEN` secret with repository contents and pull-request/issue write access. Use a PAT or GitHub App installation token authorized to create tags and trigger Actions. GitHub suppresses downstream workflows for tags created with the default `GITHUB_TOKEN`, so the workflow fails clearly instead of using that token. Existing signing and App Store Connect credentials remain required. No manual native dispatch is needed for a normal release.

Merge these workflow changes into `main` before tagging. A tag must point to a commit reachable from `origin/main`, must match `package.json` and `app.json`, and must be a stable `vX.Y.Z` without a prerelease suffix or leading zeros. A moved tag or version mismatch fails before signing. Do not retag a published version. The prepare job creates the GitHub Release if a manually pushed tag does not already have one.

After committing and merging the matching release metadata, a manual tag push is sufficient:

```bash
git tag vX.Y.Z <release-commit>
git push upstream vX.Y.Z
```

Replace the placeholders with the validated release version and commit. Merely creating a local tag does not trigger GitHub Actions. Prefer Release Please to update version/changelog files rather than manually editing release metadata.

## Normal release

1. Merge feature PRs with Conventional Commit titles. For breaking changes, include the explicit next-MINOR `Release-As` footer described above.
2. Wait for Release Please to open or update the Release PR.
3. Review the generated `CHANGELOG.md`, `package.json`, `package-lock.json`, and `app.json` version changes.
4. Confirm the required CI, Security, and Native CI checks are green.
5. Merge the Release Please PR.
6. Release Please creates the `vX.Y.Z` tag and release using `RELEASE_PLEASE_TOKEN`.
7. The tag push automatically starts `Native Tag Release` for both platforms. Wait for Android APK attachment and iOS TestFlight processing/fingerprint attachment. No manual build dispatch is required.

The release workflow validates that the tag is exactly `v<package version>`, and that `package.json` and `app.json` have identical versions. Native build numbers are derived deterministically from the app version in `app.config.ts`.

GitHub-hosted macOS runner usage may be subject to your GitHub plan's Actions quota. This is separate from Expo billing.

## Manual native builds

Open Actions -> `Native Release` -> Run workflow. Choose:

- `distribution` for signed standalone Android release APKs
- `production` for signed store artifacts (AAB/IPA)
- one platform or `all`
- `submit=true` when a production artifact should be sent to a store; automatic tag builds use `true` for iOS TestFlight and `false` for Android APK distribution
- `internal` or `production` for the Google Play track when manually submitting a `profile=production` Android build

Equivalent local commands:

```bash
npm run native:android:distribution
```

The regular `npm run native:android` command remains a debug build for local development. It is not a release artifact.

The iOS command requires macOS and Xcode. The Android command requires the Android SDK and Java 17.

## Recovery

If a tag-triggered native build fails, inspect the failed job and rerun failed jobs in `Native Tag Release` for that tag. Do not rerun an already successful TestFlight upload with the same build number. If only APK attachment failed, rerun that job without rebuilding. For manual recovery, `Native Release` still accepts the existing tag and platform/profile inputs; Android manual runs produce Actions artifacts that must be attached explicitly. Keep the same release keystore and passwords for all future versions.

For a Google Play failure, configure the Android signing and Play service-account secrets first, then rerun `Native Release` with:

- ref: the existing `vX.Y.Z` tag
- profile: `production`
- platform: `android`
- submit: `true` when the store upload should be retried
- release tag: the same `vX.Y.Z`

Do not create a second tag for the same source version.
