# Contributing

## Local checks

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

PR titles and commits use Conventional Commits:

```text
feat(chat): add turn retry
fix(auth): restore expired sessions
ci: tighten release validation
```

`feat` creates a minor release, `fix` creates a patch release, and `!` or a `BREAKING CHANGE:` footer creates a major release.

## Pull requests

Keep changes focused. CI must pass Quality and the bundle jobs on the pull request. Native debug builds are a manual `Native CI` workflow, not a PR check. Do not commit `.env`, native signing files, generated `ios/` or `android/` directories, or Expo credentials.

## Releases

See [docs/releasing.md](docs/releasing.md). Merging the Release Please PR creates the GitHub Release and changelog. It does not build APKs. JS-only changes publish as production OTA when they land on `main`. Run Native Release when Expo SDK, native dependencies, or native configuration change. iOS builds and store submissions remain manual.
