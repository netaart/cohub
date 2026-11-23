import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { registerApps } from "../src/commands/apps.js";
import { registerSearch } from "../src/commands/search.js";
import { attachSessionTail, registerSpaces } from "../src/commands/spaces.js";

const HOME_ID = "11111111-1111-4111-8111-111111111111";
const OWNED_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const APP_ID = "44444444-4444-4444-8444-444444444444";

let mockApiSeq = 0;

type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
};

function parseRequestBody(raw: BodyInit | null | undefined): unknown {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return JSON.parse(raw);
}

async function withMockApi(
  fn: (ctx: { requests: RecordedRequest[]; runCli: (argv: string[]) => Promise<string> }) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.COHUB_BASE_URL;
  const previousToken = process.env.COHUB_EXECUTION_TOKEN;
  const previousSpace = process.env.COHUB_SPACE_ID;
  process.env.COHUB_BASE_URL = `https://cohub-space-ref-test-${++mockApiSeq}.invalid`;
  process.env.COHUB_EXECUTION_TOKEN = "test-token";

  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = parseRequestBody(init?.body);
    requests.push({ method, path: url.pathname, query: url.searchParams, body });

    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (method === "POST" && url.pathname === "/api/me/spaces/home") {
      return json(200, { id: HOME_ID, name: "Home", slug: "home" });
    }
    if (method === "GET" && url.pathname === "/api/me/spaces/by-slug/notes") {
      return json(200, { id: OWNED_ID, name: "Notes", slug: "notes" });
    }
    if (method === "GET" && url.pathname === "/api/spaces/by-slug/atou/project") {
      return json(200, { id: OTHER_ID, name: "Project", slug: "project" });
    }
    if (method === "GET" && url.pathname === "/api/search") {
      return json(200, { items: [], degraded: false });
    }
    if (method === "GET" && /^\/api\/spaces\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1);
      return json(200, { id, name: "Space", slug: "space", status: "active", createdAt: "2026-01-01T00:00:00.000Z" });
    }
    if (method === "GET" && /^\/api\/spaces\/[^/]+\/overview$/.test(url.pathname)) {
      return json(200, { days: 30, apps: { count: 0, views: 0, likes: 0 } });
    }
    if (method === "PATCH" && /^\/api\/spaces\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1);
      return json(200, { space: { id, name: "Updated", slug: "updated" } });
    }
    if (method === "PATCH" && /^\/api\/spaces\/[^/]+\/config$/.test(url.pathname)) {
      return json(200, { config: { sandbox: { spec: "boost" }, guest: null }, sandbox: { pendingRestart: false } });
    }
    if (method === "GET" && /^\/api\/apps\/space\/[^/]+$/.test(url.pathname)) {
      return json(200, { apps: [{ id: "app-1", slug: "welcome" }] });
    }
    if (method === "GET" && url.pathname === `/api/apps/${APP_ID}`) {
      return json(200, { app: { id: APP_ID } });
    }
    if (method === "POST" && url.pathname === `/api/apps/${APP_ID}/authorize`) {
      return json(200, { grant: { scopes: ["space.view"], spaceId: (body as { spaceId?: string }).spaceId ?? "app-space" } });
    }
    if (method === "PATCH" && url.pathname === "/api/me/resources/space/labels/batch") {
      return json(200, { resourceRefs: [], affectedLabelIds: [] });
    }
    return json(404, { message: `Unhandled ${method} ${url.pathname}` });
  };

  const runCli = async (argv: string[]): Promise<string> => {
    const program = new Command("cohub")
      .option("-s, --space <space>", "Target Space");
    registerSearch(program);
    registerSpaces(program);
    registerApps(program);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => {
      logs.push(values.join(" "));
    };
    try {
      await program.parseAsync(["node", "cohub", ...argv]);
    } finally {
      console.log = originalLog;
    }
    return logs.join("\n");
  };

  try {
    await fn({ requests, runCli });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBaseUrl === undefined) delete process.env.COHUB_BASE_URL;
    else process.env.COHUB_BASE_URL = previousBaseUrl;
    if (previousToken === undefined) delete process.env.COHUB_EXECUTION_TOKEN;
    else process.env.COHUB_EXECUTION_TOKEN = previousToken;
    if (previousSpace === undefined) delete process.env.COHUB_SPACE_ID;
    else process.env.COHUB_SPACE_ID = previousSpace;
  }
}

