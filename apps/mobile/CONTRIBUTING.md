# Contributing

## Local checks

```bash
npm ci
npm run check
npm run export:web
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

Keep changes focused. CI must pass Quality, all three Bundle jobs, and the relevant Native CI job. Do not commit `.env`, native signing files, generated `ios/` or `android/` directories, or Expo credentials.

## Releases

See [docs/releasing.md](docs/releasing.md). Merging the Release Please PR is the release approval action; it creates the tag and GitHub Release. Production iOS and Android builds are queued automatically only when `NATIVE_AUTO_RELEASE_ENABLED=true`, and store submission additionally requires `NATIVE_AUTO_SUBMIT_ENABLED=true`.
