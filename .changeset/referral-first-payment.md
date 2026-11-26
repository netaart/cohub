---
"@neta-art/cohub": major
"@neta-art/cohub-cli": major
---

Referral rewards now trigger on the invitee's first payment instead of their first conversation. Invitees have 30 days after joining to make it; joining no longer holds one of the inviter's 5 slots per cycle, and a slot is used only when a payment qualifies.

`ReferralDashboard.quota.reserved` is removed; read `summary.pending` for invitees still awaiting their first payment. `quota.claimHours` is replaced by `quota.paymentWindowDays`. `cohub referrals` prints `Awaiting first payment` instead of a pending count in the cycle line, and its `--json` output follows the new quota shape.