test("cohub search ignores COHUB_SPACE_ID, honors -s/--space, and resolves --space-id refs with priority", async () => {
  await withMockApi(async ({ requests, runCli }) => {
    process.env.COHUB_SPACE_ID = HOME_ID;

    await runCli(["search", "release", "--json"]);
    const globalSearch = requests.findLast((r) => r.path === "/api/search");
    assert.equal(globalSearch?.query.get("q"), "release");
    assert.equal(globalSearch?.query.get("spaceId"), null);

    await runCli(["-s", "atou/project", "search", "bug", "--json"]);
    const flagSearch = requests.findLast((r) => r.path === "/api/search");
    assert.equal(flagSearch?.query.get("spaceId"), OTHER_ID);

    await runCli(["search", "notes", "--space-id", "home", "--json"]);
    const spaceIdSearch = requests.findLast((r) => r.path === "/api/search");
    assert.equal(spaceIdSearch?.query.get("spaceId"), HOME_ID);

    await runCli(["-s", "home", "search", "priority", "--space-id", "notes", "--json"]);
    const overrideSearch = requests.findLast((r) => r.path === "/api/search");
    assert.equal(overrideSearch?.query.get("spaceId"), OWNED_ID);
  });
});

test("spaces commands resolve Space refs in positional arguments", async () => {
  await withMockApi(async ({ requests, runCli }) => {
    delete process.env.COHUB_SPACE_ID;

    await runCli(["spaces", "get", "home", "--json"]);
    assert.ok(requests.some((r) => r.method === "GET" && r.path === `/api/spaces/${HOME_ID}`));

    await runCli(["spaces", "update", "atou/project", "--name", "Renamed", "--json"]);
    assert.ok(requests.some((r) => r.method === "PATCH" && r.path === `/api/spaces/${OTHER_ID}`));

    await runCli(["spaces", "config", "notes", "--guest-app", "welcome", "--json"]);
    assert.ok(requests.some((r) => r.method === "GET" && r.path === `/api/apps/space/${OWNED_ID}`));
    assert.ok(requests.some((r) => r.method === "PATCH" && r.path === `/api/spaces/${OWNED_ID}/config`));

    const archiveOut = await runCli(["spaces", "archive", "home", "atou/project", "--json"]);
    assert.deepEqual(JSON.parse(archiveOut), { ids: [HOME_ID, OTHER_ID], archived: true });
  });
});

test("apps authorize --space resolves the ref and otherwise keeps the app's own Space", async () => {
  await withMockApi(async ({ requests, runCli }) => {
    process.env.COHUB_SPACE_ID = HOME_ID;
    const authorizeBody = () => requests.findLast((r) => r.path === `/api/apps/${APP_ID}/authorize`)?.body;

    await runCli(["apps", "authorize", APP_ID, "--scope", "space.view", "--space", "atou/project", "--json"]);
    assert.deepEqual(authorizeBody(), { scopes: ["space.view"], spaceId: OTHER_ID });

    await runCli(["apps", "authorize", APP_ID, "--scope", "space.view", "--json"]);
    assert.deepEqual(authorizeBody(), { scopes: ["space.view"] });
  });
});

test("sessions tail --json writes only JSONL to stdout", async () => {
  const handlers = new Map<string, (event: { payload?: Record<string, unknown> }) => void>();
  let stdout = "";
  const exited = new Promise<number>((resolve) => {
    attachSessionTail(
      { disconnect: async () => {} },
      { on: (event, handler) => { handlers.set(event, handler); } },
      { json: true, stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: () => {} }, exit: resolve },
    );
  });

  const patch = { payload: { ops: [{ o: "append", p: "/message/content/blocks/0/text", v: "hello" }] } };
  handlers.get("turn.patch")?.(patch);
  handlers.get("turn.finalized")?.({});

  assert.equal(await exited, 0);
  assert.deepEqual(stdout.trim().split("\n").map((line) => JSON.parse(line)), [patch]);
});
