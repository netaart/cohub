import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import * as schema from "@cohub/db";
import {
  createNotifier,
  deliverNotification,
  readNotificationSummary,
  registerPushTarget,
  turnNotifications,
  updateNotificationPreferences,
  type NotificationDb,
} from "@cohub/core/notifications";
import type { PushSender } from "@cohub/infra/notifications";
import type { NotificationChangedEvent } from "@cohub/protocol/realtime";
import { drizzle } from "drizzle-orm/pglite";

process.env.LOG_LEVEL = "silent";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const client = new PGlite({ extensions: { pg_trgm } });
const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
for (const entry of journal.entries) {
  await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
}
const db = drizzle(client, { schema }) as unknown as NotificationDb;

const events: NotificationChangedEvent[] = [];
const delivered: string[] = [];
const notifier = createNotifier({
  db,
  publish: async (event) => events.push(event),
  deliver: async (rows) => delivered.push(...rows.map((row) => `${row.id}:${row.revision}`)),
});

const query = <T>(sql: string, params: unknown[] = []) => client.query<T>(sql, params).then((result) => result.rows);

async function user(uuid: string, options: { email?: string; locale?: string } = {}) {
  await query(`INSERT INTO v2.user_profiles (user_uuid, logto_user_id, display_name, email, locale, source) VALUES ($1, $1, $1, $2, $3, '{}')`, [uuid, options.email ?? null, options.locale ?? null]);
}

async function space(owner: string, members: Record<string, string> = {}) {
  const [row] = await query<{ id: string }>(`INSERT INTO v2.spaces (user_uuid, name) VALUES ($1, gen_random_uuid()::text) RETURNING id`, [owner]);
  assert.ok(row);
  for (const [userId, role] of Object.entries({ [owner]: "host", ...members })) {
    await query(`INSERT INTO v2.space_members (space_id, user_id, role, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)`, [row.id, userId, role, owner]);
  }
  const [session] = await query<{ id: string }>(`INSERT INTO v2.space_sessions (space_id, user_uuid, title) VALUES ($1, $2, 'Launch plan') RETURNING id`, [row.id, owner]);
  assert.ok(session);
  return { spaceId: row.id, sessionId: session.id };
}

let sequence = 0;
async function turn(sessionId: string, author: string, text: string, status = "completed", meta: Record<string, unknown> = {}) {
  sequence += 1;
  const [row] = await query<{ id: string }>(
    `INSERT INTO v2.session_turns (session_id, user_uuid, sequence, status, user_content, user_text, meta, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1200) RETURNING id`,
    [sessionId, author, sequence, status, JSON.stringify([{ type: "text", text }]), text, JSON.stringify(meta)],
  );
  assert.ok(row);
  return row.id;
}

await user("alice", { email: "alice@example.com", locale: "zh-CN" });
await user("bob", { email: "bob@example.com" });
await user("carol");
const { sessionId } = await space("alice", { bob: "builder" });

test("a finished turn notifies its author once per session, merging later turns", async () => {
  const first = await turn(sessionId, "alice", "Draft the launch post");
  await notifier.notify(await turnNotifications(db, { turnId: first, event: "settled" }));
  const second = await turn(sessionId, "alice", "Now shorten it", "failed");
  const [record] = await notifier.notify(await turnNotifications(db, { turnId: second, event: "settled" }));

  assert.equal(record?.kind, "turn.finished");
  assert.equal(record?.count, 2);
  assert.equal(record?.revision, 2);
  assert.equal(record?.turnId, second);
  assert.equal(record?.kind === "turn.finished" && record.payload.status, "failed");
  assert.equal(record?.kind === "turn.finished" && record.payload.sessionTitle, "Launch plan");
  assert.deepEqual((await readNotificationSummary(db, "alice")).byCategory.activity, 1);
  assert.equal(events.at(-1)?.payload.summary.unread, 1);
  assert.deepEqual(events.at(-1)?.rooms, ["user:alice"]);
});

