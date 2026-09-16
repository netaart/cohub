# Cohub Apps Guide

Apps are published, shareable surfaces that turn a Space file, directory, or public sandbox port into a public Cohub page.

Use Apps when a Space produces something people should open directly: a static HTML prototype, a small site, a generated app, a demo running on a sandbox port, or a published App that uses the Cohub SDK to read approved context and request explicit viewer authorization.

## Runtime requirements

Runtime APIs need a Cohub Host: either a published App's iframe or an explicitly configured popup broker (`app: { brokerOrigin, appId }`). A standalone page or local preview without broker configuration has no runtime. Initialize `context()` before using runtime APIs.

For new Apps, use structured `client.auth.authorize()`. See [App authorization](./app-authorization.md) for the target, login, fallback and compatibility contract. Legacy authorization examples below remain supported.

## What an App Contains

An App record belongs to one Space and has a few important fields.

`slug` is the public name used in the URL.

`status` can be `published` or `disabled`.

`targetType` can be `file`, `directory`, or `port`.

`targetRef` is the file path, directory path, or port number.

`appScopes` are permissions the publisher grants directly to the App for its own Space.

`allowedViewerScopes` is deprecated: viewer grants are no longer gated by the app configuration. A viewer may grant any permission they can already use themselves on the target Space.

The public URL shape is:

```text
/:username/:spaceSlug/w/:appSlug
```

For example:

```text
/username/apps-guide-test/w/demo
```

Query parameters and the URL fragment on a public App link are forwarded to
embedded web and port apps. This supports shareable application state such as
`?view=timeline#today`. Parameters in the `cohub_*` namespace are reserved for
the Cohub host and are available only through their documented SDK APIs. Do not
put secrets or access tokens in an App URL.

## Publish From the UI

Prepare something publishable in a Space: an HTML page, a `.board` file, any other single file, a directory containing `index.html` with relative assets, or a running dev server on a supported public sandbox port.

Open the file, directory, or port preview, then click `Publish`. The dialog asks for an App slug (and a username or space slug if missing). Under `App can`, select the permissions the app receives directly for its own Space.

After publishing, the dialog shows the public URL. The App also appears in the left sidebar under `Apps`.

## Manage an App

The App management page is:

```text
/spaces/:spaceId/apps/:appId
```

From that page you can open the public page, edit the slug, target, status, and permissions, disable or publish the App, update its published version, delete it, and copy the App ID.

Disabling an App removes it from the public by-slug lookup. Publishing or updating a version creates a fresh snapshot from the current target. Deleting an App removes the management record, viewer grants, and version records.

Editing a target changes the source used by the next version. The public page changes only after publishing or updating a version.

## Targets and Limits

File apps accept any single file up to 1 GiB. An HTML page (`.html` / `.htm`) is published as a web page. A `.board` file is published as an interactive read-only Board, together with the assets it references. Any other file is published for native preview (Markdown, code, image, video, audio, PDF) with a download fallback.

A Board publish captures the Board's own state plus the workspace files it actually references — images, videos, file-card covers, and effect or clip assets. Files a Board does not reference are never published, and file cards show the preview captured at publish time rather than the whole target file.

Directory apps must contain `index.html`. The published directory must contain 1 to 1000 files and total 1 byte to 1 GiB.

Port apps use the sandbox public endpoint for the port. The port must be one of the supported Cohub public sandbox ports.

The public App page only serves an App when its status is `published`.

## Permissions

An app's effective permission for one Space is the union of two grant sources — either one is enough:

- **App-side grant** — a bounded publisher grant (`space.view`, `session.view`, `file.view`, `file.edit`, `taskrun.view`, `session.prompt.readonly`, `session.prompt.fullaccess`, `command.execute`) that applies only to the app's own Space. No viewer consent needed; the server resolves it live on every request.
- **Viewer grant** — a viewer consents through a dialog. A viewer may grant **any** permission on **any** Space they choose, with two hard rules enforced by the server:
  - At grant time the viewer must currently hold every requested permission on the target Space.
  - At use time the grant only works while the viewer still holds that permission there — losing a membership or a role downgrade takes effect immediately.

Account-level scopes (`user.space.list`, `user.session.list`, `user.taskrun.list`, `user.usage.read`) and the account-level action `space.create` always require a viewer grant; a publisher can never pre-grant them via `appScopes`.

Direct publisher grants are limited to:

