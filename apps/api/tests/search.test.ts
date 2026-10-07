import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PgDialect } from "drizzle-orm/pg-core";
import { buildChatSearchQuery, toChatCandidates, type ChatSearchInput, type ChatSearchRow } from "../src/search/chats.js";
import { buildLabelSearchQuery, toLabelCandidates, type LabelSearchRow } from "../src/search/labels.js";
import type { SearchCandidate } from "../src/search/shared.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../drizzle/v2");
const viewer = "viewer";
const other = "other";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = { mine: id(1), member: id(2), public: id(3), private: id(4) };
const chat = {
  mine: id(11), member: id(21),
  publicForeign: id(31), publicMine: id(32), publicRevoked: id(33),
  privateHidden: id(41), privateShared: id(42),
};

async function database() {
  const client = new PGlite({ extensions: { pg_trgm } });
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) {
    await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  const spaces: Array<[string, string, string]> = [
    [space.mine, viewer, "Mine"], [space.member, other, "Team"], [space.public, other, "Public"], [space.private, other, "Private"],
  ];
  for (const [spaceId, owner, name] of spaces) {
    await client.query(`INSERT INTO v2.spaces (id, user_uuid, name) VALUES ($1, $2, $3)`, [spaceId, owner, name]);
  }
  await client.query(`INSERT INTO v2.space_members (space_id, user_id, role, created_by, updated_by) VALUES ($1, $2, 'builder', $3, $3)`, [space.member, viewer, other]);
  const policy = `INSERT INTO v2.access_policies (resource_type, resource_id, signed_in_user_role, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)`;
  await client.query(policy, ["space", space.public, "guest", other]);
  await client.query(policy, ["session", chat.publicRevoked, null, other]);
  await client.query(policy, ["session", chat.privateShared, "guest", other]);

  const participants = { participants: { userUuids: [viewer] } };
  const sessions: Array<[string, string, string, string, object | null]> = [
    [chat.mine, space.mine, viewer, "Deploy checklist", null],
    [chat.member, space.member, other, "Weekly notes", null],
    [chat.publicForeign, space.public, other, "Deploy guide", null],
    [chat.publicMine, space.public, viewer, "My deploy question", null],
    [chat.publicRevoked, space.public, other, "Revoked deploy", participants],
    [chat.privateHidden, space.private, other, "Secret deploy", participants],
    [chat.privateShared, space.private, other, "Shared deploy", participants],
  ];
  for (const [sessionId, spaceId, owner, title, meta] of sessions) {
    await client.query(
      `INSERT INTO v2.space_sessions (id, space_id, user_uuid, title, meta, last_message_at) VALUES ($1, $2, $3, $4, $5, now())`,
      [sessionId, spaceId, owner, title, meta],
    );
  }
  const turns: Array<[string, number, string]> = [
    [chat.mine, 1, "how do we deploy to prod?"],
    [chat.member, 1, "remember to\n\ndeploy the docs"],
  ];
  for (const [sessionId, sequence, text] of turns) {
    await client.query(
      `INSERT INTO v2.session_turns (session_id, sequence, user_content, user_text) VALUES ($1, $2, '[]'::jsonb, $3)`,
      [sessionId, sequence, text],
    );
  }
  const labelId = id(51);
  await client.query(
    `INSERT INTO v2.labels (id, scope_type, scope_id, name, slug) VALUES ($1, 'space', $2, 'bug', 'bug')`,
    [labelId, space.public],
  );
  for (const sessionId of [chat.publicForeign, chat.publicRevoked]) {
    await client.query(
      `INSERT INTO v2.label_assignments (label_id, scope_type, scope_id, resource_type, resource_ref) VALUES ($1, 'space', $2, 'session', $3)`,
      [labelId, space.public, sessionId],
    );
  }
  return client;
}

const clientPromise = database();
const dialect = new PgDialect();

async function searchChats(input: Partial<ChatSearchInput> & { query: string }) {
  const client = await clientPromise;
  const compiled = dialect.sqlToQuery(buildChatSearchQuery({ viewerUuid: viewer, spaceId: null, includeMessages: true, limit: 30, ...input }));
  const { rows } = await client.query<ChatSearchRow>(compiled.sql, compiled.params);
  return toChatCandidates(rows, input.query);
}

const byId = (candidates: SearchCandidate[]) => new Map(candidates.map((candidate) => [candidate.id, candidate]));

test("searches own and member Spaces plus chats the viewer joined elsewhere", async () => {
  const results = byId(await searchChats({ query: "deploy" }));
  assert.deepEqual(
    [...results.keys()].sort(),
    [chat.mine, chat.member, chat.publicMine, chat.privateShared].sort(),
    "foreign public chats, revoked sessions, and private Spaces stay out",
  );
  assert.equal(results.get(chat.mine)?.viewerTier, 0);
  assert.equal(results.get(chat.member)?.viewerTier, 1);
  assert.equal(results.get(chat.publicMine)?.viewerTier, 0);
  assert.equal(results.get(chat.privateShared)?.viewerRelation, "participant");
});

test("label items hide sessions whose own policy excludes outsiders", async () => {
  const client = await clientPromise;
  const compiled = dialect.sqlToQuery(
    buildLabelSearchQuery({ viewerUuid: viewer, query: "", labelRef: "bug", spaceId: null, limit: 30 }),
  );
  const { rows } = await client.query<LabelSearchRow>(compiled.sql, compiled.params);
  assert.deepEqual(toLabelCandidates(rows, "").map((item) => item.sessionId), [chat.publicForeign]);
});
