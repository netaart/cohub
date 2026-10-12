# App Runtime Edge

Cloudflare Worker for the Cohub App runtime. It injects a small classic deferred script into published App HTML while keeping published artifact bytes unchanged. Both the edge handler and browser runtime are authored in TypeScript.

| Environment | Worker | App route | Runtime route |
| --- | --- | --- | --- |
| Dev | `cohub-app-runtime-dev` | `https://works.cohub.live/dev/w/*` | `https://works.cohub.live/__cohub_dev/*` |
| Production | `cohub-app-runtime` | `https://works.cohub.live/w/*` | `https://works.cohub.live/__cohub/*` |

The fixed entries are `/__cohub_dev/runtime.js` and `/__cohub/runtime.js`. The bootstrap initializes an empty `window.__cohub` when absent and prints one styled `cohub.runtime` banner per document. It does not yet implement navigation interception or host negotiation.

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

The `App Runtime Deploy to Cloudflare Workers` workflow runs lint, typecheck, and build checks for PRs. Pushes to `main` deploy Dev; stable service tags `vX.Y.Z` deploy Production; manual dispatch selects either environment. Deployments to each environment are serialized. It reuses the repository's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, just like the Web deployment workflow. The optional `GITEA_NPM_TOKEN` follows the existing install convention.

For an authorized manual deployment, set the standard Wrangler environment variables and run:

```bash
pnpm --filter @cohub/app-runtime-edge run deploy
pnpm --filter @cohub/app-runtime-edge run deploy:prod
```

Wrangler owns the names, routes, environment variables, and disabled workers.dev/preview URLs. Do not make unsynchronized Dashboard changes. Worker deployment is separate from npm package releases; this package is private.

## Rollback

Roll back the affected Worker to its previous deployment version. To bypass injection entirely, remove only its App route (`/dev/w/*` or `/w/*`); keep the existing DNS and origin. A browser may retain its fixed runtime entry for 900 seconds and injected HTML for its existing TTL. Preserve a valid runtime response while old HTML can still reference it.

Bump `INJECTION_VERSION` when changing the generated HTML contract. Runtime content changes automatically produce a new ETag and do not require changing the App artifact or fixed runtime URL.
