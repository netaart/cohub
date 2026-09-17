# Cohub App Runtime Guide

This guide explains the Cohub SDK in a published App iframe or an explicitly
configured standalone broker. New Apps should use `auth.authorize()`; see the
[authorization contract](../../../docs/app-authorization.md). Legacy APIs below
retain their original return types. Read this before building any
App that calls Cohub capabilities from browser-side JavaScript.

It is written to be self-contained: an agent or developer who reads only this
file plus the SDK type definitions should be able to build a working App
without reverse-engineering source code.

> **Vocabulary note.** Apps were previously called *Works*. The SDK speaks the
> canonical App vocabulary (`client.apps`, `appScopes`); the legacy
> `client.works` / `workScopes` spellings remain as deprecated aliases, and
> existing `/w/` public URLs keep working.

---

## Table of contents

1. [Mental model](#1-mental-model)
2. [Two deployment modes: bridge vs broker](#2-two-deployment-modes-bridge-vs-broker)
3. [The permission model — read this twice](#3-the-permission-model--read-this-twice)
4. [Initialization recipe](#4-initialization-recipe)
5. [Capability reference](#5-capability-reference)
   - [LLM chat](#llm-chat-spaceprompt--subscribegeneration)
   - [Image / media generation](#image--media-generation-generationscreateandwait)
   - [Model listing](#model-listing-modelslist--modelslistmultimodal)
   - [File reads](#file-reads-spacefiles)
   - [Account-level data](#account-level-data-spaceslist--userlistsessions--usergetactivity)
   - [Commerce](#commerce-appcommerce)
   - [Realtime rooms](#realtime-rooms-apprealtime)
6. [Complete working example](#6-complete-working-example)
7. [Common pitfalls checklist](#7-common-pitfalls-checklist)
8. [Publishing an App (API/SDK)](#8-publishing-an-app-apisdk)

---

## 1. Mental model

An **App** is a published, shareable web page hosted by Cohub. When a viewer
opens an App, Cohub serves its HTML/JS inside a **runtime** that bridges the
App's code to Cohub's backend.

From the App's JavaScript, you create a Cohub client and call APIs the same
way you would from any other client — **but** the client is pre-wired to obtain
short-lived access tokens from the Cohub shell (the runtime host) instead of
requiring the viewer to paste an API key.

```
┌─────────────────────────────────────────┐
│  Cohub shell (host page / iframe parent) │
│                                         │
│  ┌───────────────────────────────────┐  │
│  │  Your App (iframe or standalone)  │  │
│  │                                   │  │
│  │  createCohubClient() ──► token ──►│──┼──► Cohub API
│  │  client.context()    ◄── identity │  │
│  │  client.auth.authorize() ► consent│  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

These runtime-only APIs form the foundation; everything else is standard SDK:

| API | What it does | Returns |
|---|---|---|
| `client.context()` | Asks the host for the App's identity | `{ app, space, viewer?, invocation?, shell?, permissions, capabilities?, mode? }` or `null` |
| `client.auth.authorize({ target, scopes, reason?, alwaysAsk?, fallback? })` | Requests consent for an account, a Space, or a viewer-picked Space; silent when a grant already covers the scopes | `{ status: "granted", requestedTarget, target, resolution, grant }` \| `{ status: "cancelled" }` \| `{ status: "denied", code }` |
| `client.auth.request()` / `requestSpace()` / `requestCreateSpace()` | Legacy entry points, kept for older Apps | original shapes (`boolean`, `{ granted, space }`) |
| `client.context().permissions.viewerGrants` | Render the viewer's current per-space grants | `{ spaceId, scopes }[]` |
| `client.app.commerce.*` / `client.app.realtime.*` | Commerce and realtime, bound to the app's runtime identity | (see below) |

> **Runtime requirement.** Use a published App iframe or explicitly configure
> a broker. A standalone page without broker configuration has no runtime.
> Initialize `context()` before using APIs to discover Host capabilities.

`client.app.onContextChanged(listener)` pushes a fresh context whenever the
host's state changes (sign-in, invocation, grants), so an App can render its
permission state without polling.

---

## 2. Two deployment modes: bridge vs broker

The SDK auto-detects which mode you are in based on whether the page is inside
an iframe. You normally do **not** need to set the mode explicitly.

### Bridge mode (default, primary)

The App runs inside a Cohub-hosted iframe (`window.parent !== window`). The
SDK communicates with the parent window via `postMessage` to request tokens
and context. This is the normal case when a viewer opens an App through Cohub.

- `client.context()` returns the **real** `app.id`, `space.id`, current viewer,
  invocation, and permission state from the host.
- An App opened through `cohub desktop open` also receives an `invocation`
  snapshot with the originating `spaceId`, `sessionId`, `turnId`, and
  `toolCallId` when available. The invocation Space may differ from the App's
  own `space.id`.
- `client.auth.authorize()` triggers an in-shell consent flow (no popup window).

```js
const ctx = await client.context();
console.log(ctx.viewer?.userUuid ?? null);
console.log(ctx.invocation?.sessionId ?? null);
```

Invocation fields describe where the open came from. They are identifiers,
not authorization: API access remains controlled by the app session token and
its grants.

### Broker mode (standalone deployment)

The App is accessed as a standalone page (`window.parent === window`), e.g.
a direct static-asset URL not wrapped in the Cohub iframe. The SDK opens a
**popup window** to a Cohub auth-broker page to obtain tokens.

- `client.context()` is **answered locally** by the SDK: it reports
  `mode: "broker"`, `space.id` is an **empty string `""`**, and viewer grants
  are unavailable (empty). Broker tokens stay in memory and are never restored
  from or written to `localStorage`.
- `client.auth.authorize()` opens a popup to
  `${brokerOrigin}/app-auth?app=${appId}`.

> **Broker mode requires configuration.** You must pass `app: { brokerOrigin,
> appId }` — or `app: { brokerOrigin, ownerUsername, spaceSlug, appSlug }`
> when the appId isn't known yet — to `createCohubClient` for broker mode to
> activate. Without it, a standalone page gets `ParentBridgeTransport` which
> has no parent to talk to, so `context()` returns `null`. See
> [Initialization recipe](#4-initialization-recipe).

### Detecting the mode at runtime

```js
const ctx = await client.context();
const isBroker = ctx?.mode === "broker";
```

In broker mode you cannot get a spaceId from `context()`. Resolve it via the
public by-slug App API (anonymous, no token needed):

```js
const isBroker = ctx?.mode === "broker";
let spaceId;
if (isBroker) {
  const detail = await client.apps.getBySlug(ownerUsername, spaceSlug, appSlug);
  spaceId = detail.app.spaceId;
} else {
  spaceId = ctx.space.id;
}
```

### Broker mode: user-activation ordering gotcha

`HttpTransport` calls `getAccessToken()` on **every** request — including
public ones like `apps.getBySlug()`. In broker mode, a token exchange opens a
popup, which **consumes the browser's user-activation budget**. If a second
popup (the consent dialog) follows in the same click, the browser blocks it.

**Fix:** call `auth.authorize()` **before** any other API call that triggers
`getAccessToken()`. The token returned by that exchange is cached in memory for
the lifetime of the client, so later `getAccessToken()` calls reuse it without
a popup.

```js
// WRONG: getBySlug() opens a popup, consumes activation, consent popup blocked
const detail = await client.apps.getBySlug(owner, spaceSlug, appSlug);
await client.auth.authorize({ target: { kind: "pick-space" }, scopes });

// RIGHT: authorize() opens the only popup, then getBySlug() hits the token cache
await client.auth.authorize({ target: { kind: "pick-space" }, scopes });
const detail = await client.apps.getBySlug(owner, spaceSlug, appSlug);
```

Bridge mode is unaffected — `getAccessToken()` uses `postMessage` (no popup),
so ordering does not matter there.

---

## 3. The permission model — read this twice

> This is the **single most common source of bugs**. Every 403 you encounter
> in an App will almost certainly trace back to a missing grant of the wrong
> type. Read this section carefully.

An App's effective permission for one Space is the union of **two grant
sources** — either one is enough:

### App scopes (direct, no viewer consent)

Granted by the publisher **at publish time** via `appScopes`. The App always
has them — no viewer action needed. They are deliberately bounded to eight
read-and-act scopes and apply **only to the App's own Space**:

```
space.view               — read space config, list models
session.view             — read sessions, turns, stream generation updates
file.view                — read files / file tree
file.edit                — write files
taskrun.view             — read task run details (used by generation polling!)
session.prompt.readonly  — send read-only prompts (no side effects)
session.prompt.fullaccess— send prompts with full access (write, create sessions)
command.execute          — run sandbox shell commands
```

### Viewer grants (consent-required, any permission, per Space)

A viewer grants these through a consent dialog triggered by
`client.auth.authorize()`. A viewer may grant
**any** permission they currently hold on the target Space — including scopes
outside the eight app scopes, such as `generation.create` or the account-level
`user.*` scopes. Two hard rules are enforced by the server:

- At **grant time** the viewer must currently hold every requested permission
  on the target Space.
- At **use time** the grant only works while the viewer still holds that
  permission there — losing a membership or a role downgrade takes effect
  immediately.

Viewer grants are **per Space**: one viewer can hold a different grant for the
App's own Space and for each Space they picked. Grants last **14 days**; the
session token lives **1 hour** and is refreshed silently. Revoking a grant
takes effect immediately — silently or via the API.

> `allowedViewerScopes` is deprecated and no longer enforced: viewer grants
> are not gated by the app configuration. The field stays on the wire for
> compatibility; do not use it in new apps.

### The golden rule

> **Reads on the App's own Space need app scopes. Everything else — actions,
> other Spaces, account-level data — needs a viewer grant.**

`session.prompt.fullaccess` lets you **send** a prompt, but reading the reply
still needs `session.view`. `generation.create` (a viewer grant) lets you
**create** a generation task, but polling its result needs `taskrun.view` —
either from the App's `appScopes`, or from a viewer grant checked against the
requested Space.

### Requesting viewer grants

Consent must be requested **from a user gesture** (a button click). It is
silent when an existing grant already covers the scopes — the dialog only
opens when something new is needed:

```js
// 1. Target a known Space. The result names the Space that was actually
//    granted, which may differ from the request when the viewer cannot use it.
const result = await client.auth.authorize({
  target: { kind: "space", spaceId: invocationSpaceId },
  scopes: ["taskrun.view"],
  reason: "This app reads generation tasks in the Space you opened it from.",
});
if (result.status === "granted" && result.target.kind === "space") {
  const space = client.space(result.target.spaceId);
}

// 2. One consent: the viewer picks the Space. The host loads the space list —
//    the app only learns the Space the viewer chose.
const picked = await client.auth.authorize({
  target: { kind: "pick-space" },
  scopes: ["file.view", "session.view"],
  reason: "This app reads the Space you pick.",
});
if (picked.status === "granted" && picked.target.kind === "space") {
  const space = client.space(picked.target.spaceId);
}

// 3. Account-level data needs an account target, not a Space.
const account = await client.auth.authorize({
  target: { kind: "account" },
  scopes: ["user.space.list"],
});

// 4. Strict target: never resolve to another Space.
const strict = await client.auth.authorize({
  target: { kind: "space", spaceId: projectSpaceId },
  scopes: ["file.edit"],
  fallback: "none",
});
```

The result tells the App exactly what happened:

| Field | Meaning |
|---|---|
| `status` | `granted`, `cancelled`, or `denied` |
| `requestedTarget` | What the App asked for |
| `target` | What was actually granted (`account`, or a Space with `spaceId`/`name`) |
| `resolution` | `requested`, `selected`, or `fallback` |
| `grant` | `{ id, spaceId, scopes, expiresAt }` from the server |

Rules worth internalizing:

- **Act on `target`, never on the request.** API calls are never redirected to
  another Space on your behalf; if you asked for Space A and got B, use B.
- **Unavailable Spaces fall back by default.** The dialog shows the
  viewer-controlled Space that will be used. Pass `fallback: "none"` when the
  operation only makes sense in the Space you named.
- **Cancellation is not an error.** `{ status: "cancelled" }` means the viewer
  closed the dialog; keep their input and offer the action again.
- **Incremental growth.** New consent keeps scopes from a still-valid grant and
  adds the new ones; it never revives an expired or revoked scope.
- Pass `alwaysAsk: true` to skip silent reuse — for re-confirming a grant or
  letting the viewer switch to another Space.

Creating a viewer-owned Space stays on `client.auth.requestCreateSpace({ space, scopes })`
(never silent, each confirm mints a new Space). `{ granted: false }` **may still
carry a `space`**: the Space was created but bootstrap or authorization did not
finish. Keep the id, resume against it, and never create a second Space or
delete it automatically. An App can also create a viewer-owned Space directly
with `client.spaces.create()` once it holds a `space.create` viewer grant.

### Checking grant state at runtime

`client.context().permissions` reports everything an App needs to render its
state — **without** triggering a dialog:

```js
const ctx = await client.context();
ctx.permissions.appScopes    // publisher scopes granted at publish time
ctx.permissions.viewerGrants // per-space viewer consents: [{ spaceId, scopes }]
ctx.permissions.scopes       // union of both (flat; for quick checks)
ctx.permissions.viewerScopes // flat viewer scopes (legacy compatibility)
```

Apps never cache or manage grants themselves — the host does. Checking state
is for **rendering**; acting is `auth.authorize()`'s job.

### Managing grants

The App runtime can render the viewer's current grants from
`client.context().permissions.viewerGrants`. It must not call
`client.apps.listMyGrants()` or `revokeMyGrant()` with its App session token:
the server rejects App sessions from managing their own authorization.

Use an account-authenticated SDK client or the CLI to list and revoke grants:

```bash
cohub apps grants <app>            # list your grants for an app
cohub apps revoke <app> <grantId>  # revoke one
```

Those account-level APIs return grant rows with
`{ id, spaceId, scopes, expiresAt, revokedAt }`. Revocation is durable: silent
re-authorization can never revive a revoked grant — only a fresh consent
dialog can.

### Complete API → scope mapping

| Operation | SDK call | Scope needed | Source |
|---|---|---|---|
| Read space config | `space.get()` / `space.getConfig()` | `space.view` | app |
| List models | `client.models.list()` / `listMultimodal()` | *(none — just authenticated)* | — |
| Send a prompt (full) | `space.prompt({ accessMode: "full_access", ... })` | `session.prompt.fullaccess` | app or viewer |
| Send a prompt (read-only) | `space.prompt({ accessMode: "read_only", ... })` | `session.prompt.readonly` | app or viewer |
| Read turn result | `session.turns.get(turnId)` | `session.view` | app or viewer |
| Stream generation | `session.subscribeGeneration(...)` | `session.view` | app or viewer |
| Read file tree | `space.files.tree()` | `file.view` | app or viewer |
| Read file content | `space.files.read(path)` | `file.view` | app or viewer |
| Write files | `space.files.*` (write) | `file.edit` | app or viewer |
| Create generation task | `client.generations.create(request)` | `generation.create` | **viewer only** |
| **Poll generation result** | `client.generations.wait(taskRunId)` / `createAndWait()` | **`taskrun.view`** | app or viewer |
| Read task run detail | `client.tasks.get(taskRunId)` | `taskrun.view` | app or viewer |
| List tasks in a Space | `client.tasks.list({ spaceId })` | `taskrun.view` on that Space | app or viewer |
| List all owned task runs | `client.tasks.list()` | `user.taskrun.list` | **viewer only** |
| Create a Space for the viewer | `client.auth.requestCreateSpace({ space, scopes })` | requested scopes on the new Space | **viewer consent** |
| Request any consent | `client.auth.authorize({ target, scopes })` | the requested scopes on the resolved target | **viewer consent** |
| Create a viewer-owned Space directly | `client.spaces.create(input)` | `space.create` | **viewer only** |
| List viewer's spaces | `client.spaces.list()` | `user.space.list` | **viewer only** |
| List viewer's sessions | `client.user.listSessions()` | `user.session.list` | **viewer only** |
| Read viewer's activity | `client.user.getActivity()` | `user.usage.read` | **viewer only** |
| Run sandbox shell commands | `space.runCommand({ command })` | `command.execute` | app or viewer |
| Commerce: entitlements | `client.app.commerce.getEntitlements()` | *(runtime only, no scope)* | — |
| Commerce: consume credits | `client.app.commerce.consumeCredits()` | *(runtime only, no scope)* | — |
| Commerce: purchase | `client.app.commerce.purchase()` | *(runtime only, no scope)* | — |
| Realtime rooms | `client.app.realtime.createRoom()` / `joinRoom()` | *(runtime only, no scope)* | — |

"app or viewer" means either source suffices: the app scope covers only the
App's own Space; any other Space needs a viewer grant on that Space.

### Minimal scope sets for common App types

**LLM chat app** (send prompt + read reply on its own Space):
- `appScopes: ["space.view", "session.view", "session.prompt.fullaccess"]`

**Image generation app** (create + poll):
- `appScopes: ["space.view", "taskrun.view"]`
- viewer grant at runtime: `generation.create`

**File-reader app** (static, no viewer action):
- `appScopes: ["space.view", "file.view"]`

**Cross-space app** (acts on Spaces the viewer picks):
- `appScopes: []` (or its own-Space needs)
- viewer grants via `auth.authorize({ target: { kind: "pick-space" } })` at runtime

---

## 4. Initialization recipe

### No-build HTML (CDN import)

Apps are typically single HTML files with no bundler. Import the SDK from an
ESM CDN:

```js
import { createCohubClient } from "https://esm.sh/@neta-art/cohub@latest";
```

`@latest` keeps an App on the current SDK release. Pin an exact version only
when a deployment needs reproducible dependency updates.

### Environment detection — critical

The SDK defaults to **production**. An App running on a dev/staging host
(e.g. `dev.cohub.live`, a `/dev/` path prefix) **must** pass `env: "dev"`
explicitly — browsers do not inject `ENV` like Node does. If you omit this,
your App will call the production API while the runtime host expects dev,
causing silent auth failures.

```js
const isDevApp =
  location.pathname.startsWith("/dev/") ||
  location.hostname.includes("dev");

const client = createCohubClient({
  env: isDevApp ? "dev" : "prod",
});
```

### Broker mode configuration (standalone pages only)

If the App may be accessed as a standalone page (not inside the Cohub
iframe), pass the `app` option so the SDK can fall back to broker mode:

```js
const client = createCohubClient({
  env: isDevApp ? "dev" : "prod",
  app: {
    brokerOrigin: isDevApp ? "https://dev.cohub.live" : "https://cohub.live",
    appId: "<your-published-app-id>",
  },
});
```

When inside the Cohub iframe, the SDK auto-detects bridge mode and ignores
broker config. When standalone, it uses broker mode. **One codebase, both
deployments.**

#### Broker mode without a pre-known appId

The `appId` is only generated at publish time, so you often cannot hardcode
it while writing the App. In standalone deployments you can omit `appId` and
instead pass the App's public **slug triple**. The SDK resolves the appId at
runtime via the public `apps.getBySlug` API (anonymous, no auth required),
caches it, and starts broker mode with it.

All three values are known before publishing:

- `appSlug` — the slug you chose when creating the App.
- `ownerUsername` — the space owner's username (`cohub auth whoami`).
- `spaceSlug` — the space's slug (`cohub spaces get <spaceId>`).

```js
const client = createCohubClient({
  env: isDevApp ? "dev" : "prod",
  app: {
    brokerOrigin: isDevApp ? "https://dev.cohub.live" : "https://cohub.live",
    ownerUsername,
    spaceSlug,
    appSlug,
  },
});
```

Either `appId` or the full slug triple is enough to activate broker mode. If
you pass both, the explicit `appId` wins and no lookup is performed. Inside
the Cohub iframe both are ignored (bridge mode).

### Standard initialization sequence

```js
// 1. Create client (env is mandatory in the browser)
const client = createCohubClient({ env: isDevApp ? "dev" : "prod" });

// 2. Get runtime context (and keep it fresh)
const ctx = await client.context();
if (!ctx?.space?.id) {
  // Not in an app runtime (or broker mode — see §2)
  throw new Error("Not running inside a published app.");
}
const stopContextWatch = client.app.onContextChanged((next) => renderGrants(next));

// 3. Obtain the space client for API calls
const space = client.space(ctx.space.id);

// 4. Request viewer grants (from a user gesture, e.g. button click).
//    Use ctx.shell.space.id, ctx.invocation.spaceId, or a picker target.
const consent = await client.auth.authorize({
  target: { kind: "space", spaceId: ctx.shell?.space?.id ?? ctx.invocation?.spaceId },
  scopes: ["session.prompt.fullaccess", "generation.create"],
  reason: "This app sends prompts and generates images.",
});
if (consent.status !== "granted") throw new Error("Consent was not granted.");
const activeSpace = client.space(consent.target.kind === "space" ? consent.target.spaceId : ctx.space.id);

// 5. Call capabilities
const result = await activeSpace.prompt({ content: [{ type: "text", text: "Hello" }] });
```

> **`auth.authorize()` must be called from a user gesture** (click handler).
> Browsers block popups (broker mode) and some consent flows (bridge mode)
> when triggered programmatically without user activation. Do not call it on
> page load. It is safe to call repeatedly: covered scopes renew silently.

---

## 5. Capability reference

Each recipe below shows the exact code pattern and scope requirements.
Assume `client` and `space` are already initialized per [§4](#4-initialization-recipe).

### LLM chat (`space.prompt` + `subscribeGeneration`)

**Scopes:** `session.prompt.fullaccess` (to send) + `session.view` (to
read/stream). Either may come from `appScopes` (own Space) or a viewer grant.
For a read-only prompt (no side effects), use `session.prompt.readonly`
instead — but you **must** pass `accessMode: "read_only"` in the call (see the
read-only recipe below).

> **`accessMode` defaults to `full_access`.** If you omit it, the backend
> treats the call as full-access and requires `session.prompt.fullaccess`. This
> is the #1 cause of "I requested `session.prompt.readonly` but still got 403".
> Always set `accessMode` explicitly to match the scope you hold.

`space.prompt()` is **asynchronous** — it returns immediately with a turn
whose `assistantText` is `null`. You must either stream the reply via
`subscribeGeneration` or poll `turns.get()`.

```js
// Send a prompt (creates or continues a session) — full access
const result = await space.prompt({
  accessMode: "full_access", // default; needs session.prompt.fullaccess
  content: [{ type: "text", text: "Describe a shiba inu on Mars." }],
  sessionId: null,        // null → creates a new session; pass an id to continue
  model: "gpt-5.5",       // optional; omit for default
  intent: "followup",     // "followup" | "steer" | "compact"
});
const sessionId = result.session.id;
const turnId = result.turn.id;

// --- Option A: stream the reply (preferred) ---
// Requires session.view
const stop = space.session(sessionId).subscribeGeneration({
  state(event) {
    // Partial text as it streams in
    const text = (event.state?.contentBlocks ?? [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");
    console.log("streaming:", text);
  },
  finalized(event) {
    const turn = event.turn;
    const reply = turn.assistantText
      ?? (turn.assistantContent ?? []).filter(b => b.type === "text").map(b => b.text).join("");
    console.log("final:", reply);
  },
  error(event) {
    console.error("stream error:", event);
  },
});
// Call stop() to unsubscribe when done.

// --- Option B: poll for the reply (fallback) ---
// Also requires session.view
async function waitForTurn(sessionId, turnId) {
  while (true) {
    const { turn } = await space.session(sessionId).turns.get(turnId);
    if (turn.status === "completed") return turn;
    if (turn.status === "failed") throw new Error(turn.errorMessage || "failed");
    await new Promise(r => setTimeout(r, 1500));
  }
}
const turn = await waitForTurn(sessionId, turnId);
const reply = turn.assistantText;
```

**Turn status values:** `"pending" | "running" | "completed" | "failed"`.

**Turn reply fields:** `turn.assistantText` (string | null) and
`turn.assistantContent` (ContentBlock[] | null). Always check both —
`assistantText` is a convenience; `assistantContent` is the source of truth.

> **Do not silently swallow `subscribeGeneration` errors.** If `session.view`
> is missing, the WebSocket subscription fails. If you catch and ignore it,
> your code silently degrades to polling — which will also 403. Surface the
> error so you can diagnose the missing scope.

#### Read-only prompt (`accessMode: "read_only"`)

Use this when your App only needs to **generate** a reply without persisting
any side effects (no new session is written, no turn stored on the space's
history). It requires the lighter `session.prompt.readonly` scope.

The critical detail: you **must** pass `accessMode: "read_only"` explicitly
in the `space.prompt()` call. The scope you hold and the `accessMode` you
send must match — the backend picks the permission check based on
`accessMode`, defaulting to `full_access` when omitted.

```js
// 1. Ensure the read-only scope is granted (silent when already covered)
await client.auth.authorize({
  target: { kind: "space", spaceId: space.id },
  scopes: ["session.prompt.readonly"],
  reason: "Generate a one-off character reply (read-only).",
});

// 2. Send the prompt with accessMode matching the granted scope
const result = await space.prompt({
  accessMode: "read_only",   // ← required; omitting it → full_access → 403
  sessionId: null,           // read-only prompts use a throwaway session
  content: [{ type: "text", text: prompt }],
});
const sessionId = result.session.id;
const turnId = result.turn.id;

// 3. Read the reply — still needs session.view
const stop = space.session(sessionId).subscribeGeneration({
  finalized: (event) => {
    const reply = event.turn.assistantText
      ?? (event.turn.assistantContent ?? [])
          .filter(b => b.type === "text").map(b => b.text).join("");
    console.log("reply:", reply);
    stop();
  },
  error: (event) => console.error("stream error:", event),
});
```

> **Scope/accessMode mismatch → 403.** Holding `session.prompt.readonly` but
> calling `space.prompt({ content })` (no `accessMode`) fails because the
> backend defaults to `full_access` and checks `session.prompt.fullaccess`.
> Symmetrically, holding `session.prompt.fullaccess` while passing
> `accessMode: "read_only"` works only if `session.prompt.readonly` is
> additionally granted — otherwise 403. Always keep them in sync.

### Image / media generation (`generations.createAndWait`)

**Scopes:** viewer grant `generation.create` (to create) + `taskrun.view`
(to poll; from `appScopes` for the App's own Space, or a viewer grant on the
target Space).

`createAndWait` is a convenience that calls `create` then `wait` (polls
`GET /api/tasks/{id}`). **Both scopes are required** — missing `taskrun.view`
is the #1 cause of "generation creates but never returns" bugs.

```js
const result = await client.generations.createAndWait(
  {
    spaceId,
    model: "gpt-image-2",          // model id from models.listMultimodal()
    content: [{ type: "text", text: "A cat on the moon, cartoon style" }],
    parameters: {                   // optional, model-specific
      size: "1024x1024",
      // quality: "auto",           // gpt-image-2 supports quality
    },
  },
  {
    onPoll: (detail) => console.log("status:", detail.run.status),
    // intervalMs: 1500,            // optional poll interval
    // timeoutMs: 30 * 60 * 1000,   // optional timeout (default 30 min)
  },
);

// Extract the image URL from the output blocks
const image = (result.output ?? []).find(
  b => b.type === "image" && b.source?.url
);
const imageUrl = image?.source?.url;
```

**Output block types:** `text`, `image`, `video`, `audio`. Each media block has
a `source` of `{ type: "url", url }` or `{ type: "base64", mediaType, data }`.

**Two-step alternative** (if you need the `taskRunId` immediately):

```js
const created = await client.generations.create(request);
// created.taskRunId — generation task is queued
const result = await client.generations.wait(created.taskRunId, { onPoll });
```

### Model listing (`models.list` / `models.listMultimodal`)

**Scopes:** none — only requires a valid authenticated token (any token, no
specific scope). Returns 401 without a token, but never 403.

Call after initialization (after `context()` succeeds, so a token exists):

```js
// All models grouped by provider
const catalog = await client.models.list();
// catalog: { cohub: [...], openai: [...], ... }

// Generation-capable models only (for image/video/audio generation)
const { models } = await client.models.listMultimodal();
// models: [{ model, title, description, ... }, ...]
```

Use `listMultimodal()` to populate a model picker for generation. Each entry's
`model` field is the id you pass to `generations.createAndWait({ model })`.

### File reads (`space.files`)

**Scopes:** `file.view` (read) + `space.view` (often needed for the space context).

```js
// List the file tree
const tree = await space.files.tree();
// tree: nested file/directory entries

// Read a file (returns an HTTP Response — .text() / .blob() / .arrayBuffer())
const response = await space.files.read("path/to/file.txt");
const text = await response.text();

// Read multiple files at once
const files = await space.files.readMany(["a.txt", "b.json"]);
```

### Account-level data (`spaces.list` / `user.listSessions` / `user.getActivity`)

**Scopes:** viewer grants `user.space.list` / `user.session.list` /
`user.usage.read` — a publisher can never pre-grant these via `appScopes`.

These access the **viewer's** account-level data across all their spaces —
not the App's own space. Each requires a separate viewer grant.

```js
// List the viewer's spaces — needs user.space.list
await client.auth.authorize({
  target: { kind: "account" },
  scopes: ["user.space.list"],
  reason: "Show your space list.",
});
const spaces = await client.spaces.list();

// List sessions across all the viewer's spaces — needs user.session.list
await client.auth.authorize({
  target: { kind: "account" },
  scopes: ["user.session.list"],
  reason: "List your recent sessions.",
});
const { sessions } = await client.user.listSessions({ limit: 20 });

// Read activity — needs user.usage.read
await client.auth.authorize({
  target: { kind: "account" },
  scopes: ["user.usage.read"],
  reason: "Show your activity.",
});
const activity = await client.user.getActivity({ days: 30 }); // last 30 days
```

For task runs specifically, the account scope is `user.taskrun.list`: with an
explicit viewer grant, the unscoped `client.tasks.list()` returns every Task
Run **owned by** the viewer — including runs from Spaces they can no longer
access. Without it, the unscoped list stays space-scoped to live grants.

### Commerce (`app.commerce`)

**Scopes:** none — runs inside the App runtime, no scope needed. Only works
in a published App.

```js
// Check entitlements and credit balance in one call
const { entitlements, credits } = await client.app.commerce.getEntitlements();

// Feature unlock: purchase if not entitled
const unlocked = entitlements.some(e => e.benefitKey === "space_pro" && e.enabled);
if (!unlocked) {
  await client.app.commerce.purchase({ productKey: "pro_unlock" });
  // purchase() redirects to checkout; after return, re-check entitlements
}

// Credit consumption for a metered action
const result = await client.app.commerce.consumeCredits({
  amount: 10,
  operationId: crypto.randomUUID(),  // idempotency key
  reason: "Export high-res image",
});
if (result.status === "insufficient") {
  await client.app.commerce.purchase({ productKey: "credit_pack" });
}

// After checkout return, query the order
const checkoutState = await client.app.commerce.getCheckoutState();
if (checkoutState.orderId) {
  const { order } = await client.app.commerce.getOrder(checkoutState.orderId);
}
```

`purchase()` creates a purchase attempt ID automatically. If application code
retries the call after a timeout, pass the same `purchaseAttemptId` to ensure
the retry resolves to the original Billing order.

### Realtime rooms (`app.realtime`)

**Scopes:** none — uses the published App's runtime identity without an
additional consent dialog. The CLI and ordinary server auth cannot create or
join these rooms.

```js
const room = await client.app.realtime.createRoom({
  code: "TEAM-ALPHA", // optional; generated when omitted
  maxParticipants: 64,
  expiresInSeconds: 2 * 60 * 60,
});

const stopEvents = room.subscribe("shared.state.updated", (event) => {
  console.log(event.sequence, event.data, event.self);
});
console.log(room.members); // initial snapshot
const stopMembers = room.onMembersChanged((members) => {
  console.log(members);
});

await room.setPresence({ status: "active" });
await room.publish("shared.state.updated", { value: 42 });

stopEvents();
stopMembers();
await room.leave();
```

Join an existing room with
`client.app.realtime.joinRoom({ code: "TEAM-ALPHA" })`. Codes are scoped to
one App and are identifiers, not credentials; the runtime session and a
short-lived admission ticket provide authorization.

| Surface | Purpose |
|---|---|
| `createRoom()` / `joinRoom()` | Create or enter a code-scoped room |
| `subscribe()` / `subscribeAll()` | Receive typed or all business events |
| `publish()` | Send an acknowledged event; accepts an optional correlation-only `clientEventId` |
| `send()` / `onSendError()` | Send without an ACK for high-rate traffic; observe asynchronous failures |
| `members` / `onMembersChanged()` | Read the initial member snapshot and later membership or presence changes |
| `setPresence()` | Replace this participant's transient presence object |
| `state` / `onStateChange()` | Observe `connecting`, `joined`, `reconnecting`, `expired`, or `closed` |
| `onOutOfSync()` | Detect sequence jumps in the current live stream |
| `leave()` | Release membership and SDK listeners |

Room events are ordered while connected but are not replayed. A reconnect
refreshes the member snapshot and advances the sequence cursor, so use
`onStateChange()` to resync authoritative application state after reconnecting;
`onOutOfSync()` only reports gaps visible in the current live stream. Payloads
are transient and are not stored in the App.

| Limit | Value |
|---|---|
| Room code | Generated when omitted; custom codes are 3–48 uppercase letters, digits, `_`, or `-`, starting with a letter or digit |
| Lifetime | 2 hours by default; 60 seconds to 24 hours, absolute from creation |
| Participants | 16 by default; 2–128 |
| Active rooms | 512 per App |
| Event name | 1–64 ASCII letters, digits, `.`, `_`, `:`, or `-`, starting with a letter or digit; `cohub.*` is reserved |
| Event payload | 16 KB of JSON |
| Presence payload | 2 KB of JSON |
| Publish rate | 2,000 events per second per room |
| Presence rate | 30 updates per second per connection |
| Pending mutations | 256 per connection before backpressure errors |

`createRoom()` returns HTTP 429 with `ROOM_QUOTA_EXCEEDED` at the active-room
limit. Activity never extends `expiresAt`; expired rooms release their slot
automatically.

#### High-frequency events

`publish()` waits for an ACK, so a loop that awaits each call is capped at
roughly `1000 / RTT` events per second. Use `send()` for input frames and other
high-rate traffic:

```js
room.onSendError((error) => console.warn("dropped frame", error.message));
room.onStateChange((state) => {
  if (state !== "joined") pauseSimulation();
});

room.send("input.frame", { frame, pad });
```

`send()` preserves server ordering but drops calls while the room is not joined
and reports rate, validation, membership, and backpressure failures through
`onSendError()`. Use `publish()` whenever a specific event must be confirmed.

#### Seats and participant identity

Every connection is a participant by default, so two tabs appear twice. Each
member includes an opaque `userKey` that is stable for one room and viewer,
letting an application group connections without seeing the account ID.

Set `seatPerUser: true` when each viewer should occupy at most one seat:

```js
const room = await client.app.realtime.createRoom({
  maxParticipants: 2,
  seatPerUser: true,
});
```

A second tab or reconnect takes over the existing seat instead of consuming a
new one. The server keeps the participant ID, updates `room.participantId`, and
closes the superseded connection without emitting a leave event. Without this
mode, an unclean disconnect can retain its seat lease for up to one minute.

#### Desktop command calls that complete later

A `desktop open --call` command with a Surface request stays pending after the
App acknowledges it. The host waits for the App to be mounted and ready, then
the App receives the originating `commandId` in the handler context and
returns an acknowledgement immediately:

```js
let activeCommandId = null;

client.app.surface.handle("image.open", async (input, { commandId }) => {
  if (!commandId) throw new Error("image.open must be called by a desktop command");
  activeCommandId = commandId;
  openImageStudio(input);
  return { accepted: true };
});

async function useImage(result) {
  if (!activeCommandId) return;
  await client.desktop.reportResult(activeCommandId, {
    status: "applied",
    result,
    error: null,
  });
  activeCommandId = null;
}
```

The App should persist the command id alongside its local/server-backed draft
so a reload can restore the pending interaction. An App session may only
report a command that targets that same App. Existing
`client.app.surface.handle(method, handler)` usage remains unchanged.

---

## 6. Complete working example

A no-build HTML App for LLM chat and image generation. Use it as a starting
point and keep only the capabilities you need.

> **Publish this App with:**
> - `appScopes: ["space.view", "session.view", "taskrun.view"]`
>
> `session.prompt.fullaccess` and `generation.create` are requested as viewer
> grants at runtime. See [§8](#8-publishing-an-app-apisdk) for the publish
> API call.

### `index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Cohub SDK Demo</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <div class="container">
    <h1>Cohub SDK Demo</h1>

    <section class="card">
      <h2>1. Context</h2>
      <button id="btn-context" class="btn">Get context</button>
      <pre id="output-context" class="output"></pre>
    </section>

    <section class="card">
      <h2>2. Authorize</h2>
      <button id="btn-auth" class="btn">Request viewer grants</button>
      <pre id="output-auth" class="output"></pre>
    </section>

    <section class="card">
      <h2>3. LLM chat</h2>
      <div id="chat-log" class="chat-log"></div>
      <textarea id="chat-input" rows="2">Say hello in one sentence.</textarea>
      <button id="btn-chat" class="btn">Send</button>
      <pre id="output-chat" class="output"></pre>
    </section>

    <section class="card">
      <h2>4. Image generation</h2>
      <textarea id="img-prompt" rows="3">A cat on the moon, cartoon style</textarea>
      <button id="btn-img" class="btn">Generate</button>
      <div id="img-result"></div>
      <pre id="output-img" class="output"></pre>
    </section>
  </div>
  <script type="module" src="app.js"></script>
</body>
</html>
```

### `app.js`

```js
import { createCohubClient } from "https://esm.sh/@neta-art/cohub@latest";

// --- Environment detection (critical: browsers don't inject ENV) ---
const isDevApp =
  location.pathname.startsWith("/dev/") ||
  location.hostname.includes("dev");

const client = createCohubClient({
  env: isDevApp ? "dev" : "prod",
});

const REQUIRED_SCOPES = ["generation.create", "session.prompt.fullaccess"];

let space = null;
let spaceId = null;
let sessionId = null;

const $ = (id) => document.getElementById(id);

function setOutput(el, data) {
  el.textContent = typeof data === "object" ? JSON.stringify(data, null, 2) : String(data);
}

function log(el, msg) {
  el.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
}

// --- Runtime initialization ---
async function ensureRuntime(outEl) {
  const ctx = await client.context();
  if (!ctx?.space?.id) {
    throw new Error("Not running inside a published app runtime.");
  }
  spaceId = ctx.space.id;
  space = client.space(spaceId);
  return ctx;
}

// --- Viewer grant helpers ---
// Render state from context; act through auth.authorize (silent when covered).
function hasViewerGrant(ctx, scope, spaceId) {
  return (ctx?.permissions?.viewerGrants ?? []).some(
    (g) => g.spaceId === (spaceId ?? ctx?.space?.id) && g.scopes.includes(scope),
  );
}

async function ensureViewerScopes(scopes, reason, outEl) {
  const ctx = await ensureRuntime(outEl);
  const ctxScopes = new Set(ctx?.permissions?.scopes ?? []);
  const missing = scopes.filter((s) => !ctxScopes.has(s));
  if (missing.length === 0) {
    log(outEl, `Already granted: [${scopes.join(", ")}]`);
    return true;
  }
  log(outEl, `Requesting: [${missing.join(", ")}]...`);
  const result = await client.auth.authorize({
    target: { kind: "space", spaceId: ctx?.shell?.space?.id ?? ctx?.invocation?.spaceId },
    scopes,
    reason,
  });
  if (result.status === "granted") {
    log(outEl, `Authorized on ${result.target.kind === "space" ? result.target.spaceId : "account"}.`);
  } else {
    log(outEl, result.status === "cancelled" ? "Consent cancelled." : `Consent denied (${result.code}).`);
  }
  return result.status === "granted";
}

// --- LLM chat (space.prompt + subscribeGeneration) ---
function extractText(blocks) {
  return (blocks ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function waitForTurn(sid, turnId, onStream) {
  return new Promise((resolve, reject) => {
    let done = false;
    let stop = null;

    const finish = (fn) => {
      if (done) return;
      done = true;
      if (stop) try { stop(); } catch {}
      fn();
    };

    // Primary path: stream via WebSocket (needs session.view)
    try {
      stop = space.session(sid).subscribeGeneration({
        state: (event) => {
          const text = extractText(event.state?.contentBlocks);
          if (text) onStream?.(text);
        },
        finalized: (event) => finish(() => resolve(event.turn)),
        error: (event) => finish(() =>
          reject(new Error(event?.rawEvent?.payload?.message || "stream error"))),
      });
    } catch (err) {
      console.warn("subscribeGeneration failed:", err);
    }

    // Fallback: poll (also needs session.view — if missing, both paths 403)
    const poll = async () => {
      try {
        const { turn } = await space.session(sid).turns.get(turnId);
        if (turn.assistantText) onStream?.(turn.assistantText);
        if (turn.status === "completed") finish(() => resolve(turn));
        if (turn.status === "failed" || turn.status === "cancelled") {
          finish(() => reject(new Error(turn.errorMessage || "failed")));
        }
      } catch (err) {
        // Don't silently swallow — surface 403 (missing session.view)
        console.error("poll error:", err);
      }
    };
    const interval = setInterval(poll, 2000);
    poll();
    setTimeout(() => finish(() => reject(new Error("timeout"))), 120000);
    // Note: in production, clear the interval in finish()
  });
}

async function chat(text, outEl) {
  const result = await space.prompt({
    content: [{ type: "text", text }],
    sessionId: sessionId || null,
    intent: "followup",
  });
  sessionId = result.session.id;
  const turn = await waitForTurn(sessionId, result.turn.id);
  return turn.assistantText || extractText(turn.assistantContent) || "(empty)";
}

// --- Image generation (generations.createAndWait) ---
async function generateImage(prompt, outEl) {
  const result = await client.generations.createAndWait(
    {
      spaceId,
      model: "gpt-image-2",
      content: [{ type: "text", text: prompt }],
      parameters: { size: "1024x1024" },
    },
    { onPoll: (d) => log(outEl, `poll: ${d.run.status}`) },
  );
  const image = (result.output ?? []).find(
    (b) => b.type === "image" && b.source?.url,
  );
  return image?.source?.url ?? null;
}

// --- Event handlers (auth.authorize must be in a user gesture) ---
$("btn-context").addEventListener("click", async () => {
  const out = $("output-context");
  out.textContent = "";
  try {
    const ctx = await client.context();
    setOutput(out, {
      "app.id": ctx?.app?.id,
      "space.id": ctx?.space?.id,
      permissions: ctx?.permissions,
    });
  } catch (err) { log(out, err.message); }
});

$("btn-auth").addEventListener("click", async () => {
  const out = $("output-auth");
  out.textContent = "";
  const ok = await ensureViewerScopes(
    REQUIRED_SCOPES,
    "This demo needs to send prompts and generate images.",
    out,
  );
  if (ok) log(out, "Ready to use capabilities.");
});

$("btn-chat").addEventListener("click", async () => {
  const out = $("output-chat");
  out.textContent = "";
  const text = $("chat-input").value.trim();
  if (!text) return;
  try {
    await ensureRuntime(out);
    const ok = await ensureViewerScopes(
      ["session.prompt.fullaccess"],
      "LLM chat needs session.prompt.fullaccess.",
      out,
    );
    if (!ok) return;
    const reply = await chat(text, out);
    log(out, `Reply: ${reply}`);
  } catch (err) { log(out, err.message); }
});

$("btn-img").addEventListener("click", async () => {
  const out = $("output-img");
  out.textContent = "";
  const prompt = $("img-prompt").value.trim();
  if (!prompt) return;
  try {
    await ensureRuntime(out);
    const ok = await ensureViewerScopes(
      ["generation.create"],
      "Image generation needs a generation.create viewer grant.",
      out,
    );
    if (!ok) return;
    const url = await generateImage(prompt, out);
    if (url) {
      $("img-result").innerHTML = `<img src="${url}" style="max-width:100%" />`;
    }
    log(out, "Done.");
  } catch (err) { log(out, err.message); }
});

// Auto-fetch context on load (does not require auth)
(async () => {
  try {
    const ctx = await client.context();
    if (ctx) {
      setOutput($("output-context"), {
        "app.id": ctx.app?.id,
        "space.id": ctx.space?.id,
        permissions: ctx.permissions,
      });
    }
  } catch {}
})();
```

---

## 7. Common pitfalls checklist

Before publishing your App, verify each item:

- [ ] **Environment**: passed `env: "dev"` (or `"prod"`) explicitly — the SDK
  defaults to prod and browsers don't inject `ENV`.
- [ ] **App scopes include every read on the App's own Space**:
  `session.view` (LLM reply reads), `taskrun.view` (generation polling),
  `file.view` (file reads). Missing any of these → 403 on reads.
- [ ] **Viewer-grant-only scopes are requested at runtime, not configured at
  publish time**: `generation.create` and every `user.*` scope can only come
  from a viewer grant.
- [ ] **`session.prompt.*` scope matches `space.prompt({ accessMode })`.**
  Omitting `accessMode` defaults to `full_access`, so holding only
  `session.prompt.readonly` and then calling `space.prompt({ content })` → 403.
  Set `accessMode: "read_only"` explicitly when using the readonly scope.
- [ ] **`session.prompt.fullaccess` does NOT include `session.view`** — they
  are separate. Sending a prompt succeeds but reading the reply 403s without
  `session.view`.
- [ ] **`generation.create` does NOT include `taskrun.view`** — creating a
  generation task succeeds but polling the result 403s without `taskrun.view`.
- [ ] **`auth.authorize()` is called from a user gesture** (button click), not
  on page load. It is safe to call repeatedly — covered scopes renew silently.
- [ ] **Cross-Space access targets the right Space** — viewer grants are per
  Space. Pass `target: { kind: "space", spaceId }` to name one, or
  `target: { kind: "pick-space" }` to let the viewer choose. Act on the
  returned `target`, which may differ from the request. Use
  `auth.requestCreateSpace` to mint a new viewer-owned Space in one consent, or
  `spaces.create()` directly once the app holds a `space.create` viewer grant.
- [ ] **`subscribeGeneration` errors are not silently swallowed** — if the
  stream fails, surface it; a silent fallback to polling will also 403 if
  `session.view` is missing.
- [ ] **Broker mode**: if the App may be accessed standalone, pass
  `app: { brokerOrigin, appId }` and call `auth.authorize()` before any other
  API call (to avoid user-activation exhaustion).
- [ ] **Space has a slug and owner has a username** before publishing — the
  API rejects Apps when either is missing.
- [ ] **Model ids are not hardcoded** — use `client.models.listMultimodal()`
  to fetch available models dynamically (requires auth but no scope).

---

## 8. Publishing an App (API/SDK)

Before creating an App through the API, ensure the owner has a username and
the Space has a slug. The API rejects Apps when either public identity part
is missing.

```js
// Create a single-file App (HTML file)
await client.apps.create({
  spaceId,
  slug: "my-html-demo",
  status: "published",
  targetType: "file",
  targetRef: "demo/index.html",
  appScopes: ["space.view", "session.view", "taskrun.view"],
});

// Create a directory App (must contain index.html)
await client.apps.create({
  spaceId,
  slug: "my-site",
  status: "published",
  targetType: "directory",
  targetRef: "site",
  appScopes: ["space.view", "session.view", "taskrun.view", "file.view"],
});

// Create a port App (sandbox dev server)
await client.apps.create({
  spaceId,
  slug: "live-preview",
  status: "published",
  targetType: "port",
  targetRef: "5173",
  appScopes: ["space.view"],
});
```

`targetRef` is a path **relative to the Space filesystem root** (not a local
path). For file Apps, the target must be an HTML file (`.html`/`.htm`).

Update the published version from the current target:

```js
await client.apps.publishVersion(appId);
```

Other SDK methods: `apps.get(appId)`, `apps.getBySlug(username, spaceSlug,
appSlug)`, `apps.listBySpace(spaceId)`, `apps.update(appId, input)`,
`apps.delete(appId)`, `apps.getStats(appId)`, `apps.download(appId)`.

From the CLI (`--dir` takes the path inside the target Space's workspace, not a local path):

```bash
cohub apps publish <slug> --dir site --app-scope space.view --app-scope file.view
cohub apps grants <slug>      # list your viewer grants for an app
cohub apps revoke <slug> <grantId>
```
