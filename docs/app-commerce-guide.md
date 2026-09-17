# Cohub App Commerce Guide

App commerce lets a published App sell one-time products backed by Space-level billing data. Products can carry **feature benefits** (access gates) and **credit benefits** (consumable credits).

## Runtime requirements

`cohub.context()`, `cohub.auth.*`, and `cohub.app.commerce.*` only function inside a **published** Work — the Cohub-hosted iframe where `window.parent` is the Cohub shell. They do not work from a static asset URL or a local preview. In those environments `context()` is `null` and commerce calls fail. Always develop against a published Work.

## Scope

- `business = space`
- products, benefits, bindings, and orders live in billing
- the App hardcodes product keys and benefit keys
- the outer host owns checkout confirmation and redirect
- Space credits use a virtual `cohub_credit` token at business scope; creators never configure token types
- Cohub Balance is an optional platform-managed product component with a global USD balance scope

## Benefit types

| Type | What it does | Creator config |
|---|---|---|
| `feature` | Gates access to a capability via metadata (`enabled`, numeric limits) | Name, description, metadata fields |
| `credits` | Grants a fixed amount of consumable credits when the bound product is purchased | Name, description, amount, optional expiry in days |

Credit benefits are always business-scoped and one-time purchased. When an order is paid, billing automatically grants the credits to the customer — no fulfillment code is needed.

## Space credits and Cohub Balance

Space credits and Cohub Balance serve different purposes:

| Value | Scope | Intended use |
|---|---|---|
| Space credits | The selling Space | Meter actions inside the Space's Apps |
| Cohub Balance | Global | Pay for eligible Cohub usage across Spaces |

A product can include one platform-managed Cohub Balance component. The owner only chooses a whole-dollar `cohubBalanceUsd`; Cohub owns the underlying token type, scope, grant kind, and Benefit key.

V1 rules:

- `cohubBalanceUsd` must be a whole number of at least `$1`.
- The product price must be at least the Balance amount at creation time.
- Platform discounts, coupons, and redemptions may reduce the paid amount freely, including below the Balance amount. The buyer still receives the full Balance and the platform absorbs the difference.
- Product price and Cohub Balance are immutable after creation. Create a new product to change either value.
- A product can include at most one Cohub Balance component.
- Billing is the only source of truth. Cohub stores no local copy of the Balance grant and performs no automatic payout in V1; reconciliation reads the authoritative Billing order.
- V1 records the owner gross allocation in Billing for audit but does not pay it out automatically.

Create a product with Cohub Balance through the CLI:

```bash
cohub spaces commerce products create \
  --space <space-id> \
  --name "Creator Pack" \
  --amount-usd 8 \
  --cohub-balance-usd 5
```

The same field is available as `cohubBalanceUsd` in `spaces.commerce.createProduct()`.

## Minimal closed loop

The smallest self-contained commerce flow has four states: **load → gate → purchase → return**. Feature benefits stop at "unlocked". Credit benefits add a fifth state: **consume**, which loops back to "purchase" when credits run out.

### Feature unlock loop

```
load → check entitlement → [unlocked? done] → [locked? purchase] → checkout redirect → return → load
```

### Credit consumption loop

```
load → check balance → [has credits? consume] → [empty? purchase] → checkout redirect → return → load
```

## Runtime flow

1. The App calls `cohub.app.commerce.resolveProducts()`.
2. The App calls `cohub.app.commerce.getEntitlements()` — returns feature entitlements **and** credit balance in one call.
3. The user clicks Buy.
4. The App calls `cohub.app.commerce.purchase()` from the user's purchase action.
5. The outer host creates the order with a stable purchase attempt ID and immediately redirects to checkout. Retries of the same attempt resolve to the original Billing order. The purchase call must not run automatically during app initialization.
6. The provider returns to the Work public URL with `cohub_checkout` and, when available, `cohub_order`.
7. The App calls `cohub.app.commerce.getCheckoutState()`.
8. If an `orderId` is available, the App calls `cohub.app.commerce.getOrder(orderId)`.

## Consuming credits

