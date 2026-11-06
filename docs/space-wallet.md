# Space wallet

Space wallets fund Cohub usage independently of Space Commerce. This integration adds **no Cohub database tables, columns, or migrations**. Billing remains the source of truth for customers, orders, balances, and usage transactions.

## Behavior

- Signed-in users with `space.view` can fund the wallet. When the host turns on **public funding** (`meta.publicProfile.fundingEnabled`), anyone signed in can, from the shared `/spaces/:id/fund` page or the **Fund** button on the Space's published Apps. Balance and activity stay restricted to `space.view`. Funding grants no additional access.
- One set of tiers (the wallet catalog products, e.g. $10 · $50 · $200 · $1,000, with no bonus credits) serves both payment paths. Balance pays first when the contributor's transferable balance covers the tier; otherwise the tier goes to online checkout. A whole-dollar custom amount ($1–$5,000) is balance-only. There are no split payments.
- The customer identity is deterministically `cohub:space-wallet:<spaceId>`. Customers are created only when starting recharge, not while browsing balances or charging unrelated personal usage.
- At settlement, actual usage cost is checked against the Space balance and consume preview. If sufficient, Space pays the whole charge; otherwise the original user pays the whole charge. No split payments.
- Personal entitlements and model discounts are unchanged. Withdrawals are not supported; balance transfers are described below.
- When the wallet business is unconfigured, usage follows the original personal billing path with no wallet lookups or additional database reads/writes. The wallet UI remains visible with an unavailable recharge message.

## Configuration

Set `TALESOFAI_BILLING_SPACE_WALLET_BUSINESS_KEY` identically on API, agent, task worker, and system worker. It shares the existing provider URL and Admin key, but must differ from `TALESOFAI_BILLING_BUSINESS_KEY`. Missing/same-business configuration disables wallet operations without disabling personal billing.

The agent only receives the wallet business key to stamp new-message eligibility; it needs no billing Admin credentials. The deployment template injects this optional key explicitly. API and workers retain the full billing connection configuration.

Provision one shared business for all Space wallets, not one per Space. Recommended key: `cohub_space_wallet`; display name: **Cohub Space Wallet**.

- No default plan or automatic enrollment. Keep the personal business's default plan unchanged.
- Create public, active, one-time recharge products with `meta.appName = "cohub"`.
- Bind business-scoped, purchased `usd_micro_cent` Benefits. Set `meta.display.credit_benefit_keys` to the actual bound Benefit keys for the existing catalog adapter. Reuse commercial specifications, not Product rows across businesses.
- Verify payment routing, callbacks, refunds, and any business-scoped webhook subscriptions separately for this business.
- Keep wallet identities out of personal referrals, subscriptions, redemption and global grant workflows.
- For balance transfers, create active **manual**, business-scoped, non-expiring `usd_micro_cent` credit Benefits whose keys start with `space_wallet_transfer_`, one per whole-dollar denomination: $1, $2, $5, $10, $20, $50, $100, $200, $500, $1,000. The wallet only accepts manual credits under this prefix.
- The Admin key needs consume-reversal, consumption-read, and credit-grant permissions (Billing SDK ≥ 1.31.0).

The provider can consume global grants as well as current-business grants. Wallet use requires reported global availability of zero and no currently usable non-purchased grants. Missing global information is unsupported, not assumed zero. The same validation runs before checkout and payer selection. It uses the existing balance query; Cohub never revokes default grants to make a wallet usable.

Do not rename or switch a funded wallet business as a configuration-only migration. Without a local mapping, the configured business is authoritative; another key points at another ledger, not a transfer of old funds. Keep all service instances consistent. Drain billing work and investigate ambiguous debits before enabling, disabling, or switching this configuration.

## Charging and retries

`packages/core/src/space-wallet` contains the shared API/worker route. It stores no payer selection or charge result. Usage keeps existing `source_id`, `operation_id`, `usage_type`, and provider idempotency keys. Billing transactions link usage to credit grants, and grants link back to recharge orders. Space-funded charges prefix `reason` with `actor_user_id=<encodeURIComponent(original user ID)>; `, followed by the original description within the provider's 1,024-character limit. Personal charges are unchanged. This records the actor without a new billing field; the wallet UI does not yet parse or display it, and historical entries are not backfilled.

