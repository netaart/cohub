# Notifications

A notification is a **notice**: one thing a person is told. Each recipient chooses,
per kind, which **channels** carry it: the inbox, push, and email. The channels are
independent; any of them can be on without the others.

```
producer ── enqueue ──► worker: notifications.turn
                          notify(items)  ← reads each recipient's channels once
                          ├─ inbox  → upsert inbox_items → inbox.changed
                          ├─ push   → notification.sent (realtime, in-app)
                          │           notifications.push (+5 s) → Web Push, FCM (APNs later)
                          └─ email  → outbox → notifications.email (+10 min, one digest per user)
```

Producers never notify anyone themselves: they enqueue a job on the system queue
(`createTurnJobs` in `@cohub/infra/session-turn-settled`), and the worker resolves
channels, writes, publishes and delivers. Today there are two kinds:

| Kind | When | Recipient | Group | Default channels |
| --- | --- | --- | --- | --- |
| `mention` | A prompt or note with `@[Name](cohub://users/<uuid>)` is written | Each mentioned user who can view the session, never the author | `mention:<turnId>` | inbox, push, email |
| `turn.finished` | A turn settles `completed` or `failed` | The user who submitted it; an agent's or automation's success is skipped | `turn:<sessionId>` | push |

A finished turn is already visible in the chat, so by default it only interrupts you
when you are away; turning its inbox channel on keeps a record, merged per session.

`session.turn.notify` is a separate realtime event that goes to `user:<id>` on every
finalized turn; it drives in-app activity and is not part of this pipeline.

Adding a kind: its payload in `NotificationPayloads` and its default channels in
`NOTIFICATION_DEFAULTS` (`packages/protocol/src/notifications.ts`), a case in the web
copy (`apps/web/src/lib/notifications/copy.ts`), the server renderer
(`packages/core/src/notifications/render.ts`) and the CLI, and a producer.

## Channels

- **Inbox** keeps the notice as an `inbox_items` row and publishes `inbox.changed`
  (upserts, reads, unread count) to the recipient's `user:<id>` room.
- **Push** publishes `notification.sent` so open clients can show it now, and
  schedules `notifications.push`. Web clients toast it and, when this device has no
  remote push, raise a local system notification once the page is in the background.
- **Email** appends the notice to the recipient's outbox
  (`notifications:email:<userId>` in Redis, newest 200 kept for 7 days) and schedules one
  digest job per user.

A notice kept in the inbox takes its item's id; otherwise its id is unique to it.
System notifications are tagged by `groupKey` (`notificationTag`), so a later notice
in the same group replaces the earlier one on screen and alerts again.

## Data

`v2.inbox_items` holds one row per recipient and group. A repeated event merges into
the row in one `INSERT … ON CONFLICT`: it returns to unread and to the top, its actor
moves to the front of `actor_ids`, `count` and `revision` go up. Rows store render
parameters (`payload`), never finished copy, so each surface renders in its own
language. Every index leads with `recipient_id`; the table can be hash-partitioned by
it without changes.

- Reads only return kinds this build knows (`NOTIFICATION_KINDS`): removing a kind
  needs no data migration. Clients drop unknown kinds the same way, including from
  their caches.
- Unread counts read a partial index (`read_at is null`) with a bounded scan; the UI
  shows 99+.
- `session.view` is checked once, when a notice is produced. An inbox item stays
  after access is lost; opening it shows what the session page shows to anyone else.
- `notification_preferences` stores only overrides of `NOTIFICATION_DEFAULTS`, per
  kind and channel, with room for space and session scopes. Overrides for unknown
  kinds or channels are ignored.
- `push_targets` holds one row per push address, keyed by `(transport, token)`;
  re-registering moves it to the current account and device. Sign-out removes it.
- `user_profiles.email` mirrors the Logto primary email for delivery and is never
  part of a public profile. `scripts/backfill-user-profile-emails.ts` fills rows
  synced before the column existed.

## Delivery

A connection tells the gateway whether its device is in front (`device.state`); the
gateway keeps `notifications:visible-devices:<userId>` in Redis. The 5 s push delay
lets a client looking at the subject absorb the notice first:

- Every push is dropped if its kind's push channel was turned off meanwhile.
- An inbox notice skips devices in front, and is dropped once its item is read or
  merged again (`revision`).
- A notice outside the inbox has no read state: it is dropped while any of the
  recipient's devices is in front, since the app already shows it.

Addresses that answer gone, or fail ten times, are disabled.

Each user gets at most one digest job per 10-minute window, run after the window
closes. It pops up to 20 outbox entries atomically, so concurrent digests never share
one; keeps the latest per notice, drops inbox items already read and kinds whose email
channel is now off, and sends one message. A digest that fails before sending puts its entries back.
Links are signed with `APP_ENCRYPTION_KEY`; `List-Unsubscribe-Post` gives one-click
unsubscribe in mail clients when `PUBLIC_API_ORIGIN` is set. A provider's permanent
refusal is logged as an error and the digest moves on; retrying it cannot help.

## Configuration

| Env | Where | Effect |
| --- | --- | --- |
| `EMAIL_URL` | API, worker | `resend://<key>`, `smtp://user:pass@host:587` (`smtps://` for TLS) or `log://`; unset turns email off |
| `EMAIL_FROM` | worker | Sender, e.g. `Cohub <notifications@example.com>` |
| `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` | API, worker | Browser and PWA push; `npx web-push generate-vapid-keys` |
| `FCM_SERVICE_ACCOUNT` | API, worker | Firebase service account JSON (raw or base64) for Android push |
| `PUBLIC_API_ORIGIN`, `WEB_ORIGIN` | worker | Unsubscribe endpoint and link targets in email |

`GET /api/notifications/config` tells clients which channels this deployment has.

## Clients

- **Web** (`apps/web/src/lib/notifications/`): the inbox (`inbox.svelte.ts`) is a
  `LiveList` with All and Unread views, first page and unread count cached in
  IndexedDB, merged from `inbox.changed`. Reads are optimistic; opening a session
  reads its items. Alerts (`alerts.svelte.ts`) follow `notification.sent` only: a
  notice about the session in front is absorbed (and read, if kept in the inbox)
  instead of alerting.
- **Native shells**: Android with a Firebase project advertises `notifications.push`
  and answers `notifications.subscribe` with an FCM token (`cohubFcm*` Gradle
  properties). Desktop shells show local notifications through `notifications.show`.
  iOS has no push yet; `apns` is a reserved transport, and the same bridge method
  will return its token.
- **CLI**: `cohub inbox [list|read]`, `cohub notifications prefs`.
- **SDK**: `client.inbox` (list, summary, read) and `client.notifications`
  (preferences, push targets, locale, config).
