# App Runtime Edge

Cloudflare Worker for the Cohub App runtime. It injects a small classic deferred script into published App HTML while keeping published artifact bytes unchanged. Both the edge handler and browser runtime are authored in TypeScript.

| Environment | Worker | App route | Runtime route |
| --- | --- | --- | --- |
| Dev | `cohub-app-runtime-dev` | `https://works.cohub.live/dev/w/*` | `https://works.cohub.live/__cohub_dev/*` |
| Production | `cohub-app-runtime` | `https://works.cohub.live/w/*` | `https://works.cohub.live/__cohub/*` |

The fixed entries are `/__cohub_dev/runtime.js` and `/__cohub/runtime.js`. The bootstrap initializes an empty `window.__cohub` when absent and prints one styled `cohub.runtime` banner per document. Embedded documents support the opt-in lifecycle and navigation channels below. The SDK authorization/context bridge remains separate.

## Embedded document lifecycle protocol

The private browser runtime implements version 1 of `cohub.runtime.lifecycle`. Any direct parent container can subscribe without using the Cohub SDK or a specific host domain. This channel carries document lifecycle measurements only; it carries no URLs, credentials, authorization, App context, or request IDs.

Parent → runtime:

```ts
{
  type: "cohub.runtime.lifecycle",
  version: 1,
  action: "subscribe" | "unsubscribe",
  subscriptionId: string
}
```

Runtime → parent:

```ts
{
  type: "cohub.runtime.lifecycle",
  version: 1,
  action: "state",
  subscriptionId: string,
  documentId: string,
  timeOrigin: number,
  milestones: Array<{ name: string; startTime: number }>
}
```

`subscriptionId` must contain a non-whitespace character and be at most 128 characters long. The parent creates a fresh ID for each iframe navigation, installs its message listener before subscribing, and accepts states only from that iframe's `contentWindow`, its expected origin, and the active subscription. The runtime accepts requests only from `window.parent` with an HTTP(S) origin, ignores malformed or unsupported messages, and sends replies to that exact origin. Opaque origins are unsupported. The subscription ID correlates the lifecycle exchange; it is not an authorization token.

Every valid `subscribe` immediately returns the current snapshot, including an empty snapshot before paint. Later milestones produce updated snapshots. Repeating `subscribe` replays the snapshot, including after FCP, so a late listener can recover. A new subscription replaces the previous one: the runtime retains at most one direct-parent subscription. `unsubscribe` stops notifications only when both ID and origin match; it does not discard the document's recorded milestone. Containers may retry subscribing while the deferred runtime starts, then stop retries after the first valid state and unsubscribe when disposing the frame.

`documentId` is randomly generated once per document and is a non-empty string of at most 128 characters. `timeOrigin` is that document's `performance.timeOrigin`, in milliseconds since the Unix epoch. Each milestone's `startTime` is milliseconds relative to that document's time origin, not the parent's clock. A new document gets a new ID even if its URL is unchanged.

Snapshots contain at most 32 milestones with unique names. Each name is a non-whitespace string of at most 128 characters; timing values are finite and nonnegative.

This implementation produces only `first-contentful-paint`, once per document, using `PerformanceObserver.observe({ type: "paint", buffered: true })`. The observer disconnects after FCP. Missing or failing Paint Timing support leaves the snapshot empty and does not interrupt the App. Version 1 permits additional milestone names: hosts must ignore unknown names without rejecting the snapshot or treating those names as readiness. An empty snapshot acknowledges subscription; it does not mean the content is ready. FCP means the document painted its first content and does not promise that App data, images, or interactions are fully ready.

This is a direct-parent channel. A public Cohub App page that embeds the published HTML needs an explicit relay before an outer container can receive the inner document's milestones; no relay is implemented here. Containers must retain a load/timeout fallback for old runtimes, blocked injection, unsupported browsers, and pages that do not paint. Keep the iframe renderable while an opaque loading overlay covers it, since hiding its rendering can prevent the paint being awaited. SDK `cohub.app.runtime` ready and surface RPC readiness have different semantics.

## Embedded App navigation

Without help, an App that links to another App loads that App's whole public page, chrome included, inside its own frame. The runtime lets the direct parent claim those navigations with `cohub.app.navigation` version 1 (`@cohub/protocol/app-navigation`).

Parent → runtime, after every frame load:

