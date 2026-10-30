# Billing payment recovery

Billing owns paid periods, grace deadlines, close confirmation and purchase
admission. Cohub uses its `renewal_recovery` summary; `past_due`, a return URL or
a successful cancellation request does not establish paid access. See the
[current Billing contract](https://git.talesofai.com/talesofai/talesofai-billing/src/branch/codex/stripe-recovery-p0/.agents/docs/current/stripe-payment-recovery.md).

Both direct consumers pin the registry-published
`@talesofai-billing/sdk@1.30.0-beta.0`. The lockfile contains its registry integrity;
no local SDK artifact is used.

## Purchase behavior

- Catalog and settings share the current-plan selection. Valid grace keeps the
  paid plan labeled payment due; closing is processing, not free or paid-active.
  Features remain governed by the entitlement API and expire locally at their
  deadline. Credits are not granted by the UI or extended by grace.
- The panel shows the feature deadline, credits-after-payment message, a primary
  Continue payment button and a bordered Choose a plan secondary button. A fresh,
  owner-checked Hosted Invoice action is fetched on demand with `no-store`; its
  URL is not saved. New-subscription quotes are hidden while recovery is pending.
- Choosing a plan uses the existing confirmation Dialog and cancellation API.
  Closure must be confirmed as `ended` with `subscribe.allowed` before the user
  reviews the current price and clicks to purchase a complete new period. A
  successful original payment preserves paid coverage instead of creating again.
- Independent Credits purchases remain available, including during closing.
  Selecting Credits neither overwrites the saved replacement-plan intent nor
  loses the selected pack when the catalog refreshes.
- Processing performs at most five automatic load/inspect checks, then offers a
  short explicit recheck. Focus refresh remains enabled. An unresolved Provider
  payment stays pending through stale local eligibility; paid coverage or a
  confirmed end clears it. Only an explicit recheck may fetch a new payment
  action, and a usable result clears waiting without automatic navigation.

## Purchase identity

Ordinary Checkout requests keep a UUID purchase ID and immutable request through
network failures. Cohub stores that ID and a normalized request hash in existing
Order/Subscription Meta. A retry inspects the exact owned resource before current
offer or subscription-admission checks. Same-ID intent changes and multiple
matches fail closed; in-process coalescing uses the same complete fingerprint.
Wallet and legacy purchases keep their existing path.

A usable Checkout resumes. Only a confirmed expired/canceled, unpaid resource
with a closed Provider Checkout clears the current attempt and asks the user to
review the price again. Unknown or conflicted results cannot start a new Order.
Browser context is scoped by user, product and purchase, isolated per tab. The
current-attempt index is separate from retained receipt identity so an old return
cannot clear a later purchase. Replacement-plan intent is separate from ordinary
Checkout context and survives reload; in-memory state covers unavailable storage.

## Validation boundaries

- Provider regressions cover lost responses, consumed offers, already-active
  subscriptions, changed concurrent intent, and strict restart eligibility.
  Web unit tests cover context ownership and plan selection; the existing native
  module-mock integration runner executes the compiled real PurchaseFlow for
  Credits selection across reloads and unresolved-payment convergence.
- Isolated Sandbox acceptance on 2026-10-29 verified automatic retry returning to
  the original paid cycle, explicit closure before a separately confirmed new
  Checkout, abandonment without restoring old grace, and exact expired/paid
  one-time Order inspection. Provider Test Clock and local wall time are separate.
- Desktop/mobile replays and a prepared paid-winner intent verify presentation
  and race handling; they do not constitute another Provider payment. Temporary
  routes and authentication harnesses are not part of the repository. Production
  Logto acceptance and deployment remain separate from these local checks.

Registry-based builds, type checks and tests are recorded on
[Cohub WIP PR #415](https://github.com/netaart/cohub/pull/415).
