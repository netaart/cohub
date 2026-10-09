# Contributing

## Local checks

The app lives in `apps/mobile` of the Cohub monorepo but is a standalone npm project outside the pnpm workspace. Run these from `apps/mobile`:

```bash
npm ci
npm run check
npm run export:android
npm run export:ios
npm run native:android
npm run native:ios
```

`npm run doctor` first runs `expo install --check` offline against the installed Expo SDK's bundled dependency map, then runs the remaining Expo Doctor checks. An incompatible installed dependency still fails; a new upstream patch recommendation alone does not block CI or OTA. Weekly Dependabot PRs handle dependency updates. Use `npm run doctor:upstream` to check current upstream recommendations when planning a native upgrade. This does not disable Doctor's other network-backed checks.

Native dependency upgrades require a new APK/TestFlight baseline before shipping compatible OTA updates. Do not skip fingerprint validation to serve an upgrade to older binaries.

PR titles and commits use Conventional Commits. Scope app commits by area, or `mobile` when there is none:

```text
feat(chat): add turn retry
fix(auth): restore expired sessions
ci(mobile): tighten release validation
```

The commit type picks the release-notes section; `chore` commits stay out of the notes. The version is chosen when cutting a release, not derived from commits.

## Pull requests

Keep changes focused. `Mobile CI` must pass Quality and the bundle jobs on pull requests that touch `apps/mobile`. Native debug builds are a manual `Mobile CI` run with `task=native-debug`, not a PR check. Do not commit `.env`, native signing files, generated `ios/` or `android/` directories, or Expo credentials.

## Releases

See [docs/releasing.md](docs/releasing.md). JS-only changes publish as production OTA when they land on `main`. A native release bumps the version, then pushes a `cohub-mobile-vX.Y.Z` tag, which builds the signed APKs and the TestFlight build and creates the GitHub Release.