```ts
{ protocol: "cohub.app.navigation", version: 1, type: "intercept", origins: string[] }
```

Nothing is intercepted until a parent sends `intercept`; the latest message from `window.parent` wins. Origins must be exact HTTP(S) origins, at most 8. Cohub's `AppSurface` declares its own origin whenever it can open Apps.

When the document starts a same-tab `push` or `replace` navigation to a declared origin, the runtime cancels it and posts an App `open` with the destination URL as `ref` to the declaring origin. A `handled: true` `open.result` ends the navigation. Anything else, including no reply within 8 seconds, resumes the original navigation once. Hash changes, reloads, history traversals, downloads, form submissions, and new-tab links are never intercepted. Repeated clicks on a pending destination are dropped, and any newer cross-document navigation supersedes a pending offer so it never resumes. The runtime uses the Navigation API; without it, navigations proceed unchanged, and Cohub's public App page still hands the App to the host when it loads inside an App frame.

## Loading and caching

The script is inserted before the first head module/deferred script, with fallbacks at the end of the head or start of the body. Existing runtime scripts are deduplicated by their exact resolved URL; an author's unrelated script is never removed based only on a `data-*` attribute. The classic script uses `defer`, an absolute URL, and `data-cfasync="false"`. It does not promise to run before synchronous inline or async App scripts. CSP is preserved; policies that exclude the runtime may prevent it from executing.

Runtime responses use `Cache-Control: public, max-age=900, must-revalidate` and a content-derived ETag. GET, HEAD and conditional 304 responses are supported. New documents use the script's independent cache policy; already open documents keep their running version. Publishing or rolling back permits up to roughly 15 minutes of browser cache lag. No Cache API or additional edge cache is used for runtime responses.

Existing Cloudflare rules keep App HTML cached for three days in browsers and at the edge. These rules are managed separately from this Worker's Wrangler configuration. First-time injection may require a hard refresh for browsers holding old HTML. Future runtime updates at the fixed URL do not require republishing Apps.

Only HTML navigation requests are transformed: `Sec-Fetch-Dest: document|iframe|frame`, or an explicit `Accept: text/html` when Fetch Metadata is absent. SDK/CLI downloads and browser `fetch` retain the original bytes. HTML responses vary on `Accept` and `Sec-Fetch-Dest` so browser caches separate navigation and raw content. Request/response `no-transform`, attachments, range responses, non-HTML and errors remain unmodified. Transformed responses use separate validators; source validators and byte-integrity headers are not reused.

## Development

Use Node 26 and the repository's pinned pnpm (`.nvmrc` + `packageManager`):

```bash
pnpm --filter @cohub/app-runtime-edge... --filter cohub install --frozen-lockfile
pnpm --filter @cohub/app-runtime-edge lint
pnpm --filter @cohub/app-runtime-edge typecheck
pnpm --filter @cohub/app-runtime-edge build
```

`typecheck` generates `worker-configuration.d.ts` from Wrangler. Worker, browser, and build-script TypeScript contexts are checked separately. `build` compiles the browser runtime to independent Dev/Production IIFEs and runtime text modules. Wrangler runs this build before compiling the edge TypeScript. Generated files stay in ignored directories.

## Deployment

The `App Runtime Deploy to Cloudflare Workers` workflow runs lint, typecheck, and build checks for PRs. Pushes to `main` deploy Dev; stable service tags `vX.Y.Z` deploy Production; manual dispatch selects either environment. Deployments to each environment are serialized. It reuses the repository's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, just like the Web deployment workflow.

For an authorized manual deployment, set the standard Wrangler environment variables and run:

```bash
pnpm --filter @cohub/app-runtime-edge run deploy
pnpm --filter @cohub/app-runtime-edge run deploy:prod
```

Wrangler owns the names, routes, environment variables, and disabled workers.dev/preview URLs. Do not make unsynchronized Dashboard changes. Worker deployment is separate from npm package releases; this package is private.

## Rollback

Roll back the affected Worker to its previous deployment version. To bypass injection entirely, remove only its App route (`/dev/w/*` or `/w/*`); keep the existing DNS and origin. A browser may retain its fixed runtime entry for 900 seconds and injected HTML for its existing TTL. Preserve a valid runtime response while old HTML can still reference it.

Bump `INJECTION_VERSION` when changing the generated HTML contract. Runtime content changes automatically produce a new ETag and do not require changing the App artifact or fixed runtime URL.