test("mentions reach people who can open the session, never the author", async () => {
  const mentioning = await turn(sessionId, "alice", "@[Bob](cohub://users/bob) and @[Carol](cohub://users/carol), see @[Alice](cohub://users/alice)", "queued");
  const items = await turnNotifications(db, { turnId: mentioning, event: "written" });
  assert.deepEqual(items.map((item) => item.recipientId), ["bob"]);
  const [record] = await notifier.notify(items);
  assert.equal(record?.kind, "mention.user");
  assert.equal(record?.actors[0]?.userUuid, "alice");
  assert.equal(record?.kind === "mention.user" && record.payload.preview, "@Bob and @Carol, see @Alice");
});

test("push skips visible devices, drops dead addresses, and waits out stale revisions", async () => {
  await registerPushTarget(db, "bob", { deviceId: "phone-0001", transport: "webpush", token: "https://push.example/phone", keys: { p256dh: "k", auth: "a" } });
  await registerPushTarget(db, "bob", { deviceId: "laptop-001", transport: "webpush", token: "https://push.example/laptop", keys: { p256dh: "k", auth: "a" } });
  await registerPushTarget(db, "bob", { deviceId: "tablet-001", transport: "webpush", token: "https://push.example/gone", keys: { p256dh: "k", auth: "a" } });
  await registerPushTarget(db, "bob", { deviceId: "watch-0001", transport: "webpush", token: "https://push.example/flaky", keys: { p256dh: "k", auth: "a" } });
  const sent: string[] = [];
  const sender: PushSender = async (target, message) => {
    sent.push(`${target.token}|${message.title}`);
    return target.token.endsWith("/gone") ? "gone" : target.token.endsWith("/flaky") ? "retry" : "ok";
  };
  const [row] = await query<{ id: string; revision: number }>(`SELECT id, revision FROM v2.notifications WHERE recipient_id = 'bob'`);
  assert.ok(row);
  const scheduled: string[] = [];
  const deps = {
    db,
    senders: { webpush: sender },
    visibleDevices: async () => new Set(["laptop-001"]),
    scheduleEmail: async (userId: string) => scheduled.push(userId),
  };

  assert.deepEqual(await deliverNotification(deps, { notificationId: row.id, revision: row.revision + 1 }), { pushed: 0, retryTargetIds: [] });
  const result = await deliverNotification(deps, { notificationId: row.id, revision: row.revision });
  assert.equal(result.pushed, 1);
  assert.deepEqual(sent.sort(), ["https://push.example/flaky|alice mentioned you", "https://push.example/gone|alice mentioned you", "https://push.example/phone|alice mentioned you"]);
  assert.deepEqual(scheduled, ["bob"]);
  assert.equal(result.retryTargetIds.length, 1);
  sent.length = 0;
  await deliverNotification(deps, { notificationId: row.id, revision: row.revision, targetIds: result.retryTargetIds, attempt: 1 });
  assert.deepEqual(sent, ["https://push.example/flaky|alice mentioned you"]);
  assert.deepEqual(scheduled, ["bob"]);
  const [gone] = await query<{ disabled: boolean }>(`SELECT disabled_at IS NOT NULL AS disabled FROM v2.push_targets WHERE token = 'https://push.example/gone'`);
  assert.equal(gone?.disabled, true);

  await Promise.all([
    updateNotificationPreferences(db, "bob", { categories: { mention: { push: false } } }),
    updateNotificationPreferences(db, "bob", { categories: { mention: { email: true } } }),
  ]);
  const prefs = await updateNotificationPreferences(db, "bob", { categories: {} });
  assert.deepEqual(prefs.categories.mention, { push: false, email: true });
  sent.length = 0;
  await deliverNotification(deps, { notificationId: row.id, revision: row.revision });
  assert.deepEqual(sent, []);
});