```text
space.view  session.view  file.view  file.edit
taskrun.view  session.prompt.readonly  session.prompt.fullaccess
command.execute
```

Generation, member/Sandbox/Commerce management, and account-level scopes always require a viewer grant.

Viewer grants are per Space: one viewer can hold a different grant for the app's own Space and for each Space they picked. The consent dialog shows the target Space name, resolved by Cohub — never by the app.

Viewer-granted permissions never inherit the publishing app's Space access: `taskrun.view` granted for Space A lists Task Runs in Space A only — re-validated against the viewer's current access there. The separate `user.taskrun.list` account scope exposes only Task Runs owned by the viewer.

The `user.*` scopes grant access to the viewer's account-level data across all their spaces. `user.space.list` lets the app call `cohub.spaces.list()`. `user.session.list` lets the app call `cohub.user.listSessions()`, which returns recent sessions the viewer can already view as themselves. `user.taskrun.list` lets the app list and read every Task Run owned by the viewer through the unscoped `cohub.tasks.list()`, including runs from Spaces they can no longer access and account-level runs. `user.usage.read` lets the app call `cohub.user.getActivity()`. Listing Spaces does not grant access to them — the app still needs a grant for each Space it touches; likewise `user.taskrun.list` shows owned Task Runs but grants no access to their source Spaces or to other users' runs. `space.create` is an account-level action: the app may create a Space owned by the viewer, directly via `cohub.spaces.create()` or through `cohub.auth.requestCreateSpace()`.

Grants last 14 days; tokens last 1 hour. Tokens carry identity, publisher scopes, and a display-only snapshot of the consented scopes (`viewerScopes`, for legacy clients that decode the JWT) — consent state lives in the grant rows and is resolved on every request, so tokens stay constant-size and revoking a grant takes effect immediately. Silent reuse only renews a live grant that still covers the requested scopes: it can never create, widen, or revive a grant, so a revoked grant stays revoked until the viewer consents again in a dialog:

```bash
cohub apps grants <app>            # list your grants for an app
cohub apps revoke <app> <grantId>  # revoke one
```

Use the smallest permission set that the App needs. A visual static demo normally does not need file, session, task, prompt, or generation permissions.

## Use the SDK Inside an App

A published App can use the Cohub SDK from its own HTML/JS.

For no-build HTML, import the SDK from an ESM CDN and create a client:

```js
const { createCohubClient } = await import(SDK_URL);
const cohub = createCohubClient();
const context = await cohub.context();
const spaceId = context.shell?.space?.id ?? context.invocation?.spaceId ?? context.app.homeSpace?.id ?? context.space.id;
const space = cohub.space(spaceId);
```

`cohub.context()` returns App identity, App home Space identity, the current Cohub shell location, and permission scopes. `context.shell` contains the current `space`, `session`, and viewed `turn` (each location may be null). In a workspace App, `shell.surface` is `"workspace"`. For a new chat background, `shell.surface` is `"background"`, `shell.space` is the hosting Space, and `session` / `turn` are null. `context.invocation.spaceId` is the same hosting Space for compatibility. `context.app.homeSpace` is the App home Space. Use `client.app.onContextChanged()` for updates and cache the latest context for frequent reads instead of polling.

To call APIs that need App permissions, use the SDK client after the context is loaded. For example, `space.getConfig()` expects `space.view`; file tree reads expect `file.view`; session list reads expect `session.view`. Realtime subscriptions (`space.events`, `session.subscribe`) join the Space room, which expects `space.view`; a rejected subscription reaches the `error` handler as a `system.subscribe.error` event.

To request viewer authorization, call the SDK authorization helper from a user action:

```js
await cohub.auth.request({
  scopes: ["session.prompt.readonly"],
  reason: "This App wants to read session context for the current viewer."
});
```

Prompt-writing behavior should request `session.prompt.fullaccess`. Generation creation should request `generation.create`.

To ask for access to one of the viewer's other Spaces, let the viewer pick it — `requestSpace` merges the choice and the grant into one consent dialog. The host loads the space list (the app never sees it) and the result carries the picked Space:

```js
const { granted, space } = await cohub.auth.requestSpace({
  scopes: ["file.view", "session.view"],
  reason: "This app reads the Space you pick.",
});
if (granted && space) {
  const picked = cohub.space(space.id);
}
```

To create a Space for the viewer, use `requestCreateSpace`. `space` is the same `CreateSpaceInput` as `spaces.create()` — including `bootstrapSource` for a checkpoint or git repo. One consent creates the Space (owned by the viewer) and grants the scopes on it. This is never silent; the host calls `POST /api/spaces` with the viewer's account token, then authorizes as usual.

