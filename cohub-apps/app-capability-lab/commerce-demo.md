# App Commerce Demo

This demo shows the smallest recommended purchase and consumption flow inside a Cohub App.

## Best practice

The App commerce loop has two patterns. Both share the same setup, checkout, and return flow — they differ in what the App checks and what happens after purchase.

### Feature unlock pattern

1. Hardcode a known `productKey` and `benefitKey`.
2. Resolve product details through `cohub.app.commerce.resolveProducts()`.
3. Check viewer entitlements through `cohub.app.commerce.getEntitlements()`.
4. If not entitled, start checkout through `cohub.app.commerce.purchase()`.
5. Read the return state through `cohub.app.commerce.getCheckoutState()`.
6. If an `orderId` is present, query the order through `cohub.app.commerce.getOrder(orderId)`.

### Credit consumption pattern

1. Hardcode a known `productKey` for a credit pack.
2. Resolve product details through `cohub.app.commerce.resolveProducts()`.
3. Check credit balance through `cohub.app.commerce.getEntitlements()`.
4. If the user has credits, consume through `cohub.app.commerce.consumeCredits()`.
5. If `status` is `"insufficient"` or balance is zero, start checkout through `cohub.app.commerce.purchase()`.
6. Read the return state through `cohub.app.commerce.getCheckoutState()`.
7. Re-check balance — credits are granted automatically when the order is paid.

The outer host owns:

- sign-in
- checkout confirmation UI
- top-level redirect to the provider
- pending order cache
- return URL parsing

The App owns:

- product selection
- entitlement and credit balance display
- credit consumption
- order-specific post-checkout messaging

## Prepare with the CLI

Commerce is configured on the Space, then consumed by the App.

### Feature benefit setup

```bash
# Use -s or COHUB_SPACE_ID to target the Space.
cohub -s <space-id> spaces commerce setup

# Keys are generated from names: "Space Pro" -> space_pro, "Pro Unlock" -> pro_unlock.
cohub -s <space-id> spaces commerce benefits create \
  --name "Space Pro"

cohub -s <space-id> spaces commerce products create \
  --name "Pro Unlock" \
  --amount-usd 9.99 \
  --visibility public \
  --status active

cohub -s <space-id> spaces commerce bind \
  --product-key pro_unlock \
  --benefit-key space_pro
```

### Credit benefit setup

```bash
cohub -s <space-id> spaces commerce benefits create \
  --type credits \
  --name "500 Credits" \
  --amount 500 \
  --expires-in-days 365

cohub -s <space-id> spaces commerce products create \
  --name "Credit Pack" \
  --amount-usd 4.99 \
  --visibility public \
  --status active

cohub -s <space-id> spaces commerce bind \
  --product-key credit_pack \
  --benefit-key 500_credits
```

Useful inspection commands:

```bash
cohub -s <space-id> spaces commerce products list
cohub -s <space-id> spaces commerce benefits list
cohub -s <space-id> spaces commerce orders list --limit 10
```

## Operate a published App

Use the App commerce commands to test the full server-side flow. The CLI
command is `cohub apps`; `cohub works` remains as a deprecated alias.

```bash
# Resolve public products
cohub apps commerce products resolve \
  --app-id <app-id> \
  --product-key pro_unlock

# Feature: check entitlements
cohub apps commerce entitlements --app-id <app-id>

# Credits: check balance
cohub apps commerce entitlements --app-id <app-id>

# Credits: consume
cohub apps commerce credits consume \
  --app-id <app-id> \
  --amount 100 \
  --reason "High-res export"

# Purchase (feature or credits)
cohub apps commerce purchase \
  --app-id <app-id> \
  --product-key pro_unlock

# Order follow-up
cohub apps commerce orders get \
  --app-id <app-id> \
  --order-id <order-id>
```

## Minimal example: feature unlock

