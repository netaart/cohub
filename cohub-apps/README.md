# Sample Apps

Runnable examples of Cohub App patterns. Each one is small enough to read in
one sitting and demonstrates a deliberate set of capabilities. The deep
reference for everything used here is
[App development](https://cohub.live/docs/developers/apps).

| App | Scenario | Demonstrates |
| --- | --- | --- |
| [`app-capability-lab`](./app-capability-lab/) | Try every capability | Context, shell events, surface, viewer auth, prompts, account data, App Actions, commerce loop, embeds |
| [`whale-shrine`](./whale-shrine/) | Owner-funded generation with commerce | Credits (`consumeCredits` → `purchase`), App Action write, checkout return, file reads |
| [`task-browser`](./task-browser/) | Cross-Space viewer data | `pick-space` consent, `taskrun.view` / `user.taskrun.list`, generation outputs, caching + pagination |
| [`marketplace`](./marketplace/) | Install Apps into a Space | `.cohub/apps.json`, `file.view` / `file.edit`, catalog builds |
| [`desktop-surfaces/milk-frog`](./desktop-surfaces/) | Overlay companion | Overlay geometry + `inputRegion`, composer chip, `--call` surface methods, realtime presence, read-only completion |

## Pick by decision

New to App development? Answer the three questions first — need Cohub
capabilities at all, who pays for AI, where data lives — then start from the
closest sample:

- **Just present something** — any static page; publish with empty scopes.
- **Viewer-funded AI** — browser-side prompts / completion / generation with
  `auth.authorize` from a gesture (`app-capability-lab`).
- **Owner-funded generation + monetization** — `whale-shrine` is the canonical
  example: credits fund an App Action that writes to your home Space.
- **Viewer's own data** — `task-browser` for consent-driven cross-Space reads.
- **Live workspace companion** — `milk-frog` for overlay surfaces.

## Notes

- All samples publish with the smallest scope set that works — check each
  README's publish command before reusing it.
- Runtime APIs only work inside a **published** App; previews render with
  reduced functionality by design.