```js
const { granted, space } = await cohub.auth.requestCreateSpace({
  scopes: ["file.view", "session.view", "session.prompt.fullaccess"],
  space: {
    name: "Whale Shrine",
    bootstrapSource: { type: "checkpoint", checkpointId },
  },
  reason: "Create a workspace from this template.",
});
if (granted && space) {
  const created = cohub.space(space.id);
}
// `{ granted: false, space }` means the Space was created but bootstrap did not finish — no grant was issued.
```

When the app already knows the target Space, pass its id instead — the dialog then only confirms that Space:

```js
await cohub.auth.request({
  scopes: ["file.view", "session.view"],
  spaceId: pickedSpace.id,
  reason: "This app reads the Space you picked.",
});
```

`cohub.context().permissions` reports `viewerGrants` (the per-space viewer consents — previously granted ones included), plus flat `scopes` / `appScopes` / `viewerScopes` for compatibility.

### Silent reuse vs. asking again

Apps never cache grants themselves — the host does. Every `auth.request` call reuses a previous grant silently (for 14 days after the viewer last confirmed) and only opens the consent dialog when something new is needed. To force a fresh dialog instead — re-confirming a grant, or letting the viewer switch to another Space — pass `alwaysAsk`. `requestCreateSpace` is the exception: it always opens a dialog, and each confirm creates a new Space.

```js
// Silent-first: no dialog when a grant already covers the scopes.
await cohub.auth.request({ scopes: ["file.view"] });

// Always show the dialog, even when a grant covers the scopes.
await cohub.auth.request({ scopes: ["file.view"], alwaysAsk: true });

// The picker equivalent: always let the viewer pick again.
await cohub.auth.requestSpace({ scopes: ["file.view"], alwaysAsk: true });
```

`cohub.context().permissions.viewerGrants` reflects what the viewer previously granted, so apps can render their state without triggering anything.

To access the viewer's account-level data, request the corresponding `user.*` scope:

```js
// List the viewer's spaces
await cohub.auth.request({
  scopes: ["user.space.list"],
  reason: "This App wants to show your space list.",
});
const spaces = await cohub.spaces.list();

// List sessions the viewer created across all spaces
await cohub.auth.request({
  scopes: ["user.session.list"],
  reason: "This App wants to list your sessions.",
});
const { sessions } = await cohub.user.listSessions({ limit: 20 });

// Read the viewer's activity
await cohub.auth.request({
  scopes: ["user.usage.read"],
  reason: "This App wants to show your activity.",
});
const activity = await cohub.user.getActivity({ days: 30 });
```

For commerce inside an App — feature unlocks and credit consumption:

```js
// Check entitlements and credit balance in one call
const { entitlements, credits } = await cohub.app.commerce.getEntitlements();

// Feature unlock: purchase if not entitled
const unlocked = entitlements.some((e) => e.benefitKey === "space_pro" && e.enabled);
if (!unlocked) {
  await cohub.app.commerce.purchase({ productKey: "pro_unlock" });
}

// Credit consumption: consume for a metered action
const result = await cohub.app.commerce.consumeCredits({
  amount: 10,
  operationId: crypto.randomUUID(),
  reason: "Export high-res image",
});
if (result.status === "insufficient") {
  await cohub.app.commerce.purchase({ productKey: "credit_pack" });
}

// After checkout return, query the order
const checkoutState = await cohub.app.commerce.getCheckoutState();
if (checkoutState.orderId) {
  const { order } = await cohub.app.commerce.getOrder(checkoutState.orderId);
}
```

The example app in `docs/examples/app-capability-lab/` demonstrates runtime context, token inspection, file reads, session reads, viewer authorization, prompt calls, account-level data access, and a minimal commerce flow from inside a published App.

For a focused commerce example, see:

- `docs/app-commerce-guide.md`
- `docs/examples/app-capability-lab/commerce-demo.md`
- `docs/examples/app-capability-lab/commerce-demo.html`

## Run App Actions

Directory Apps can expose server-side-style entrypoints under `.cohub/actions/`:

```text
my-app/
├── index.html
└── .cohub/
    └── actions/
        ├── summarize.ts
        └── convert.sh
```

The frontend invokes a published Action by file stem:

