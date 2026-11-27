---
"@neta-art/cohub": minor
"@neta-art/cohub-cli": minor
---

Referral rewards now trigger on the invitee's first payment instead of their first conversation. Invitees have 30 days after joining to make it, and every qualifying payment is rewarded: the 5-per-cycle limit is gone.

`ReferralDashboard.quota`, `ReferralListItem.inCurrentCycle` and `PublicReferral.rewardAvailable` are removed; read `summary.pending` for invitees still awaiting their first payment and `reward.paymentWindowDays` for the window. `cohub referrals` prints `Awaiting first payment` instead of the cycle line.
