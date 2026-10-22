import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { appDomainChallengeValue } from "@cohub/protocol";
import { APP_DOMAIN_MOVED_GRACE_MS, checkAppDomain, type AppDomainCheckDeps } from "./check.js";
import type { CustomHostname } from "./cloudflare.js";

const MIGRATION = new URL("../../../../apps/api/drizzle/v2/0075_app_domains.sql", import.meta.url);
const HOST = "app.example.com";
const APP_A = "11111111-1111-4111-8111-111111111111";
const APP_B = "22222222-2222-4222-8222-222222222222";
const SPACE = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";

async function setup() {
  const engine = new PGlite();
  await engine.exec("CREATE SCHEMA v2;");
  await engine.exec(readFileSync(MIGRATION, "utf8").replaceAll("--> statement-breakpoint", ""));
  await engine.exec(`
    CREATE TABLE v2.apps (id uuid PRIMARY KEY, status text, visibility text, current_version_id uuid);
    CREATE TABLE v2.app_versions (id uuid PRIMARY KEY, content_kind text);
    INSERT INTO v2.app_versions VALUES ('${VERSION}', 'web');
    INSERT INTO v2.apps VALUES ('${APP_A}', 'published', 'public', '${VERSION}'), ('${APP_B}', 'published', 'public', '${VERSION}');
  `);
  const txt: string[] = [];
  const hostnames = new Map<string, CustomHostname>();
  const calls: string[] = [];
  const charges: string[] = [];
  const removed: string[] = [];
  let clock = new Date("2026-10-01T00:00:00Z");
  const deps: AppDomainCheckDeps = {
    db: drizzle(engine) as unknown as AppDomainCheckDeps["db"],
    cnameTarget: "cname.cohub.live",
    dns: { txt: async () => [...txt], cname: async () => [] },
    cf: {
      findByHostname: async (hostname) => [...hostnames.values()].find((item) => item.hostname === hostname) ?? null,
      get: async (id) => hostnames.get(id) ?? null,
      create: async (hostname) => {
        calls.push(`create:${hostname}`);
        const created = { id: `cf-${hostnames.size + 1}`, hostname, status: "pending", sslStatus: "pending_validation", errors: [] };
        hostnames.set(created.id, created);
        return created;
      },
      refresh: async (id) => {
        calls.push(`refresh:${id}`);
        return hostnames.get(id) as CustomHostname;
      },
      delete: async (id) => {
        calls.push(`delete:${id}`);
        hostnames.delete(id);
      },
    },
    billing: {
      canAfford: async () => true,
      charge: async ({ domainId }) => {
        charges.push(domainId);
      },
    },
    withHostnameLock: (_hostname, run) => run(),
    consumeRefreshRequest: async () => false,
    invalidateOrigin: async () => undefined,
    publishUpdated: async () => undefined,
    publishRemoved: async (row, reason) => {
      removed.push(`${row.id}:${reason}`);
    },
    warn: () => undefined,
    now: () => clock,
  };
  async function claim(appId: string) {
    const result = await engine.query<{ id: string; verification_token: string }>(
      `INSERT INTO v2.app_domains (app_id, space_id, hostname, verification_token, created_by, token_issued_at)
       VALUES ($1, $2, $3, $4, 'user', $5) RETURNING id, verification_token`,
      [appId, SPACE, HOST, `token-${appId.slice(0, 4)}`, clock],
    );
    return result.rows[0] as { id: string; verification_token: string };
  }
  async function row(id: string) {
    const result = await engine.query<Record<string, unknown>>("SELECT * FROM v2.app_domains WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }
  return {
    engine, deps, txt, hostnames, calls, charges, removed, claim, row,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    activateAll() {
      for (const item of hostnames.values()) Object.assign(item, { status: "active", sslStatus: "active" });
    },
  };
}

test("a claim goes live only after its TXT proves ownership, and is charged once", async () => {
  const t = await setup();
  try {
    const a = await t.claim(APP_A);
    assert.ok((await checkAppDomain(t.deps, a.id)).nextCheckMs);
    assert.equal((await t.row(a.id))?.error_code, "ownership_not_found");
    assert.deepEqual(t.calls, []);

    t.txt.push(appDomainChallengeValue(a.verification_token));
    await checkAppDomain(t.deps, a.id);
    assert.equal((await t.row(a.id))?.status, "provisioning");
    assert.deepEqual(t.calls, [`create:${HOST}`]);

    t.activateAll();
    await checkAppDomain(t.deps, a.id);
    await checkAppDomain(t.deps, a.id);
    assert.equal((await t.row(a.id))?.status, "active");
    assert.deepEqual(t.charges, [a.id]);
  } finally {
    await t.engine.close();
  }
});

test("a new owner takes over a live domain only once the old token is gone", async () => {
  const t = await setup();
  try {
    const a = await t.claim(APP_A);
    t.txt.push(appDomainChallengeValue(a.verification_token));
    await checkAppDomain(t.deps, a.id);
    t.activateAll();
    await checkAppDomain(t.deps, a.id);

    const b = await t.claim(APP_B);
    t.txt.push(appDomainChallengeValue(b.verification_token));
    await checkAppDomain(t.deps, b.id);
    assert.equal((await t.row(b.id))?.error_code, "domain_in_use");
    assert.equal((await t.row(a.id))?.status, "active");

    t.txt.splice(0, 1);
    await checkAppDomain(t.deps, b.id);
    assert.equal(await t.row(a.id), null);
    assert.equal((await t.row(b.id))?.status, "active");
    assert.deepEqual(t.removed, [`${a.id}:transferred`]);
    assert.deepEqual(t.calls, [`create:${HOST}`]);
    assert.deepEqual(t.charges, [a.id, b.id]);
  } finally {
    await t.engine.close();
  }
});

test("a domain moved away past the grace period releases its hostname and fails", async () => {
  const t = await setup();
  try {
    const a = await t.claim(APP_A);
    t.txt.push(appDomainChallengeValue(a.verification_token));
    await checkAppDomain(t.deps, a.id);
    t.activateAll();
    await checkAppDomain(t.deps, a.id);

    for (const item of t.hostnames.values()) item.status = "moved";
    await checkAppDomain(t.deps, a.id);
    assert.equal((await t.row(a.id))?.status, "active");
    t.advance(APP_DOMAIN_MOVED_GRACE_MS + 1);
    await checkAppDomain(t.deps, a.id);
    const failed = await t.row(a.id);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.error_code, "dns_moved");
    assert.equal(failed?.provider_hostname_id, null);
    assert.equal(t.hostnames.size, 0);
    assert.deepEqual(t.charges, [a.id]);
  } finally {
    await t.engine.close();
  }
});

test("a claim whose App was deleted is dropped without touching Cloudflare", async () => {
  const t = await setup();
  try {
    const a = await t.claim(APP_A);
    t.txt.push(appDomainChallengeValue(a.verification_token));
    await t.engine.exec(`DELETE FROM v2.apps WHERE id = '${APP_A}'`);
    assert.equal((await checkAppDomain(t.deps, a.id)).nextCheckMs, null);
    assert.equal(await t.row(a.id), null);
    assert.deepEqual(t.calls, []);
    assert.deepEqual(t.charges, []);
  } finally {
    await t.engine.close();
  }
});

test("removal cleans up a Cloudflare hostname whose create response was lost", async () => {
  const t = await setup();
  try {
    const a = await t.claim(APP_A);
    t.txt.push(appDomainChallengeValue(a.verification_token));
    const create = t.deps.cf.create;
    t.deps.cf.create = async (hostname) => {
      await create(hostname);
      throw new Error("socket hang up");
    };
    await checkAppDomain(t.deps, a.id);
    assert.equal((await t.row(a.id))?.provider_hostname_id, null);
    assert.equal(t.hostnames.size, 1);

    await t.engine.exec(`UPDATE v2.app_domains SET status = 'removing', removal_intent = 'user' WHERE id = '${a.id}'`);
    await checkAppDomain(t.deps, a.id);
    assert.equal(await t.row(a.id), null);
    assert.equal(t.hostnames.size, 0);
  } finally {
    await t.engine.close();
  }
});
