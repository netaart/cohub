import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { registerCronJobs } from "../src/commands/cron-jobs.js";
import { registerPrompt, registerSpaces } from "../src/commands/spaces.js";

const SPACE_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const environment = ["ENV", "COHUB_BASE_URL", "COHUB_EXECUTION_TOKEN", "COHUB_SPACE_ID", "COHUB_SESSION_ID", "COHUB_TURN_ID"] as const;
type Request = { url: string; method: string; body: Record<string, unknown> | null };

class ExitSignal extends Error {}

async function run(argv: string[]) {
  const savedEnvironment = Object.fromEntries(environment.map((key) => [key, process.env[key]]));
  const original = { fetch: globalThis.fetch, exit: process.exit, log: console.log, write: process.stderr.write };
  const requests: Request[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;
  process.env.COHUB_BASE_URL = "https://api.test";
  process.env.COHUB_EXECUTION_TOKEN = "test-token";
  for (const key of environment) {
    if (key !== "COHUB_BASE_URL" && key !== "COHUB_EXECUTION_TOKEN") delete process.env[key];
  }
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ job: { id: "job-1" } });
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new ExitSignal();
  }) as typeof process.exit;
  console.log = () => {};
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const program = new Command("cohub").option("-s, --space <id>");
    registerPrompt(program);
    registerSpaces(program);
    registerCronJobs(program);
    await program.parseAsync(["node", "cohub", "-s", SPACE_ID, ...argv]);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    globalThis.fetch = original.fetch;
    process.exit = original.exit;
    console.log = original.log;
    process.stderr.write = original.write;
    for (const key of environment) {
      if (savedEnvironment[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnvironment[key];
    }
  }
  return { requests, stderr: stderr.join(""), exitCode };
}

test("scheduled prompts send notification choices for repeat, at and delay through both entry points", async () => {
  const schedules = [
    { args: ["--cron", "0 9 * * *", "--timezone", "Asia/Shanghai"], body: { mode: "repeat", cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" } },
    { args: ["--at", "2027-01-01T09:00:00+08:00"], body: { mode: "at", sendAt: "2027-01-01T09:00:00+08:00" } },
    { args: ["--delay-ms", "60000"], body: { mode: "delay", delayMs: 60000 } },
  ];
  for (const entry of [["prompt"], ["spaces", "prompt"]]) {
    for (const schedule of schedules) {
      for (const choice of ["on", "off", undefined]) {
        const result = await run([...entry, "Refresh memory", ...schedule.args, ...(choice ? ["--notify-on-success", choice] : []), "--json"]);
        assert.equal(result.exitCode, undefined, result.stderr);
        assert.equal(result.requests.length, 1);
        const request = result.requests[0];
        assert.ok(request?.body);
        assert.equal(request.url, `https://api.test/api/spaces/${SPACE_ID}/prompt`);
        assert.equal(request.method, "POST");
        assert.deepEqual(request.body?.content, [{ type: "text", text: "Refresh memory" }]);
        assert.deepEqual(request.body?.schedule, { ...schedule.body, ...(choice ? { notifyOnSuccess: choice === "on" } : {}) });
        assert.equal(Object.hasOwn(request.body, "notifyOnSuccess"), false);
      }
    }
  }
});

test("notification choices require a schedule and reject invalid values before sending", async () => {
  for (const entry of [["prompt"], ["spaces", "prompt"]]) {
    const missing = await run([...entry, "Refresh memory", "--notify-on-success", "off"]);
    assert.equal(missing.exitCode, 1);
    assert.match(missing.stderr, /--notify-on-success requires --delay-ms, --at, or --cron/);
    assert.deepEqual(missing.requests, []);
    const invalid = await run([...entry, "Refresh memory", "--delay-ms", "60000", "--notify-on-success", "sometimes"]);
    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.stderr, /Allowed choices are on, off/);
    assert.deepEqual(invalid.requests, []);
  }
});

test("cron job updates send explicit choices without resetting an omitted setting", async () => {
  for (const [choice, expected] of [["on", true], ["off", false]] as const) {
    const result = await run(["cron-jobs", "update", "job-1", "--notify-on-success", choice, "--json"]);
    assert.equal(result.exitCode, undefined, result.stderr);
    assert.deepEqual(result.requests, [{ url: "https://api.test/api/cron-jobs/job-1", method: "PATCH", body: { notifyOnSuccess: expected } }]);
  }
  const unchanged = await run(["cron-jobs", "update", "job-1", "--title", "Keep quiet", "--json"]);
  assert.deepEqual(unchanged.requests, [{ url: "https://api.test/api/cron-jobs/job-1", method: "PATCH", body: { title: "Keep quiet" } }]);
  const invalid = await run(["cron-jobs", "update", "job-1", "--notify-on-success", "sometimes"]);
  assert.equal(invalid.exitCode, 1);
  assert.match(invalid.stderr, /Allowed choices are on, off/);
  assert.deepEqual(invalid.requests, []);
});
