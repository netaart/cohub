# Releasing Cohub Mobile

## Overview

The repository has three automated layers:

1. `CI` validates every PR and push to `main`, then exports Web, Android, and iOS bundles.
2. `Release Please` maintains a version/changelog PR from Conventional Commits.
3. Merging that release PR creates `vX.Y.Z` and a GitHub Release, then calls `EAS Build` for production iOS and Android builds with auto-submit.

## One-time repository setup

Create an Expo project whose Android package and iOS bundle identifier are both associated with this repository. Add these GitHub settings:

| Kind | Name | Value |
| --- | --- | --- |
| Actions secret | `EXPO_TOKEN` | Expo access token for the build account |
| Actions variable | `EXPO_OWNER` | Expo account or organization owner |
| Actions variable | `EXPO_PROJECT_ID` | EAS project UUID |
| Optional Actions secret | `RELEASE_PLEASE_TOKEN` | Fine-grained PAT with Contents and Pull requests write access |

`RELEASE_PLEASE_TOKEN` is optional because the workflow directly invokes EAS after a release. Add it when Release Please-created PRs and releases should trigger other event-based workflows using a non-default token.

Store credentials are managed by EAS, not GitHub:

- Apple App Store Connect credentials and signing assets
- Google Play service account and Android signing key

Register `cohub://callback` in the Native Logto application and set its public app ID through the EAS environment when it differs from the checked-in default.

## Normal release

1. Merge Conventional Commit PRs into `main`.
2. Wait for the Release Please PR to update.
3. Review its `CHANGELOG.md`, `package.json`, `package-lock.json`, and `app.json` changes.
4. Merge the Release Please PR.
5. Verify the GitHub Release and the `EAS Build` workflow summary.
6. Monitor store processing in App Store Connect and Google Play Console.

The release workflow validates that the tag is exactly `v<package version>` and that `package.json` and `app.json` have identical versions.

## Manual builds

Open Actions → `EAS Build` → Run workflow. Choose:

- `preview` for internal distribution
- `production` for store artifacts
- one platform or `all`
- `submit=true` only when the resulting build should be sent to the store

Equivalent local commands:

```bash
npm run eas:preview
npm run eas:production
```

## Recovery

If EAS configuration or credentials fail after the GitHub Release exists, fix the secret/variable or EAS credential, then manually run `EAS Build` with:

- ref: the existing `vX.Y.Z` tag
- profile: `production`
- platform: `all`
- submit: enabled
- release tag: the same `vX.Y.Z`

Do not create a second tag for the same source version.
