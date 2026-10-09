# App SDK Lab

A single-page, no-build App: every probe is a button that calls one real API
and renders what came back. Use it to verify a deployment, learn the runtime,
or as the skeleton for a new App. Deep reference:
[App development](https://cohub.live/docs/developers/apps).

## What it exercises

- **Context** — `client.context()` identity, invocation, shell location;
  live updates via `onContextChanged()`; raw parent-protocol wire tap.
- **Callable surface** — `surface.handle()` driven by
  `cohub desktop open <app> --call counter.increment`.
- **App Actions** — `app.actions.run()` with TypeScript and Bash entrypoints
  (`.cohub/actions/`), owner-funded, read back via `tasks.get()`.
- **Scoped reads** — `space.getConfig()`, `files.list()`, `sessions.list()`.
- **Viewer auth** — `auth.authorize()` with space / account / pick-space
  targets, silent reuse, `alwaysAsk`.
- **Prompts** — read-only and full-access `space.prompt()`.
- **Account data** — `spaces.list()`, `user.listSessions()`,
  `user.getActivity()` behind their `user.*` grants.
- **Commerce loop** — the minimal feature-unlock and credit-consumption flow.
- **Embeds** — `embed-demo.html`: host any published App in a draggable window
  via `app.embed.attach()`.

## Publish

```bash
# Upload the folder into the Space, then:
cohub -s <space-id> apps publish app-lab \
  --dir cohub-apps/app-capability-lab \
  --app-scope space.view --app-scope session.view --app-scope file.view --app-scope taskrun.view
```

Viewer grants (prompts, generation, account data) are requested at runtime
from a gesture — nothing beyond the read scopes is configured at publish time.

## Commerce setup (CLI)

```bash
cohub -s <space-id> spaces commerce setup

# Feature benefit + product
cohub -s <space-id> spaces commerce benefits create --type feature --name "Space Pro"
cohub -s <space-id> spaces commerce products create \
  --name "Pro Unlock" --amount-usd 9.99 --visibility public --status active
cohub -s <space-id> spaces commerce bind \
  --product-key pro_unlock --benefit-key space_pro

# Credit benefit + product
cohub -s <space-id> spaces commerce benefits create --type credits --name "500 Credits" --amount 500
cohub -s <space-id> spaces commerce products create \
  --name "Credit Pack" --amount-usd 4.99 --visibility public --status active
cohub -s <space-id> spaces commerce bind \
  --product-key credit_pack --benefit-key 500_credits
```

Inspect and operate server-side:

```bash
cohub apps commerce entitlements --app-id <app-id>
cohub apps commerce credits consume --app-id <app-id> --amount 100 --reason "High-res export"
cohub apps commerce orders get --app-id <app-id> --order-id <order-id>
```

The runtime loop itself — `getEntitlements` → gate → `purchase` → checkout
return → `getCheckoutState` / `getOrder` → `consumeCredits` — is documented
with code in [App development → Commerce](https://cohub.live/docs/developers/apps#commerce).
