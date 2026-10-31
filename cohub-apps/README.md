# Cohub Apps

First-party Apps and runnable examples of Cohub App patterns. The deep
reference for everything used here is
[App development](https://cohub.live/docs/developers/apps).

First-party Apps are flat, independently built projects in the root pnpm workspace:

- [`task-inspector`](./task-inspector/): task details, progress and outputs.
- [`checkpoint-explorer`](./checkpoint-explorer/): snapshot diffs and read-only files.
- [`schedule-manager`](./schedule-manager/): scheduled prompts and run history.
- [`app-manager`](./app-manager/): App settings, publishing and versions.
- [`score-editor`](./score-editor/): open a score file or a generation, edit it, save it, and hand it to the agent.
- [`shared`](./shared/): shared authorization, caching, drafts, theme and build defaults; not a published App.

The examples below remain independently installable.

| App | Scenario | Demonstrates |
| --- | --- | --- |
| [`app-capability-lab`](./app-capability-lab/) | Try every capability | Context, shell events, surface, viewer auth, prompts, account data, App Actions, commerce loop, embeds |
| [`whale-shrine`](./whale-shrine/) | Owner-funded generation with commerce | Credits (`consumeCredits` → `purchase`), App Action write, checkout return, file reads |
| [`task-browser`](./task-browser/) | Cross-Space viewer data | `pick-space` consent, `taskrun.view` / `user.taskrun.list`, generation outputs, caching + pagination |
| [`marketplace`](./marketplace/) | Install Apps into a Space | `.cohub/apps.json`, `file.view` / `file.edit`, catalog builds |
| [`desktop-surfaces/milk-frog`](./desktop-surfaces/) | Overlay companion | Overlay geometry + `inputRegion`, composer chip, `--call` surface methods, realtime presence, read-only completion |
| [`ember`](./ember/) | A night camp on a live Board | Board stage + scripts as a multiplayer scene, `scriptCapabilities`, room events folded into a Board document, snapshots, proximity voice, a spirit Action that edits the Board |

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
- **A shared, living Board** — `ember` for a Board many people edit together,
  scripted characters and effects, and an Agent that edits the Board with them.

## Notes

- All samples publish with the smallest scope set that works — check each
  README's publish command before reusing it.
- Runtime APIs only work inside a **published** App; previews render with
  reduced functionality by design.
- [NETA World](https://cohub.live/tzwm/cohub-example-apps/w/neta-world) and
  [Campfire](https://cohub.live/tzwm/cohub-example-apps/w/campfire) are published
  from the [Cohub Example Apps](https://cohub.live/tzwm/cohub-example-apps) space;
  their source lives there, not in this repository.