When a user performs a metered action inside the App, credits are consumed through `cohub.app.commerce.consumeCredits()`:

```ts
const result = await cohub.app.commerce.consumeCredits({
  amount: 10,
  operationId: crypto.randomUUID(),
  reason: "Export high-res image",
});
// result.status: "consumed" | "insufficient" | "disabled"
// result.remaining: current credit balance
```

- `operationId` is an idempotency key — reuse it to safely retry without double-charging.
- When `status` is `"insufficient"`, the user has no remaining credits — prompt them to purchase.
- The CLI can also consume credits on behalf of a viewer (self by default, or via prompt-driven flows):

```bash
cohub apps commerce credits consume --app-id <app-id> --amount 100
```

## Why order state is handled this way

`purchase()` returns an order id before redirect.

The outer host is the right place to keep the pending purchase state because it controls:

- sign-in
- top-level navigation
- redirect return
- iframe bridge

The iframe should not be the primary place that owns pending checkout state.

Best practice:

- let the outer host cache the most recent pending order id for the current app
- let the App ask the host for checkout state
- let the App query the order again by id when it needs authoritative follow-up state

## Recommended App-side API usage

### Feature unlock

```ts
const cohub = createCohubClient();
const PRODUCT_KEY = "pro_unlock";
const BENEFIT_KEY = "space_pro";

const { products } = await cohub.app.commerce.resolveProducts({
  productKeys: [PRODUCT_KEY],
});

const { entitlements } = await cohub.app.commerce.getEntitlements();
const unlocked = entitlements.some((e) => e.benefitKey === BENEFIT_KEY && e.enabled);

if (!unlocked) {
  await cohub.app.commerce.purchase({ productKey: PRODUCT_KEY });
  // host redirects to checkout, then returns
}

const checkoutState = await cohub.app.commerce.getCheckoutState();
if (checkoutState.orderId) {
  const { order } = await cohub.app.commerce.getOrder(checkoutState.orderId);
}
```

### Credit consumption

```ts
const cohub = createCohubClient();
const CREDIT_PRODUCT_KEY = "credit_pack";

// 1. Check balance
const { credits } = await cohub.app.commerce.getEntitlements();

// 2. Consume for a metered action
if (credits.available > 0) {
  const result = await cohub.app.commerce.consumeCredits({
    amount: 10,
    operationId: crypto.randomUUID(),
    reason: "Export high-res image",
  });
  if (result.status === "insufficient") {
    // Balance changed between check and consume — prompt purchase
    await cohub.app.commerce.purchase({ productKey: CREDIT_PRODUCT_KEY });
  }
} else {
  // 3. No credits — prompt purchase
  await cohub.app.commerce.purchase({ productKey: CREDIT_PRODUCT_KEY });
  // host redirects to checkout, then returns
}

// 4. After checkout return, re-check balance
const { credits: updated } = await cohub.app.commerce.getEntitlements();
```

## Price changes

Product prices are immutable after creation — `updateProduct` does not accept `amountUsd`. To change a price, create a new product with a versioned key (e.g. `image_credit_pack_050`), bind the same benefit, update the Work to use the new key, then set the old product to `private` or `archived`. Treat commerce config as a migration, not mutable state.

## Script-backed commerce actions

For expensive metered actions, run the real work in a script and keep the Work as a thin front-end. The Work sends a prompt, the agent consumes credits and writes results to a Space file, then the Work reads the structured result back — instead of parsing chat turns.

```
Work → space.prompt("!script") → agent consumes credits, runs action, writes result file
Work → space.files.read(resultPath) → render structured result
```

Keep the App responsible for displaying products and balances, initiating purchases, and triggering metered actions. Put side effects in the script and persist raw results to Space files.

## Best practices

- Use versioned product keys to manage price and tier changes.
- Keep the App responsible for display, purchase, and triggering metered actions — not for side-effect execution.
- Run side effects in scripts and persist raw results to Space files; the Work reads structured results.
- Use the smallest permission set the App needs.
- Always pass a unique `operationId` to `consumeCredits()` for idempotent retries.

## Demo

See:

- `cohub-apps/app-capability-lab/commerce-demo.md`
