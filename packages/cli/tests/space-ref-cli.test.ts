import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Command } from "commander";
import { registerSearch } from "../src/commands/search.js";
import { attachSessionTail, registerSpaces } from "../src/commands/spaces.js";

const HOME_ID = "11111111-1111-4111-8111-111111111111";
const OWNED_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";

type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw);
}

async function withMockApi(
  fn: (ctx: { requests: RecordedRequest[]; runCli: (argv: string[]) => Promise<string> }) => Promise<void>,
): Promise<void> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = await readJsonBody(req);
    requests.push({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body });

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "POST" && url.pathname === "/api/me/spaces/home") {
      return json(200, { id: HOME_ID, name: "Home", slug: "home" });
    }
    if (req.method === "GET" && url.pathname === "/api/me/spaces/by-slug/notes") {
      return json(200, { id: OWNED_ID, name: "Notes", slug: "notes" });
    }
    if (req.method === "GET" && url.pathname === "/api/spaces/by-slug/atou/project") {
      return json(200, { id: OTHER_ID, name: "Project", slug: "project" });
    }
    if (req.method === "GET" && url.pathname === "/api/search") {
      return json(200, { items: [], degraded: false });
    }
    if (req.method === "GET" && /^\/api\/spaces\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1);
      return json(200, { id, name: "Space", slug: "space", status: "active", createdAt: "2026-01-01T00:00:00.000Z" });
    }
    if (req.method === "GET" && /^\/api\/spaces\/[^/]+\/overview$/.test(url.pathname)) {
      return json(200, { days: 30, apps: { count: 0, views: 0, likes: 0 } });
    }
    if (req.method === "GET" && /^\/api\/spaces\/[^/]+\/sandbox$/.test(url.pathname)) {
      return json(200, { sandbox: { provider: "cloud", meta: { setup: null } } });
    }
    if (req.method === "PATCH" && /^\/api\/spaces\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1);
      return json(200, { space: { id, name: "Updated", slug: "updated" } });
    }
    if (req.method === "GET" && /^\/api\/spaces\/[^/]+\/config$/.test(url.pathname)) {
      return json(200, { config: { sandbox: { spec: "standard", allowedSpec: "standard" }, guest: null } });
    }
    if (req.method === "PATCH" && /^\/api\/spaces\/[^/]+\/config$/.test(url.pathname)) {
      return json(200, { config: { sandbox: { spec: "boost" }, guest: null }, sandbox: { pendingRestart: false } });
    }
    if (req.method === "GET" && /^\/api\/apps\/space\/[^/]+$/.test(url.pathname)) {
      return json(200, { apps: [{ id: "app-1", slug: "welcome" }] });
    }
    if (req.method === "PATCH" && url.pathname === "/api/me/resources/space/labels") {
      return json(200, { assignments: [] });
    }
    if (req.method === "PATCH" && url.pathname === "/api/me/resources/space/labels/batch") {
      return json(200, { resourceRefs: [], affectedLabelIds: [] });
    }
    return json(404, { message: `Unhandled ${req.method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  const previousBaseUrl = process.env.COHUB_BASE_URL;
  const previousToken = process.env.COHUB_EXECUTION_TOKEN;
  const previousSpace = process.env.COHUB_SPACE_ID;
  process.env.COHUB_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.COHUB_EXECUTION_TOKEN = "test-token";

  const runCli = async (argv: string[]): Promise<string> => {
    const program = new Command("cohub")
      .option("-s, --space <space>", "Target Space");
    registerSearch(program);
    registerSpaces(program);

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
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

test("spaces positional Space-ref commands resolve UUID, home, own slug, and username/slug", async () => {
  await withMockApi(async ({ requests, runCli }) => {
    delete process.env.COHUB_SPACE_ID;

    await runCli(["spaces", "setup", "atou/project", "--json"]);
    assert.equal(requests.at(-1)?.path, `/api/spaces/${OTHER_ID}/sandbox`);

    await runCli(["spaces", "get", "home", "--json"]);
    assert.ok(requests.some((r) => r.method === "GET" && r.path === `/api/spaces/${HOME_ID}`));

    await runCli(["-s", "notes", "spaces", "get", "--json"]);
    assert.ok(requests.some((r) => r.method === "GET" && r.path === `/api/spaces/${OWNED_ID}`));

    await runCli(["spaces", "update", "atou/project", "--name", "Renamed", "--json"]);
    const updateReq = requests.findLast((r) => r.method === "PATCH" && r.path === `/api/spaces/${OTHER_ID}`);
    assert.deepEqual(updateReq?.body, { name: "Renamed" });

    await runCli(["spaces", "rename", "notes", "New Notes"]);
    const renameReq = requests.findLast((r) => r.method === "PATCH" && r.path === `/api/spaces/${OWNED_ID}`);
    assert.deepEqual(renameReq?.body, { name: "New Notes" });

    await runCli(["spaces", "config", "atou/project", "--json"]);
    assert.equal(requests.at(-1)?.path, `/api/spaces/${OTHER_ID}/config`);

    await runCli(["spaces", "config", "atou/project", "--guest-app", "welcome", "--json"]);
    assert.ok(requests.some((r) => r.method === "GET" && r.path === `/api/apps/space/${OTHER_ID}`));
    const configPatch = requests.findLast((r) => r.method === "PATCH" && r.path === `/api/spaces/${OTHER_ID}/config`);
    assert.deepEqual(configPatch?.body, { guest: { appId: "app-1" } });

    await runCli(["spaces", "pin", "atou/project"]);
    const pinReq = requests.findLast((r) => r.path === "/api/me/resources/space/labels");
    assert.equal(pinReq?.query.get("resourceRef"), OTHER_ID);
    assert.deepEqual(pinReq?.body, { addLabelRefs: ["Pinned"] });

    await runCli(["spaces", "unpin", "notes"]);
    const unpinReq = requests.findLast((r) => r.path === "/api/me/resources/space/labels");
    assert.equal(unpinReq?.query.get("resourceRef"), OWNED_ID);
    assert.deepEqual(unpinReq?.body, { removeLabelRefs: ["Pinned"] });

    const archiveOut = await runCli(["spaces", "archive", "home", "atou/project", "--json"]);
    const archiveReq = requests.findLast((r) => r.path === "/api/me/resources/space/labels/batch");
    assert.deepEqual(archiveReq?.body, {
      resourceRefs: [HOME_ID, OTHER_ID],
      addLabelRefs: ["Archived"],
      removeLabelRefs: ["Pinned"],
    });
    assert.deepEqual(JSON.parse(archiveOut), { ids: [HOME_ID, OTHER_ID], archived: true });

    const unarchiveOut = await runCli(["spaces", "unarchive", "notes", "--json"]);
    const unarchiveReq = requests.findLast((r) => r.path === "/api/me/resources/space/labels/batch");
    assert.deepEqual(unarchiveReq?.body, {
      resourceRefs: [OWNED_ID],
      removeLabelRefs: ["Archived"],
    });
    assert.deepEqual(JSON.parse(unarchiveOut), { ids: [OWNED_ID], archived: false });
  });
});

test("attachSessionTail keeps stdout pure JSONL in --json mode and disconnects before exiting", async () => {
  const handlers = new Map<string, (event: { payload?: Record<string, unknown> }) => void>();
  const events: string[] = [];
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  attachSessionTail(
    {
      disconnect: async () => {
        events.push("disconnect");
        throw new Error("socket already closed");
      },
    },
    {
      on: (event, handler) => {
        handlers.set(event, handler);
      },
    },
    {
      json: true,
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: (chunk) => { stderr += chunk; } },
      exit: (code) => {
        events.push(`exit:${code}`);
        exitCode = code;
        resolveExit();
      },
    },
  );

  assert.equal(stdout, "");
  handlers.get("turn.patch")?.({ payload: { ops: [{ o: "append", p: "/text", v: "hello" }] } });
  handlers.get("turn.patch")?.({ payload: { ops: [{ o: "append", p: "/text", v: " world" }] } });
  handlers.get("turn.finalized")?.({});
  await exited;

  assert.equal(stderr, "");
  assert.equal(exitCode, 0);
  assert.deepEqual(events, ["disconnect", "exit:0"]);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    { payload: { ops: [{ o: "append", p: "/text", v: "hello" }] } },
    { payload: { ops: [{ o: "append", p: "/text", v: " world" }] } },
  ]);
});

test("attachSessionTail disconnects cleanly before exiting on turn.error and preserves human output", async () => {
  const errorHandlers = new Map<string, (event: { payload?: Record<string, unknown> }) => void>();
  const errorEvents: string[] = [];
  let jsonStdout = "";
  let jsonStderr = "";
  let resolveErrExit!: () => void;
  const errExited = new Promise<void>((resolve) => {
    resolveErrExit = resolve;
  });

  attachSessionTail(
    {
      disconnect: async () => {
        errorEvents.push("disconnect");
      },
    },
    {
      on: (event, handler) => {
        errorHandlers.set(event, handler);
      },
    },
    {
      json: true,
      stdout: { write: (chunk) => { jsonStdout += chunk; } },
      stderr: { write: (chunk) => { jsonStderr += chunk; } },
      exit: (code) => {
        errorEvents.push(`exit:${code}`);
        resolveErrExit();
      },
    },
  );

  errorHandlers.get("turn.error")?.({ payload: { message: "boom" } });
  await errExited;

  assert.equal(jsonStdout, "");
  assert.match(jsonStderr, /✗ Error/);
  assert.match(jsonStderr, /"message":"boom"/);
  assert.deepEqual(errorEvents, ["disconnect", "exit:1"]);

  const humanHandlers = new Map<string, (event: { payload?: Record<string, unknown> }) => void>();
  let humanStdout = "";
  let resolveHumanExit!: () => void;
  const humanExited = new Promise<void>((resolve) => {
    resolveHumanExit = resolve;
  });

  attachSessionTail(
    { disconnect: async () => {} },
    { on: (event, handler) => { humanHandlers.set(event, handler); } },
    {
      json: false,
      stdout: { write: (chunk) => { humanStdout += chunk; } },
      stderr: { write: () => {} },
      exit: () => resolveHumanExit(),
    },
  );

  humanHandlers.get("turn.patch")?.({ payload: { ops: [{ o: "append", p: "/text", v: "hi" }] } });
  humanHandlers.get("turn.finalized")?.({});
  await humanExited;

  assert.equal(humanStdout, "  Listening for events...\n\nhi\n\n  ✓ Done\n");
});