Preview errors may fall back to personal billing **before a debit is attempted**. Once either payer's debit is issued with wallet routing enabled, failure/timeout is logged with operation, source, payer, business and amount; it returns skipped, never immediately debits the other account or schedules a rerouted billing retry.

API/agent stamp a `walletBillingEligible` boolean on new messages using configuration at creation; old messages and messages created before enablement retain personal routing, including incomplete historical processing. Already aggregated messages are not billed again. Session postprocessing atomically sets one `walletBillingAttempted` flag in the existing message Meta before attempting wallet-enabled billing. It records no payer, amount, or result; duplicate new jobs and crash recovery cannot claim it twice. A crash after claiming may leave usage uncharged. The flag is honored even if wallet configuration is subsequently disabled.

Wallet-enabled generation retries (including stalled recovery, detected through BullMQ `attemptsStarted`) and explicit billing retry jobs skip charging instead of selecting a new payer. Personal retries remain unchanged when wallet routing is disabled. This intentionally accepts potentially uncollected usage and manual investigation in exchange for not introducing durable routing state or a recovery subsystem. Re-enqueuing an operation as a fresh job, replaying it outside these guarded retry paths, or changing configuration across attempts is **not** protected by a durable payer decision. Operators must not blindly replay ambiguous charges.

Local preview/debit pairs are serialized per Space, but cross-process concurrency, expiry or refunds can still cause wallet overage. Such results are logged and never followed by a second personal debit. Strict no-overage and arbitrary cross-account replay safety require future provider support.

Empty balances have a bounded five-second process cache. Positive balances are refreshed before selection. Recharge confirmation clears the local negative cache; other instances converge within five seconds. No new table or local billing ledger is introduced. Only wallet-enabled message attempts update the existing message Meta flag.

## Balance transfers

A transfer moves **purchased** personal balance into a wallet. It needs no Cohub table: every ledger entry is keyed by IDs derived from the Space and a client request UUID, so Billing alone answers what happened.

| Step | Account | Billing identity |
| --- | --- | --- |
| Debit | personal | usage type `space_wallet.transfer`, source `cohub:swt:<spaceId>:<id>`, operation `swt:<spaceId>:<id>:debit`, reason `Transfer to Space wallet "<name>"` |
| Credit | wallet | same source, operation `swt:<spaceId>:<id>:credit:<n>` per denomination, reason `actor_user_id=…; Contribution from @user` |
| Refund | personal | consume reversal of the debit, operation `swt:<spaceId>:<id>:refund`, reason `Returned from Space wallet "<name>"` |

- **Transferable balance** is `min(remaining one-time purchased credits, lifetime purchased − net transferred, net balance)`. Billing spends free credits first, so the second bound keeps free credits from leaking into wallets; bonus credits bundled with a purchase count as purchased. Subscription credits are not transferable.
- Before money moves, the API checks the amount, allowance, denominations, wallet usability and a consume preview, then takes a per-user Redis lock (released on completion; 5 min TTL for crashed holders). Only a direct user session may transfer; agent execution tokens and App sessions cannot.
- Before the debit, the API durably queues a delayed `space_wallet.transfer.recover` system job (60 s delay, 9 attempts, exponential backoff from 30 s). If queueing fails, no money moves. Denominations are then granted in order (largest first); a failure returns `processing` and the job finishes it, as it would after a crash at any point. Each run plans only the amount beyond the landed grant prefix, at the next indices, so denomination changes between attempts cannot over- or under-credit. The first 6 attempts (≈16 min) credit; the remaining attempts, or any permanent error, refund only the uncredited remainder by reversing the debit back to its original credits (types and expiry preserved). A debit not fully covered by credits (overage, detected from its ledger transactions) is always reversed, never credited. Each grant and reversal first re-checks lock ownership; recovery waits briefly for a busy lock instead of spending an attempt. Once a reversal exists nothing credits that transfer again. Recovery of a completed transfer is a read-only no-op; a missing debit is re-checked on the next two attempts in case a timed-out debit lands late. Transaction totals used for allowance and coverage fail closed if the history exceeds 2,000 rows.
- Retrying with the same request UUID resumes the same transfer; a different amount under that ID is rejected. `GET /transfers/:id` derives `completed | processing | refunded | none` from Billing.
- If every attempt fails, the job logs `Space wallet transfer unrecovered` at error level with `spaceId`, `transferId` and `userId`; re-enqueue the job with those values once Billing is healthy. It is safe to repeat. There is no standing sweep.

