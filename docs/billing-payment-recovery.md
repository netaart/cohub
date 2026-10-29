# Billing payment recovery

This candidate connects Cohub to Billing's existing subscription recovery policy.
Billing owns paid periods, grace deadlines, close confirmation and purchase
admission. Cohub displays its `renewal_recovery` summary without treating
`past_due`, a return URL or cancellation HTTP success as paid access.

- Catalog and settings share one current-plan selection: valid grace stays on the
  paid plan with a payment-due label, and closing shows processing rather than free
  or paid-active. The purchase panel leads with “Continue payment” and a quiet
  “Subscribe again” action. It shows the feature deadline and credits-after-payment
  promise, without a new-purchase quote that could be mistaken for the amount due.
  Processing hides purchase actions, checks the result up to five times, and only
  shows a compact recheck action after an unresolved result or failure. Focus
  refresh remains available. Confirmation reuses the existing Dialog; ending the
  plan still requires a separate purchase click at the current price.
  Feature decisions still use the entitlement API; balance remains Credits-based.
  A finite feature result expires locally and is refreshed at its deadline.
- The payment action fetches a fresh, owner-checked Hosted Invoice URL with
  `Cache-Control: no-store`. It is not stored in Catalog or purchase context.
- Ending recovery uses the existing cancellation endpoint. The selected plan and
  old subscription ID survive reload in user-scoped session storage. Once a fresh
  inspect confirms `ended` and purchase eligibility, the user reviews current
  pricing and clicks the ordinary subscription button. If the original payment
  wins, the paid cycle stays active and no new create occurs. Explicitly accepted
  cancellation follows Billing's period-end cancellation result.
- One-time Checkout keeps a UUID purchase identity and immutable create request
  across network failures. A usable original Checkout resumes. Only an explicit
  expired/canceled unpaid result clears the current attempt and asks for a new
  price confirmation. A conflict or unknown result cannot auto-start a new Order.
  Returns resolve the exact user/purchase/Order identity, so an older return cannot
  clear a later purchase of the same product. Storage is isolated per browser tab.

The local integration uses the candidate Billing SDK artifact, local Billing and
a disposable database. Browser testing mounts the real purchase components and
Cohub billing router with a test-only authentication fixture; it does not verify a
production Logto session. Stripe account/payment evidence is recorded separately
in the Billing P7 acceptance record. Temporary test routes are removed from the
candidate. No deployed environment, SDK publication or Stripe recovery setting is
changed by this source delivery.

Local acceptance on 2026-10-29 used the real Cohub Billing router and real purchase
components against the candidate Billing API, with a temporary local test identity:

- Grace was visible on desktop/mobile, with zero new Credits and an enabled Feature
  from `subscription_grace`. A real scheduled Stripe retry then produced active
  state and the original renewed cycle; reloading the component removed recovery
  actions. Provider Test Clock and local page wall-clock evidence remain separate.
- Explicit end recovery closed the original Invoice and Subscription. Reloading
  before the next purchase preserved selection and created no extra Subscription.
  Only the following purchase click created the new unpaid Checkout. Leaving it
  did not restore the old grace. Exact inspection offers the same new Checkout for
  resumption instead of creating another one.
- A prepared browser intent for the already-recovered subscription was cleared
  after a real inspection returned `subscribe.reason=paid_coverage_active`; the
  UI retained paid access and did not create a replacement.

The provider suite passed 42 tests; the purchase context regression passed, and
Billing/API/SDK type checks plus the Web check (0 errors/0 warnings), changed-file
Biome and Changeset status passed. The temporary UI route and authentication
server are not part of this commit. Full production-auth acceptance and deployment
are separate from these scoped local consumer checks.
- Actual one-time consumer inspection distinguished the original expired Order
  (`canRestart=true`, no URL) from the newly paid Order (`settled=true`,
  `canRestart=false`). This read used the real Cohub provider and SDK against the
  same local Billing facts accepted from signed Stripe events.

New ordinary purchases also persist their purchase ID and a normalized request
hash in the existing immutable Order/Subscription Meta. A retry resolves the
exact owned resource before checking current prices, Discounts or active
subscription admission. Thus a successful create with a lost response still
returns its original receipt after the offer is consumed or the subscription
becomes active. Multiple matches or a changed intent fail closed. Wallet and
legacy purchases retain their existing path. No recovery relation or new storage
resource was introduced. A previously unresolved browser attempt retains its
identity even if a later response reports a changed offer; only a clearly rejected
first attempt may discard that key. The regression exercises both paid Order and
active Subscription receipts after simulated response loss. In-process request
coalescing uses the same complete fingerprint, including the return URL; changed
concurrent requests retain the same Billing idempotency key and are rejected
instead of sharing the first request's result or creating a second resource.

The subsequent customer-facing UI pass keeps recovery terminology out of the
purchase flow. Its existing Web regression covers current-plan selection across
valid grace, the deadline, closing, successful payment and confirmed end; the
Web check reports zero errors and warnings. Desktop/mobile screenshots replay
saved Sandbox facts through the actual current components with all business
actions disabled. They verify presentation and confirmation wording, not a new
Provider transaction.
