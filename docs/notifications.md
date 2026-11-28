# Notifications

One pipeline for everything that tells a person something happened: the inbox,
realtime, remote push and email.

```
producer ── enqueue ──► worker: notifications.turn
                          │ write (upsert) notifications      ← source of truth
                          ├─► realtime  notification.changed  (user:<id> room)
                          └─► notifications.deliver (+5 s)
                                ├─ push to devices not in front (Web Push, FCM; APNs later)
                                └─ notifications.email (+10 min, one digest per user)
```

Producers never write notifications themselves: they enqueue a job on the system
queue (`createTurnJobs` in `@cohub/infra/session-turn-settled`), and the worker
writes, publishes and delivers. Today there are two producers:

| Kind | When | Recipient | Group |
| --- | --- | --- | --- |
| `mention.user` | A prompt or note with `@[Name](cohub://users/<uuid>)` is written | Each mentioned user who can view the session, never the author | `mention:<turnId>` |
| `turn.finished` | A turn settles `completed` or `failed` | The user who submitted it; an agent's or automation's success is skipped | `turn:<sessionId>` |

The older `session.turn.notify` realtime event still goes to `user:<id>` on every
finalized turn; SDK consumers depend on it, so it stays alongside `turn.finished`.

Adding a kind: an entry in `NOTIFICATION_KINDS` (`packages/protocol/src/notifications.ts`)
with its payload type, a case in the web copy (`apps/web/src/lib/notifications/copy.ts`)
and in the server renderer (`packages/core/src/notifications/render.ts`), and a producer.

## Data

`v2.notifications` holds one row per recipient and group. A repeated event merges
into the row in one `INSERT … ON CONFLICT`: it returns to unread and to the top,
its actor moves to the front of `actor_ids`, `count` and `revision` go up. Rows
store render parameters (`payload`), never finished copy, so each surface renders
in its own language. Every index leads with `recipient_id`; the table can be
hash-partitioned by it without changes.

- Unread counts read a partial index (`read_at is null`) with a bounded scan; the UI
  shows 99+.
- `session.view` is checked once, when a row is written. A row stays in the inbox
  after access is lost; opening it shows what the session page shows to anyone else.
- `notification_preferences` stores only overrides of `NOTIFICATION_CATEGORY_DEFAULTS`,
  per category and channel, with room for space and session scopes.
- `notification_user_state` keeps per-user delivery cursors: the last emailed row,
  as `(updated_at, id)`.
- `push_targets` holds one row per push address, keyed by `(transport, token)`;
  re-registering moves it to the current account and device. Sign-out removes it.
- `user_profiles.email` mirrors the Logto primary email for delivery and is never
  part of a public profile. `scripts/backfill-user-profile-emails.ts` fills rows
  synced before the column existed.

## Delivery

A connection tells the gateway whether its device is in front (`device.state`); the
gateway keeps `notifications:visible-devices:<userId>` in Redis. Delivery skips
devices in front (they show the change in app), rows already read, and revisions
superseded by a later merge. The 5 s delay lets a client looking at the subject
mark it read first, so no push follows. Addresses that answer gone, or fail ten
times, are disabled.

Email collects everything unread since the last digest, in categories that want
email, into one message ten minutes after the first event. Links are signed with
`APP_ENCRYPTION_KEY`; `List-Unsubscribe-Post` gives one-click unsubscribe in mail
clients when `PUBLIC_API_ORIGIN` is set. A provider's permanent refusal is logged
as an error and the digest moves on; retrying it cannot help.

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

- **Web** (`apps/web/src/lib/notifications/`): the inbox is a `LiveList` per tab,
  first page and summary cached in IndexedDB, merged from `notification.changed`.
  Reads are optimistic. Opening a session reads its notifications; a change about
  the session in front is read at once instead of alerting. With remote push on
  this device the service worker shows system notifications; otherwise the page
  shows them while it is open and in the background.
- **Native shells**: Android with a Firebase project advertises `notifications.push`
  and answers `notifications.subscribe` with an FCM token (`cohubFcm*` Gradle
  properties). Desktop shells keep showing local notifications through
  `notifications.show`. iOS has no push yet; `apns` is a reserved transport, and
  the same bridge method will return its token.
- **CLI**: `cohub notifications [list|read|prefs]`.
- **SDK**: `client.notifications`.
