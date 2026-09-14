# OTA Assessment

Research date: 2026-09-14. This is an assessment, not an implementation plan approved for deployment.

## Scope and Evidence

Reviewed the mobile checkout, installed `expo-updates` 57.0.22 source/types, Expo's SDK 57 documentation, and the Cloudflare service at the mobile workflow's pinned revision `fab754606dfe747abee8faef24d84981789f8064`. The service's default branch is `master`. Production deployment revision, network transfer sizes, and native device behavior were not verified.

Primary sources:

- [Expo Updates SDK reference](https://docs.expo.dev/versions/v57.0.0/sdk/updates/)
- [EAS Update introduction](https://docs.expo.dev/eas-update/introduction/)
- [Expo Updates v1 protocol](https://docs.expo.dev/technical-specs/expo-updates-1/)
- [Pinned Worker manifest handler](https://github.com/markbang/cloudflare-expo-ota-updates/blob/fab754606dfe747abee8faef24d84981789f8064/apps/worker/src/routes/manifest.ts)
- [Pinned Worker upload handler](https://github.com/markbang/cloudflare-expo-ota-updates/blob/fab754606dfe747abee8faef24d84981789f8064/apps/worker/src/routes/upload.ts)
- [Pinned R2 storage implementation](https://github.com/markbang/cloudflare-expo-ota-updates/blob/fab754606dfe747abee8faef24d84981789f8064/apps/worker/src/utils/storage.ts)
- [Pinned CLI upload implementation](https://github.com/markbang/cloudflare-expo-ota-updates/blob/fab754606dfe747abee8faef24d84981789f8064/apps/easc/src/utils/upload.ts)
- [Pinned Worker routes](https://github.com/markbang/cloudflare-expo-ota-updates/blob/fab754606dfe747abee8faef24d84981789f8064/apps/worker/src/index.ts)
- [Service deployment and recovery notes](https://github.com/markbang/cloudflare-expo-ota-updates/blob/fab754606dfe747abee8faef24d84981789f8064/docs/COHUB.md)

## Current Capabilities

- [app.config.ts](../app.config.ts) enables OTA only with a build-time HTTPS endpoint. It uses `ON_LOAD`, zero startup wait, native fingerprints, production request headers, and a pinned signing certificate. Cached/embedded code starts immediately while the startup procedure checks/downloads updates. Downloaded updates normally apply on a subsequent cold launch.
- [.github/workflows/publish-ota.yml](../.github/workflows/publish-ota.yml) runs `npm run check` before platform exports and publication. It pins the fork CLI and publishes against installed native runtimes. Native compatibility and signing safeguards should remain intact.
- [AppUpdateBanner.tsx](../src/components/AppUpdateBanner.tsx) exposes Android APK updates, not OTA status. Its About update row is hidden on iOS. [app/debug/updates.tsx](../app/debug/updates.tsx) exposes manual OTA check/download/reload; there is no production OTA `useUpdates()` observer or foreground check in the inspected app code.
- The SDK's `useUpdates()`, download progress, check/download errors, and `reloadAsync({ reloadScreenOptions })` are client capabilities and do not require EAS hosting. EAS dashboards and managed rollout policies are separate service capabilities.

## Three Different Meanings of Incremental

1. **OTA instead of a native package:** already supported for compatible JS/assets. Native modules, permissions, and SDK changes still require a native build.
2. **Reuse unchanged asset files:** the Worker assigns content-derived asset keys. Installed Android `loader/Loader.kt` and iOS `AppLoader/AppLoader.swift` look up existing assets by key and reuse files present locally. A new per-release URL does not alone force a cached asset to download again. Missing files still need downloading.
3. **Binary differences within a changed JS/Hermes bundle:** SDK 57 supports bsdiff, enabled by default. Installed Android `loader/FileDownloader.kt` and iOS `AppLoader/FileDownloader.swift` implement patch negotiation/application; Android sends `A-IM: bsdiff` and handles patch response metadata including `expo-base-update-id`. The pinned service only uploads complete files and serves their R2 URLs. Its Worker has manifest/upload routes, without patch generation or negotiated patch delivery. Consequently, this service implementation does not provide bundle-level binary delta downloads merely because the client supports them.

The CLI uploads the bundle and all selected assets each publication, and the Worker stores them below a fresh update ID. Server-side upload/storage deduplication is therefore a separate optimization from client cache reuse. R2 objects already receive a long immutable cache policy. Actual CDN compression and wire sizes require measurement; no savings percentage is established here.

## Recommended Order

### First: Client Update Experience

- Keep cached startup and the existing native startup check. Observe `useUpdates()` centrally instead of adding another mount-time check/download loop.
- Show a quiet, dismissible ready notice only when `isUpdatePending` is true. Offer explicit restart and defer actions; do not automatically reload as soon as a download completes. Remember dismissal per downloaded update, with rollback directives treated as their own update type.
- Add a shared OTA status/check entry for Android and iOS in About. Distinguish native package version from the active OTA ID/date. Keep APK installation a separate status/action.
- Add a background-to-active check with a cooldown, for example 30 minutes as an initial product choice, and no frequent polling. Skip while the startup procedure, another check, a download, or a restart is running. Background failures stay unobtrusive; explicit checks report actionable errors.
- Before offering restart inside work flows, protect unsaved state. [app/chat/[sessionId].tsx](../app/chat/[sessionId].tsx) stores composer text and attachment drafts in React state. Reload discards that state and reconnects the JS runtime. Defer restart during recording, uploads, sends, and active conversation interaction; preserve user-scoped drafts and relevant navigation/scroll state if restarting from those screens is supported.
- Use the installed SDK's reload screen options with existing theme colors and a bundled image/spinner. The reload screen is a transition surface, not the consent prompt. Complete persistence before `reloadAsync`; the SDK explicitly warns against relying on JS execution afterward.
- Use the SDK result unions directly. The debug screen currently narrows fetch results to `isNew` and will not immediately reload for `isRollBackToEmbedded`. Its unconditional impending-restart text can also be misleading when nothing new was fetched.

### Next: Operational Visibility and Recovery

- Surface SDK check/download errors, pending update identity, last check, emergency-launch reason, and recent update logs in the existing diagnostics flow. Redact any sensitive values before sharing logs.
- The Worker's `download_count` increments when it serves a manifest, including manual checks. It is not evidence of a completed download, successful launch, or a unique installation. Label it accordingly; collect minimal update-specific success/failure events only if adoption metrics are needed.
- Keep a tested recovery procedure: republish a known-good artifact for the same native runtime with a new update ID/time. Deleting a bad release does not remove it from devices. The pinned handler does not implement `rollBackToEmbedded`; client support alone cannot supply that server capability.

### Later: Transfer and Storage Optimization

- Measure bundle/asset sizes, actual compressed transfer sizes, download duration, and failure rates for several ordinary releases first.
- Consider content-addressed R2 storage and an upload-existence handshake to avoid uploading/storing duplicate assets. This belongs in the server/CLI repository and requires retention/reference handling for shared objects.
- Evaluate bsdiff only against measured costs and latency. It requires base/target artifact retention, patch generation, negotiated asset responses, cache separation by base/target, and integrity verification. Use the installed SDK's existing patch implementation; do not build a second native updater.
- Staging publication exists, but the app's configured channel remains production. Testing staging needs a deliberately configured test client or controlled header override. Percentage rollouts and adoption dashboards are not automatically provided by the pinned Worker.

## Verification Before Shipping

Use OTA-enabled Android release and iOS release/TestFlight builds, not Expo Go or a browser. Exercise pending/restart/defer, unchanged resources, offline startup, interrupted downloads, repeated foreground transitions, unsaved drafts, recording/sending, both themes, runtime mismatch, invalid signatures, and republishing a known-good update. If patch delivery is added, also verify multiple base versions, patch integrity failures, and the SDK's existing full-download recovery behavior.
