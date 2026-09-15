# Yaota Binary Delta Integration

## Cause And Change

The mobile workflow previously invoked the legacy easc multipart uploader. Yaota's multipart handler stores deduplicated blobs, but does not generate binary patches. The workflow now runs Yaota's TypeScript publisher, pinned to `62e237e864b291c6ee266a6af820569817ab984c`, for both platforms.

The publisher reuses the existing Expo export and public config, receives the installed runtime and independently calculated source fingerprint, and records the Git commit. It uploads missing content hashes, creates a staged release, generates and verifies BSDIFF40 patches against up to three compatible bases, and activates only after preparation succeeds. No new native dependency or signing certificate is introduced.

## Delivery Boundaries

- Binary deltas apply to the launch bundle, not an APK or every image. Unchanged assets remain hash-cached.
- Bases must match app, platform, runtime, fingerprint, and the applicable branch rules.
- Identical bundles need no patch. A patch at least as large as the full bundle is skipped.
- The Expo downloader negotiates `A-IM: bsdiff`; Yaota returns `226` when a matching patch exists. Without one, it serves the full bundle.
- Newly installed binaries need their embedded bundle registered as a base for a first-update delta. This change does not register APK/IPA embedded bundles; subsequent OTA-to-OTA updates can use the historical bases.
- Re-running publication still creates a new release identity. This change does not implement release deduplication or commit-order protection.

## Evidence

- [Yaota publisher: missing blobs, patch verification, staged activation](https://github.com/markbang/yaota/blob/62e237e864b291c6ee266a6af820569817ab984c/scripts/publisher.ts)
- [Yaota CLI options](https://github.com/markbang/yaota/blob/62e237e864b291c6ee266a6af820569817ab984c/scripts/publish.ts)
- [Server multipart upload and delta negotiation](https://github.com/markbang/yaota/blob/62e237e864b291c6ee266a6af820569817ab984c/src/ota.ts)
- Installed Expo native implementations inspected: `node_modules/expo-updates/android/src/main/java/expo/modules/updates/loader/FileDownloader.kt` and `node_modules/expo-updates/ios/EXUpdates/AppLoader/FileDownloader.swift`.

## Verification

Workflow assertions cover both publishers, pinned revision, Node version, independent fingerprint generation, runtime, source commit, delta base count, and error propagation. Yaota's existing tests cover generated patch reconstruction, missing-blob reuse, staging, scope isolation, and SDK 57 delta negotiation.

Device acceptance remains required: install compatible update A, publish changed update B, confirm a `226` launch-bundle response and successful launch of B on Android and iOS. Test an unmatched base (full bundle), a fingerprint mismatch (no incompatible release), and interrupted downloads. Local protocol tests do not establish device transfer sizes or native patch application.
