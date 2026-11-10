---
"@neta-art/cohub": major
"@neta-art/cohub-cli": major
---

Balance activity now reaches your full history and loads quickly at any depth. Previously the history stopped after the newest ~2,000 entries, and every page took about a second. `billing.getBalanceActivities({ cursor, limit, filter })` reads newest first, up to 100 entries per page (50 by default), and returns `nextCursor` until the end; `filter` narrows to `usage`, `grant`, or `refund`. Activities also carry `usageType`. `space(id).wallet.activities(cursor)` pages the same way and returns `{ items, nextCursor }`.

`billing.getCredits()` lists only credit sources that can still be spent; pass `{ includeExhausted: true }` to also list depleted and expired ones.

`cohub me billing` shows your balance, current plan, and credits expiring soon. `cohub me billing-activity` and `cohub spaces wallet activity` take `--cursor` (plus `--filter` and `--limit` for personal activity) instead of `--page`.

Migrate `getBalanceActivities({ page })` to follow `activities.nextCursor`, and `wallet.activities(page)` to pass the previous `nextCursor`. `BillingBalanceActivityList.page` and `pagination` are removed. Servers still answer page-number requests from older SDKs for the newest 2,000 activities.
