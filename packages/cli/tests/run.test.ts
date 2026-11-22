import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { resolveCohubEnvironment } from "@neta-art/cohub";
import { parseRunCliOptions } from "../src/commands/run.js";

const SPACE_A = "11111111-1111-4111-8111-111111111111";
const SPACE_B = "22222222-2222-4222-8222-222222222222";
const SPACE_PROJECT = "33333333-3333-4333-8333-333333333333";

const roots: string[] = [];

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("cohub run uses the current directory Runtime binding", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cohub-run-binding-")));
  roots.push(root);
  const path = join(root, "runtime-spaces.json");
  const previousToken = process.env.COHUB_EXECUTION_TOKEN;
  const previousSpace = process.env.COHUB_SPACE_ID;
  process.env.COHUB_EXECUTION_TOKEN = jwt({ actorUserId: "user-alice" });
  delete process.env.COHUB_SPACE_ID;
  try {
    await writeFile(path, `${JSON.stringify({
      version: 1,
      bindings: [{ root, key: `${resolveCohubEnvironment()}:user-alice`, spaceId: "space-runtime" }],
    })}\n`);
    const options = await parseRunCliOptions(["run", "--", "git", "status"], { cwd: root, bindingsPath: path });
    assert.equal(options.spaceId, "space-runtime");
    assert.equal(options.command, "git status");
  } finally {
    if (previousToken === undefined) delete process.env.COHUB_EXECUTION_TOKEN;
    else process.env.COHUB_EXECUTION_TOKEN = previousToken;
    if (previousSpace === undefined) delete process.env.COHUB_SPACE_ID;
    else process.env.COHUB_SPACE_ID = previousSpace;
  }
});

test("cohub run accepts -s/--space/--space= both before and after run, without swallowing command flags", async () => {
  const previousSpace = process.env.COHUB_SPACE_ID;
  delete process.env.COHUB_SPACE_ID;
  try {
    assert.deepEqual(
      await parseRunCliOptions(["-s", SPACE_A, "run", "--", "git", "status"]),
      { spaceId: SPACE_A, json: false, async: false, command: "git status" },
    );
    assert.deepEqual(
      await parseRunCliOptions(["run", "-s", SPACE_A, "--", "git", "status"]),
      { spaceId: SPACE_A, json: false, async: false, command: "git status" },
    );
    assert.deepEqual(
      await parseRunCliOptions(["run", "--space", SPACE_A, "--async", "--json", "--", "git", "status", "-s"]),
      { spaceId: SPACE_A, json: true, async: true, command: "git status -s" },
    );
    assert.deepEqual(
      await parseRunCliOptions(["run", `--space=${SPACE_A}`, "git", "status", "-s"]),
      { spaceId: SPACE_A, json: false, async: false, command: "git status -s" },
    );
    assert.deepEqual(
      await parseRunCliOptions(["-s", SPACE_A, "run", "-s", SPACE_B, "-c", "git status"]),
      { spaceId: SPACE_B, json: false, async: false, command: "git status" },
    );
  } finally {
    if (previousSpace === undefined) delete process.env.COHUB_SPACE_ID;
    else process.env.COHUB_SPACE_ID = previousSpace;
  }
});

test("cohub run resolves username/slug passed after run", async () => {
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.COHUB_BASE_URL;
  const previousToken = process.env.COHUB_EXECUTION_TOKEN;
  const previousSpace = process.env.COHUB_SPACE_ID;
  process.env.COHUB_BASE_URL = "https://cohub-run-test.invalid";
  process.env.COHUB_EXECUTION_TOKEN = "test-token";
  delete process.env.COHUB_SPACE_ID;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/api/spaces/by-slug/atou/project") {
      return new Response(JSON.stringify({ id: SPACE_PROJECT, slug: "project", name: "Project" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: `Unhandled ${url.pathname}` }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const options = await parseRunCliOptions(["run", "-s", "atou/project", "--", "git", "status"]);
    assert.equal(options.spaceId, SPACE_PROJECT);
    assert.equal(options.command, "git status");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBaseUrl === undefined) delete process.env.COHUB_BASE_URL;
    else process.env.COHUB_BASE_URL = previousBaseUrl;
    if (previousToken === undefined) delete process.env.COHUB_EXECUTION_TOKEN;
    else process.env.COHUB_EXECUTION_TOKEN = previousToken;
    if (previousSpace === undefined) delete process.env.COHUB_SPACE_ID;
    else process.env.COHUB_SPACE_ID = previousSpace;
  }
});