```html
<script type="module">
  const { createCohubClient } = await import("https://esm.sh/@neta-art/cohub?bundle&target=es2022");

  const cohub = createCohubClient();
  const PRODUCT_KEY = "pro_unlock";
  const BENEFIT_KEY = "space_pro";

  const productEl = document.getElementById("product");
  const statusEl = document.getElementById("status");
  const buyBtn = document.getElementById("buy");

  async function load() {
    const [{ products }, { entitlements }, checkoutState] = await Promise.all([
      cohub.app.commerce.resolveProducts({ productKeys: [PRODUCT_KEY] }),
      cohub.app.commerce.getEntitlements(),
      cohub.app.commerce.getCheckoutState(),
    ]);

    const product = products[0] ?? null;
    const entitled = entitlements.some((item) => item.benefitKey === BENEFIT_KEY && item.enabled);

    if (product) {
      productEl.textContent = `${product.name} · $${product.pricing.amountUsd.toFixed(2)}`;
    } else {
      productEl.textContent = "Product unavailable";
      buyBtn.disabled = true;
    }

    if (entitled) {
      statusEl.textContent = "Unlocked";
      buyBtn.disabled = true;
      buyBtn.textContent = "Already unlocked";
      return;
    }

    if (checkoutState.status && checkoutState.orderId) {
      const { order } = await cohub.app.commerce.getOrder(checkoutState.orderId);
      statusEl.textContent = `Checkout ${checkoutState.status} · ${order.status}`;
    } else if (checkoutState.status) {
      statusEl.textContent = `Checkout ${checkoutState.status}`;
    } else {
      statusEl.textContent = "Locked";
    }
  }

  buyBtn.onclick = async () => {
    buyBtn.disabled = true;
    try {
      const checkout = await cohub.app.commerce.purchase({ productKey: PRODUCT_KEY });
      if (!checkout?.checkoutUsable) {
        statusEl.textContent = checkout?.message ?? "Checkout unavailable";
      }
    } catch (error) {
      statusEl.textContent = error instanceof Error ? error.message : "Purchase failed";
    } finally {
      buyBtn.disabled = false;
    }
  };

  load().catch((error) => {
    statusEl.textContent = error instanceof Error ? error.message : "Failed to load";
  });
</script>

<div id="product">Loading…</div>
<div id="status">Loading…</div>
<button id="buy">Buy</button>
```

## Minimal example: credit consumption

```html
<script type="module">
  const { createCohubClient } = await import("https://esm.sh/@neta-art/cohub?bundle&target=es2022");

  const cohub = createCohubClient();
  const CREDIT_PRODUCT_KEY = "credit_pack";

  const balanceEl = document.getElementById("balance");
  const statusEl = document.getElementById("status");
  const actionBtn = document.getElementById("action");
  const buyBtn = document.getElementById("buy");

  async function load() {
    const [{ products }, { credits }, checkoutState] = await Promise.all([
      cohub.app.commerce.resolveProducts({ productKeys: [CREDIT_PRODUCT_KEY] }),
      cohub.app.commerce.getEntitlements(),
      cohub.app.commerce.getCheckoutState(),
    ]);

    const product = products[0] ?? null;
    balanceEl.textContent = `${credits.available} credits`;

    if (checkoutState.status && checkoutState.orderId) {
      const { order } = await cohub.app.commerce.getOrder(checkoutState.orderId);
      statusEl.textContent = order.status === "paid"
        ? "Credits added — refresh balance"
        : `Checkout ${checkoutState.status} · ${order.status}`;
    }

    actionBtn.disabled = credits.available <= 0;
    buyBtn.disabled = !product || credits.available > 0;
  }

  actionBtn.onclick = async () => {
    actionBtn.disabled = true;
    try {
      const result = await cohub.app.commerce.consumeCredits({
        amount: 10,
        operationId: crypto.randomUUID(),
        reason: "Export high-res image",
      });
      if (result.status === "consumed") {
        balanceEl.textContent = `${result.remaining} credits`;
        statusEl.textContent = "Consumed 10 credits";
      } else {
        statusEl.textContent = "Insufficient credits — buy a pack";
        buyBtn.disabled = false;
      }
    } catch (error) {
      statusEl.textContent = error instanceof Error ? error.message : "Consumption failed";
    } finally {
      actionBtn.disabled = false;
    }
  };

  buyBtn.onclick = async () => {
    buyBtn.disabled = true;
    try {
      const checkout = await cohub.app.commerce.purchase({ productKey: CREDIT_PRODUCT_KEY });
      if (!checkout?.checkoutUsable) {
        statusEl.textContent = checkout?.message ?? "Checkout unavailable";
        buyBtn.disabled = false;
      }
    } catch (error) {
      statusEl.textContent = error instanceof Error ? error.message : "Purchase failed";
      buyBtn.disabled = false;
    }
  };

  load().catch((error) => {
    statusEl.textContent = error instanceof Error ? error.message : "Failed to load";
  });
</script>

<div id="balance">Loading…</div>
<div id="status">Ready</div>
<button id="action">Export (10 credits)</button>
<button id="buy">Buy credits</button>
```

## Notes

- Do not cache order state only inside the iframe.
- Treat `purchase()` as a user action that may redirect away immediately.
- Treat `getCheckoutState()` as a transient signal from the outer host.
- Treat `getOrder(orderId)` as the authoritative order-specific follow-up check.
- Always pass a unique `operationId` to `consumeCredits()` for idempotent retries.
- After a credit pack purchase returns, re-check balance — credits are granted automatically on payment.
- Keep App copy simple and short.
- Keep Space setup explicit in scripts: use `-s <space-id>` or `COHUB_SPACE_ID`.