## Orders, activity and UI

Recharge passes the contributor, Space, and request UUID in billing order `meta`, with a stable provider idempotency key. Checkout returns to the page it started from (`returnPath`, same-origin only) with `wallet_order`/`wallet_space`; a global handler confirms the order and strips the parameters. Confirmation queries billing orders by business, customer and those Meta fields, then validates their ownership. There is no local order mapping. A missing order is not treated as settled; retry checkout creation with the same request UUID after an interrupted response.

Activity uses provider-paginated raw credit transactions: each page fetches only that provider page, not all history. Consume and historical-overage settlement entries show actual funded debits; unbacked debt is not a balance movement and is not listed separately. One usage operation can appear as several grant-bucket entries with the same operation/source ID; adjacent denomination grants of one transfer are merged into a single row. `actorUserId` is parsed from the `actor_user_id=` reason prefix (transfers and Space-funded usage); online orders show no actor. Avoid per-row order/message requests just to render a name. The personal activity view labels transfer debits and refunds by their source/operation IDs and shows the Space name from the reason.

The page uses user-scoped server-data snapshots and refreshes on focus/visibility, every 30 seconds while visible (usage has no event), and on the `space.wallet.updated` Space event, published when a transfer settles or an order confirms. URL outcome parameters never establish payment success. No webhook consumer is added.

## API / SDK / CLI

Routes under `/api/spaces/:id/wallet`. *View* requires authentication and `space.view`; *fund* requires authentication and either `space.view` or public funding. `/funding` also answers anonymous visitors when public funding is on (without `transfer`).

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/` | view | Balance and usability |
| GET | `/catalog` | view | Supported recharge products |
| GET | `/activities?page=1` | view | Provider ledger activity |
| GET | `/funding` | fund | Space identity, tiers, checkout availability, caller's transferable balance |
| POST | `/orders` | fund | `{ id: UUID, productKey, returnPath? }`; reuse `id` on retries |
| GET | `/orders/:orderId` | fund | Confirmation by contributor's request UUID |
| POST | `/transfers` | fund, user session | `{ id: UUID, amountUsd }`; reuse `id` on retries |
| GET | `/transfers/:id` | fund | Transfer state derived from Billing |

Public funding is toggled with `PATCH /api/spaces/:id/profile { fundingEnabled }` (`space.edit`).

```ts
const wallet = client.space(spaceId).wallet;
await wallet.get();
await wallet.funding();
await wallet.transfer({ id: crypto.randomUUID(), amountUsd: 50 });
const { checkout, orderId } = await wallet.createOrder({ id: crypto.randomUUID(), productKey });
// Open checkout.checkoutUrl; orderId is the original request UUID.
await wallet.confirmOrder(orderId);
```

```bash
cohub -s SPACE spaces wallet balance
cohub -s SPACE spaces wallet funding
cohub -s SPACE spaces wallet transfer 50            # prints a retry command if the result is unknown
cohub -s SPACE spaces wallet transfer-status REQUEST_UUID
cohub -s SPACE spaces wallet recharge PRODUCT
cohub -s SPACE spaces wallet confirm REQUEST_UUID
cohub -s SPACE spaces wallet public-funding on
cohub -s SPACE spaces wallet activity --page 1 --json
```

## Verification

No wallet database migration is required. The two never-deployed prototype migrations and all three prototype tables were removed before release; no shared database or financial records were changed.

Focused regression tests retain whole-charge routing, disabled personal paths, no fallback after an ambiguous debit, atomic message replay protection, and refund-only-the-remainder transfer recovery. Authorized live payment, transfer and reversal verification remain deployment acceptance tasks.