```ts
const task = await cohub.app.actions.run({
  action: "summarize",
  input: { text: "Long document..." },
});

const result = await cohub.tasks.get(task.taskRunId);
```

The host downloads and caches the immutable App version, then runs `.ts` and
`.js` entrypoints with the Sandbox's Node.js 24 runtime. TypeScript uses Node's
native type stripping: erasable type syntax works, while syntax that requires
transformation, such as enums, namespaces, and parameter properties, does not.
Other files run directly through their executable bit, shebang, or binary
format. Input arrives as JSON on stdin; stdout and stderr are captured by the
existing Run Command Task Run. Action input is
stored with that Task Run and is visible to the App owner and Space members who
can inspect the Task, so do not treat it as a secret transport.

Actions run in the App home Space Sandbox with the existing
`COHUB_EXECUTION_TOKEN`. The execution actor and platform cost owner are the App
owner, while App Commerce entitlement reads and credit consumption apply to the
signed-in viewer. Action code can use the regular Cohub SDK or CLI without
managing credentials:

```bash
cohub apps commerce entitlements --json
cohub generate "Summarize the JSON received on stdin" --model <model>
cohub apps commerce credits consume --amount 1 --operation-id "$(uuidgen)"
```

No manifest is required. An Action key must use lowercase letters, numbers,
`-`, or `_`, and exactly one matching entrypoint may exist. The `.cohub`
directory is part of the downloadable App artifact. Authors who need private
implementation details can keep the published Action thin and call a script in
the home Space or an external API. An Action cannot invoke
`cohub.app.actions.run()` from inside another Action; call the underlying script
or Cohub API directly instead.

See `docs/examples/app-capability-lab/` for a browser probe backed by
`.cohub/actions/inspect-ts.ts` and `.cohub/actions/inspect-bash.sh`.

## Preview an App Inside the Workspace

A detail page offers two ways to open the published result:

- **Preview** shows the App as a tab in the workspace preview pane, beside the
  detail page, so publish settings and the running App stay visible together.
- **New tab** opens the public App page as before.

The preview tab is keyed by App id, deep-linkable as `?window=app:<appId>`,
and participates in the same tab budget as file, Board, and port previews.

## Let an Agent Drive the Preview

An Agent running in the Space can open the same preview in the Cohub tab the chat
started from, and call methods the App exposes:

```bash
cohub desktop open <appId|url|app://...|username/space/app>
cohub desktop open <app> --call selection.get
cohub desktop open <app> --call board.focus --data '{"nodeId":"n1"}'
```

Register a method that receives the UI command id and completes it later:

```ts
client.app.surface.handle("image.open", async (input, { commandId }) => {
  openImageStudio(input, commandId);
});

await client.ui.reportResult(commandId, {
  status: "applied",
  result: selectedImage,
  error: null,
});
```

Only registered methods are reachable, so an App decides exactly what an Agent can
do. There is no DOM access and no script evaluation. Commands are routed by request
provenance and reach only the frontend instance that originated the command, so they
cannot touch another user's browser. An App also answers only a Cohub app origin,
so embedding it elsewhere cannot invoke its methods. Native file and Board apps can
be previewed but expose no callable surface.

## Open an App as an Overlay

Besides a preview tab, an App can open as an **overlay**: a transparent,
chrome-free layer that floats above the whole workspace. Overlays sit below
every system surface (toasts, dialogs, the command palette), so an App can
never cover Cohub's own UI. They suit companions, heads-up displays, and
one-shot effects — anything that should live *on* the desktop rather than *in*
a window.

```bash
cohub desktop open <app> --as overlay
cohub desktop open <app> --as overlay --call milkfrog.say --data '{"text":"Ship it."}'
```

A page can declare the surface it wants, so `--as` becomes unnecessary:

```html
<meta name="cohub:surface" content="overlay" />
```

Cohub reads the declaration at publish time into `meta.presentation.surface`.
Opening the App from the workspace — the Open button, installed Apps, chat
links, App-to-App navigation — follows it too. `--as window` overrides it for
one desktop command.

### What the App controls

An overlay covers the window and starts fully click-through.
The App claims the parts that should receive pointer events and, optionally,
where it sits:

```js
const rect = panel.getBoundingClientRect();
cohub.app.requestConfigure({
  // overlay-local CSS pixels — identical to getBoundingClientRect() coordinates
  inputRegion: [{ x: rect.left, y: rect.top, width: rect.width, height: rect.height }],
});
```

