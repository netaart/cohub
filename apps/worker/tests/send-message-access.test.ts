import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { accessPolicies, spaceMembers, spaceSessions } from "@cohub/db";
import { createDrizzlePermissionStore } from "@cohub/core/permissions";
import { createDelegatedPromptAuth } from "@cohub/core/sessions";
import { assertTaskPromptAccess } from "../src/tasks/send-message-auth.js";

const migrations = new URL("../../api/drizzle/v2/", import.meta.url);

test("scheduled prompts enforce session binding and live account permissions", async () => {
  const client = new PGlite({ extensions: { pg_trgm } });
  try {
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", migrations), "utf8"));
    for (const entry of journal.entries) {
      await client.exec(readFileSync(new URL(`${entry.tag}.sql`, migrations), "utf8"));
    }
    const db = drizzle(client);
    const store = createDrizzlePermissionStore(db);
    const spaceId = crypto.randomUUID();
    const foreignSpaceId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const foreignSessionId = crypto.randomUUID();
    const userId = "scheduled-prompt-owner";
    await db.insert(spaceSessions).values([
      { id: sessionId, spaceId },
      { id: foreignSessionId, spaceId: foreignSpaceId },
    ]);
    await db.insert(spaceMembers).values({ spaceId, userId, role: "host", createdBy: userId, updatedBy: userId });
    const input = { spaceId, sessionId, userId, promptPermission: "session.prompt.fullaccess" as const, auth: null };

    await assertTaskPromptAccess(input, store);
    await assertTaskPromptAccess({ ...input, promptPermission: "session.prompt.readonly" }, store);
    await assertTaskPromptAccess({ ...input, sessionId: null }, store);
    await assert.rejects(assertTaskPromptAccess({ ...input, sessionId: foreignSessionId }, store), /does not belong/);
    await assert.rejects(assertTaskPromptAccess({ ...input, sessionId: crypto.randomUUID() }, store), /does not belong/);
    const auth = createDelegatedPromptAuth({
      source: "app_session", actorUserId: userId, spaceId, appId: crypto.randomUUID(),
      scopes: [input.promptPermission], exp: Math.floor(Date.now() / 1000) + 60,
    });
    assert.ok(auth);
    await assertTaskPromptAccess({ ...input, auth }, store);
    await assert.rejects(assertTaskPromptAccess({ ...input, sessionId: foreignSessionId, auth }, store), /does not belong/);
    await assert.rejects(assertTaskPromptAccess({ ...input, auth: { ...auth, scopes: [] } }, store), /permission is no longer available/);

    await db.update(spaceMembers).set({ role: "guest" }).where(eq(spaceMembers.spaceId, spaceId));
    await assert.rejects(assertTaskPromptAccess({ ...input, promptPermission: "session.prompt.readonly" }, store), /permission is no longer available/);
    await assert.rejects(assertTaskPromptAccess(input, store), /permission is no longer available/);
    await db.delete(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
    await assert.rejects(assertTaskPromptAccess(input, store), /permission is no longer available/);
    await assert.rejects(assertTaskPromptAccess({ ...input, sessionId: null }, store), /permission is no longer available/);

    await db.insert(accessPolicies).values({
      resourceType: "session", resourceId: sessionId, signedInUserRole: "builder", createdBy: userId, updatedBy: userId,
    });
    await assertTaskPromptAccess(input, store);
    await assert.rejects(assertTaskPromptAccess({ ...input, sessionId: null }, store), /permission is no longer available/);
    await db.delete(accessPolicies).where(eq(accessPolicies.resourceId, sessionId));
    await assert.rejects(assertTaskPromptAccess(input, store), /permission is no longer available/);

    await db.delete(spaceSessions).where(eq(spaceSessions.id, sessionId));
    await assert.rejects(assertTaskPromptAccess(input, store), /does not belong/);
  } finally {
    await client.close();
  }
});
