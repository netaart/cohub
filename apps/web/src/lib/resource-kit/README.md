# Resource kit

Task, Checkpoint, Schedule and App helpers and views shared by Web and the
first-party resource Apps in `cohub-apps/`, which import this directory through
their `$kit` alias.

- Import only relative files (messages from `../paraglide/messages.js`) and
  packages; `#lib`, `$app` and `$env` are lint errors here because the Apps
  have no SvelteKit runtime.
- Take `locale` explicitly instead of reading the Web locale store.
- Style with the Web semantic Tailwind classes; the Apps map them to host
  appearance tokens.
- Take host services (SDK APIs, caches, realtime subscriptions, confirmations)
  as props, so each host wires its own: Web uses IndexedDB and window events,
  the Apps session storage, Space subscriptions and their feedback dialogs.