`inputRegion` is `"none"` (default), `"all"`, or a list of rectangles. It only
decides where pointer events go and never clips what the overlay paints, so
decorative parts can stay outside it. `geometry` (`anchor`, `x`, `y`, `width`,
`height`) shrinks the overlay to a region of the window; the host clamps it
on-screen. A present `geometry` replaces the current shape and an axis without
a size fills the window, so `geometry: {}` returns a panel to the full layer.
An invalid axis makes the whole geometry ignored (keeping the current shape),
and omitting `geometry` leaves it unchanged.

Pick the shape that matches the App. A fixed panel should shrink to its own
size with `geometry` and take `inputRegion: "all"`:

```js
cohub.app.requestConfigure({
  geometry: { anchor: "top-right", x: 12, y: 12, width: 260, height: 180 },
  inputRegion: "all",
});
```

A rect list suits things that move across the whole screen. The host activates
a rect when the pointer hovers over it, so rects respond to a mouse but not to
the first tap on a touch screen — `"all"` and `geometry` work everywhere. The
host follows the pointer back out (the App reports it while it owns the region),
so leaving a rect restores click-through to the desktop underneath.

The App must paint its own transparency: `html, body { background: transparent }`
plus `<meta name="color-scheme" content="light dark">` so the frame follows the
host theme — a color-scheme mismatch makes Chromium paint an opaque backdrop
behind the frame. Avoid `backdrop-filter`: an overlay floats over content that
changes every frame while the agent streams, so a blurred panel keeps the GPU
re-blurring for as long as it is visible — noticeably on phones. Use a solid,
mostly opaque background instead. The App closes itself with
`cohub.app.requestClose()`; the viewer can always press `Escape` in the
workspace to dismiss every overlay.

### What stays the same

Everything else works exactly as in a tab: context, authorization, Space APIs,
realtime rooms, `surface.handle()` + `--call`, composer chips, navigation, and
commerce. `context.invocation.surface` reads `"overlay"` so an App can tell how
it was opened. A reference App lives in `docs/examples/desktop-surfaces/milk-frog/`.

## Embed Other Apps

A published App can host other Apps by rendering their public pages in
iframes — a launcher, a dashboard, or a window manager are all ordinary Apps.
The public page keeps owning the embedded App's runtime: its bridge, consent
dialogs, commerce, and Cohub bar work exactly as they do standalone, and the
embedder never sees the embedded App's tokens or messages.

```html
<iframe
  src="https://cohub.live/alice/studio/w/notes"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
  allow="clipboard-read; clipboard-write; fullscreen; web-share"
></iframe>
```

Attach the SDK to the frame to forward your shell location and receive the
embedded App's close intent:

```js
const embed = cohub.app.embed.attach(frame, {
  appId: context.app.id,
  shell: context.shell ?? null,
  onCloseRequest: () => frame.remove(),
});

cohub.app.onContextChanged((next) => embed.setShell(next.shell ?? null));
embed.dispose();
```

The embedded App sees the forwarded location as `context.shell` with
`surface: "embed"` and learns who hosts it from
`context.invocation.embedder` (`{ appId, slug }`). Cohub sets `embedder` only
when that App's published content is served from the frame that sent the hint;
an unverifiable embedder leaves it absent. Treat the forwarded Space and
Session ids as navigation hints, never as authorization inputs — reading them
still requires the embedded App's own grants.

Any App can ask its host to close the surface it runs in:

```js
cohub.app.requestClose();
```

A workspace tab closes, an embedded page relays the request to its embedder's
`onCloseRequest`, and a standalone page closes the browser tab or, when the
browser forbids that, navigates back.

See `docs/examples/app-capability-lab/embed-demo.html` for a minimal window
manager built this way.

## Promote an App

Editors can create immutable promotion links for paid or owned traffic. `generic` records local landing and readiness analytics without loading third-party code. `meta` adds the deployment-configured Meta Pixel and Conversions API provider.

```bash
cohub apps promotions create <app> \
  --name "Meta launch video A" \
  --provider meta \
  --utm-source instagram \
  --utm-medium paid_social \
  --utm-campaign launch_2026 \
  --utm-content video_a
```

List links and inspect one promotion's aggregate statistics:

```bash
cohub apps promotions list <app>
cohub apps promotions stats <app> <promotion-id>
```

Promotion links always open the current published App. Statistics retain the immutable App version that served each event. Hourly counts cover landing, readiness, registration, purchase-confirmation, and checkout-start events; Cohub does not retain visitor-level promotion records.

