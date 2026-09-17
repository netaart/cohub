# Task Browser

A reference [Cohub App](https://cohub.live) for browsing multimodal generation tasks. It is a standalone Svelte application built entirely with public npm packages, so the directory can be copied out of this repository and developed independently.

## What It Demonstrates

- Loading App identity and invocation context with `cohub.context()`
- Per-space viewer grants with `cohub.auth.authorize({ target: { kind: "space", spaceId }, scopes })`
- Account-level task listing via the `user.taskrun.list` viewer scope
- Opening another Space through `cohub.auth.authorize({ target: { kind: "pick-space" } })` and switching into its task view
- Listing generation Tasks with the public Cohub SDK
- Resolving scope from invocation context in `Session > Space > Mine` order
- Rendering every image, video, audio, and text output as an independent item
- Per-query local caching with stale-while-revalidate tab switching
- Cursor pagination, active Task refresh, deferred media loading, and responsive layout

The invocation Space can differ from the Space that publishes this App. The app never falls back to the publishing Space when invocation context is absent.

## Permissions

This app uses both grant sources of the Cohub permission model:

- **App scope** — `taskrun.view` is granted directly at publish time and always covers the publishing Space.
- **Viewer grants** — requested from a user gesture when access is denied. Browsing a Space or Session asks for `taskrun.view` on that Space; the `Mine` scope asks for `user.taskrun.list` to list every task the viewer owns. The toolbar can open a Space picker and request `taskrun.view` for the selected Space. Account-level clients and the CLI can review or revoke grants:

```bash
cohub apps grants task-browser
cohub apps revoke task-browser <grantId>
```

Viewer authorization never grants more access than the viewer already has, and a revocation takes effect immediately.

## Requirements

- Node.js 22 or newer
- A Cohub account
- The Cohub CLI: `npm install --global @neta-art/cohub-cli`

## Develop

```bash
cd cohub-apps/task-browser
npm install
npm run dev
```

The Cohub runtime APIs only work inside a published App. Local development is useful for layout and unit tests; use a published preview to test context, authorization, and API calls.

Run the complete local verification suite:

```bash
npm run check
```

## Publish

Build the project:

```bash
npm run build
```

App targets are Space workspace paths. If this project is the Space root, publish with:

```bash
cohub apps publish task-browser \
  --dir dist \
  --app-scope taskrun.view \
  --hide-cohub-bar
```

If the project is nested in a larger Space, pass its Space workspace path. From the root of this repository, for example:

```bash
cohub apps publish task-browser \
  --dir cohub-apps/task-browser/dist \
  --app-scope taskrun.view \
  --hide-cohub-bar
```

The `taskrun.view` app scope lets the app read Tasks in the publishing Space. Tasks in any other Space come from a viewer grant on that Space — no viewer scopes are configured at publish time.

Running the same publish command updates the existing App with a new immutable version.

## Preview

Open a published App by ID, public URL, or `username/space/app` reference:

```bash
cohub desktop open <app-id>
cohub desktop open https://cohub.live/tzwm/cohub/w/task-browser
cohub desktop open tzwm/cohub/task-browser
```

When an Agent opens the App with `cohub desktop open`, the SDK exposes the originating identifiers through:

```ts
const context = await cohub.context();
const { spaceId, sessionId } = context?.invocation ?? {};
```

These identifiers choose the initial browser scope. They do not bypass Cohub authorization.

## Project Structure

```text
src/App.svelte          UI, loading, pagination, and refresh behavior
src/scope.ts            Session > Space > Mine scope resolution
src/access.ts           Per-scope viewer authorization requests
src/task-output.ts      Task Run to multimodal gallery projection
src/media.ts            Deferred media detail resolution
work.json               Publish metadata and app scopes
```

## License

Apache-2.0
