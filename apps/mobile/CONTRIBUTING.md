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

PR titles and commits use Conventional Commits:

```text
feat(chat): add turn retry
fix(auth): restore expired sessions
ci: tighten release validation
```

`feat` creates a minor release, `fix` creates a patch release, and `!` or a `BREAKING CHANGE:` footer creates a major release.

## Pull requests

Keep changes focused. CI must pass Quality, all three Bundle jobs, and Native CI on the pull request. Native CI does not rerun on the subsequent `main` push. Do not commit `.env`, native signing files, generated `ios/` or `android/` directories, or Expo credentials.

## Releases

See [docs/releasing.md](docs/releasing.md). Merging the Release Please PR creates the GitHub Release and changelog. It does not build APKs. JS-only changes publish as production OTA when they land on `main`. Run Native Release when Expo SDK, native dependencies, or native configuration change. iOS builds and store submissions remain manual.