The browser keeps a 30-day, App-scoped last-touch attribution in local storage so authentication and checkout redirects preserve the Promotion. Configured providers receive App ready, first Cohub registration, purchase-confirmation shown, and usable-checkout-created events. Meta maps these to `ViewContent`, `CompleteRegistration`, `AddToCart`, and `InitiateCheckout`. Checkout uses the existing purchase attempt id as the shared Pixel/CAPI event id; paid-order Purchase delivery is deferred until Billing exposes a reliable OrderPaid event or outbox trigger.

The `generic` provider is always available. A deployment enables `meta` by configuring `COHUB_META_PIXEL_ID` and `COHUB_META_CAPI_ACCESS_TOKEN`; `COHUB_META_API_VERSION` defaults to `v21.0`. Set `COHUB_META_CLIENT_IP_HEADER` only when the edge overwrites that header with the trusted public client IP (for example, `cf-connecting-ip`); otherwise Cohub uses the direct socket address and omits private addresses.

## View Statistics

Editors can inspect total, 24-hour, 7-day, and 30-day views with a source breakdown:

```bash
cohub apps stats <workId|url|username/space/work>
```

Use `--json` to include the 30-day daily trend.

## Download Published Artifacts

Newly published file and directory apps include an immutable artifact manifest. Download them by id, public URL, mention URI, or public slug reference:

```bash
cohub apps download <workId|url|username/space/work> --output <path>
```

The CLI reads the small manifest, streams files directly from the CDN with bounded concurrency, verifies every SHA-256 checksum, and atomically restores the published artifact. Existing outputs are never overwritten. An HTML file with published companion assets is restored as a directory bundle so no artifact files are lost. Board and port apps are not downloadable because neither maps safely to a restorable file or directory artifact.

## Publish Through the API or SDK

The SDK exposes `apps.create`, `apps.update`, `apps.publishVersion`, `apps.delete`, `apps.get`, `apps.getBySlug`, `apps.getStats`, and `apps.listBySpace`.

`apps.get(appId)` returns the App record plus `publicUrl`, `content`, `owner`, and `space` when the App can be publicly resolved.

Before creating an App through the API, make sure the owner has a username and the Space has a slug. The API rejects apps when either public identity part is missing.

Usernames and Space slugs can be set or changed, but they cannot be cleared once set.

Create a single-file App:

```js
await sdk.apps.create({
  spaceId,
  slug: "my-html-demo",
  status: "published",
  targetType: "file",
  targetRef: "demo/index.html",
  appScopes: ["space.view"]
});
```

Create a directory App:

```js
await sdk.apps.create({
  spaceId,
  slug: "my-site",
  status: "published",
  targetType: "directory",
  targetRef: "site",
  appScopes: ["space.view", "file.view"]
});
```

Create a port App:

```js
await sdk.apps.create({
  spaceId,
  slug: "live-preview",
  status: "published",
  targetType: "port",
  targetRef: "5173",
  appScopes: ["space.view"]
});
```

Fetch a public App by URL parts:

```js
await sdk.apps.getBySlug(username, spaceSlug, appSlug);
```

Update the published version from the current target:

```js
await sdk.apps.publishVersion(workId);
```

List a Space's apps:

```js
await sdk.apps.listBySpace(spaceId);
```

Fetch an App's view statistics:

```js
await sdk.apps.getStats(workId);
```

## Verification

This guide was verified in a clean Space on 2026-06-19. File and directory Apps both published successfully, resolved through the by-slug API, and served the expected HTML over HTTPS.

## Common Failure Cases

If the public link cannot be formed, check that the user has a username and the Space has a slug.

If a file App fails, check that the target is between 1 byte and 1 GiB. If a Board App fails, check that the `.board` file is valid and references at most 1000 assets totalling at most 1 GiB.

If a directory App fails, check that the directory contains `index.html`, has 1 to 1000 files, and totals at most 1 GiB.

If an App opens but cannot use Cohub APIs, check that it is running inside a published App iframe — static asset URLs and local previews do not provide the App runtime. If it is, check its `appScopes` and the viewer-granted scopes shown in `cohub.context()`.

If a viewer authorization request fails, check that the viewer currently holds every requested permission on the target Space — grants are limited to what the viewer can already do there themselves.

If account-level data calls (`spaces.list()`, `user.listSessions()`, `user.getActivity()`) return 403, the viewer must first grant the corresponding `user.*` scope via `cohub.auth.request()`.
