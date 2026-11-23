# Billing pricing rules

Campaigns, subscriber discounts, and usage quotas are data, not code. Operators publish one file in the platform config Space; Cohub matches each metered usage against it and charges accordingly. Self-hosted deployments without the file charge list price.

- File: `.cohub/billing/pricing.yaml` in the platform config Space, published to `/configs/platform/.cohub/billing/pricing.yaml`.
- Example: [`examples/billing-pricing.yaml`](examples/billing-pricing.yaml).
- Hot reload: API and worker re-read the file when it changes. An invalid edit is logged and the last valid rules keep serving (or none, if nothing valid was loaded yet), so a typo never blocks usage.

## Rules

```yaml
schema: cohub.billing.pricing.v1
rules:
  - key: video-launch          # stable id; recorded on charges and offers
    enabled: true              # default true; false returns to list price immediately
    announce: false            # default false; true surfaces the offer outside the model picker
    when:                      # every field is optional; all present fields must match
      usageTypes: [generation.video]   # exact, or a prefix such as generation.*
      models: [some-model]
      providers: [some-provider]
      benefits: [pro_plan]     # any held benefit key qualifies
      payer: personal          # personal | space_wallet
      startsAt: 2026-12-01T00:00:00+08:00
      endsAt: 2026-12-04T00:00:00+08:00
    effect:
      multiplier: 0.5          # or: quota: { tokenType, parameter }
```

Validation is strict: unknown fields, usage types outside `generation.*`, timestamps without an offset, duplicate keys, and multipliers outside `0..1` reject the whole file.

## How a usage is priced

1. Rules are matched at the moment the usage happened (the message, completion, decision, or generation request), not when it is charged, so retries and late processing keep the price the user saw.
2. The lowest multiplier wins; discounts never stack. Per-model benefit discounts (`pro_model_discount_v1`, `max_model_discount_v1` metadata) compete in the same pool for generation tasks.
3. Each charge is priced for both payers. Rules with `benefits` only price personal charges, so a Space wallet pays the campaign price without personal subscription discounts. A usage that personal benefits make free is never routed to a Space wallet.
4. A quota rule draws on the user's own balance of `tokenType` before any money is charged; one unit covers one unit of the request parameter (for example `duration` seconds). The uncovered share is charged at the discounted price. Quotas apply to generation tasks.

## Generation tasks

Generation requests are priced and quota is drawn at admission, then the snapshot rides in the task payload; the worker charges from it without re-pricing. Turning a rule off therefore affects new requests only.

Quota is drawn at admission rather than after success so concurrent requests and day boundaries cannot spend the same balance twice. Billing never refuses a consume, so any part the balance did not cover comes back as overage and is cancelled at once; tomorrow's grant never settles today's request. A failed, cancelled, or never-enqueued generation returns its quota. A refund after the grant expired lands on the expired grant and is not spendable.

## Billing service setup for quotas

Grant quota tokens from the billing service, not from Cohub. For a daily allowance, bind a credits benefit to the subscription product:

```yaml
type: credits
token_type: video_second
grant_kind: plan_period
grant_period: day
amount: 60
```

The business `period_timezone` decides when a day starts and when unused units expire. Cohub has no cron for quotas.

## Where it shows

- `GET /api/models` adds `offer: { multiplier, ruleKey, endsAt, announce }` to each model for the caller's personal price, and `quota: { tokenType, parameter }` to generation models a quota covers. Clients hide an offer at `endsAt` without refetching.
- `GET /api/billing/quotas` returns the caller's quota balances and grants in raw units.
- Charges append their pricing to the ledger reason, e.g. `Generation some-model [list=5;x=0.5;quota=6/10]`; list-price charges keep the plain reason.
- `cohub models ls` shows an Offer column; `cohub generate` reports quota coverage.
