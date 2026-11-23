---
"@neta-art/cohub-cli": minor
"@neta-art/cohub": minor
---

Add pricing offers and quotas: model listings carry the caller's `offer` and generation models a `quota`, `billing.getQuotas()` returns quota balances, and generation billing reports quota coverage. `cohub models ls` shows an Offer column and `cohub generate` prints quota coverage.
