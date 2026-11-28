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
  deliverPush,
  readInboxSummary,
  registerPushTarget,
  turnNotifications,
  type NotificationDb,
  type NotificationEvent,
} from "@cohub/core/notifications";
import type { PushSender } from "@cohub/infra/notifications";
import { notificationTag, type NotificationEmailEntry, type NotificationPushJobData } from "@cohub/protocol";
import { drizzle } from "drizzle-orm/pglite";

process.env.LOG_LEVEL = "silent";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const client = new PGlite({ extensions: { pg_trgm } });
const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
for (const entry of journal.entries) {
  await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
}
const db = drizzle(client, { schema }) as unknown as NotificationDb;

const events: NotificationEvent[] = [];
const pushes: NotificationPushJobData[] = [];
const outbox = new Map<string, NotificationEmailEntry[]>();
const notifier = createNotifier({
  db,
  publish: async (event) => events.push(event),
  push: async (jobs) => pushes.push(...jobs),
  email: async (entries) => {
    for (const { userId, entry } of entries) outbox.set(userId, [...(outbox.get(userId) ?? []), entry]);
  },
});

const query = <T>(sql: string, params: unknown[] = []) => client.query<T>(sql, params).then((result) => result.rows);

async function user(uuid: string) {
  await query(`INSERT INTO v2.user_profiles (user_uuid, logto_user_id, display_name, source) VALUES ($1, $1, $1, '{}')`, [uuid]);
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
async function turn(sessionId: string, author: string, text: string, status = "completed") {
  sequence += 1;
  const [row] = await query<{ id: string }>(
    `INSERT INTO v2.session_turns (session_id, user_uuid, sequence, status, user_content, user_text)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [sessionId, author, sequence, status, JSON.stringify([{ type: "text", text }]), text],
  );
  assert.ok(row);
  return row.id;
}

await user("alice");
await user("bob");
await user("carol");
const { sessionId } = await space("alice", { bob: "builder" });

test("each kind reaches the channels its recipient keeps on", async () => {
  const [first] = await notifier.notify(await turnNotifications(db, { turnId: await turn(sessionId, "alice", "Draft it"), event: "settled" }));
  const [next] = await notifier.notify(await turnNotifications(db, { turnId: await turn(sessionId, "alice", "Shorten it"), event: "settled" }));
  assert.equal(first?.inboxItem, null);
  assert.deepEqual(events.map((event) => event.type), ["notification.sent", "notification.sent"]);
  assert.deepEqual(pushes.map((job) => job.revision), [null, null]);
  assert.equal(next && notificationTag(next.notice), first && notificationTag(first.notice));
  assert.equal((await readInboxSummary(db, "alice")).unread, 0);

  const mentioning = await turn(sessionId, "alice", "@[Bob](cohub://users/bob) and @[Carol](cohub://users/carol)", "queued");
  const [mention] = await notifier.notify(await turnNotifications(db, { turnId: mentioning, event: "written" }));
  assert.equal(mention?.recipientId, "bob");
  assert.equal(mention?.notice.id, mention?.inboxItem?.id);
  assert.equal(mention?.notice.actors[0]?.userUuid, "alice");
  assert.deepEqual(outbox.get("bob")?.map((entry) => entry.inbox), [true]);
  assert.equal((await readInboxSummary(db, "bob")).unread, 1);
});

test("push skips devices in front, read items and dead addresses", async () => {
  for (const name of ["phone", "laptop", "gone"]) {
    await registerPushTarget(db, "bob", { deviceId: `${name}-device`, transport: "webpush", token: `https://push.example/${name}`, keys: { p256dh: "k", auth: "a" } });
  }
  const sent: string[] = [];
  const sender: PushSender = async (target) => {
    sent.push(target.token);
    return target.token.endsWith("/gone") ? "gone" : "ok";
  };
  const deps = { db, senders: { webpush: sender }, visibleDevices: async () => new Set(["laptop-device"]) };
  const job = pushes.at(-1);
  assert.ok(job?.revision);

  assert.equal((await deliverPush(deps, job)).pushed, 1);
  assert.deepEqual(sent.sort(), ["https://push.example/gone", "https://push.example/phone"]);
  sent.length = 0;
  await deliverPush(deps, { ...job, revision: null });
  assert.deepEqual(sent, []);
  await notifier.markRead("bob", { ids: [job.notice.id] });
  await deliverPush({ ...deps, visibleDevices: async () => new Set() }, job);
  assert.deepEqual(sent, []);
});
