import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { formatEpochMs, formatLocalDateTime, handleHttp, table } from "../src/output.js";

const originalTimezone = process.env.TZ;

before(() => {
  process.env.TZ = "Asia/Shanghai";
});

after(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});

test("formats timestamps in the system timezone with an explicit offset", () => {
  assert.equal(formatLocalDateTime("2026-09-23T08:01:02.000Z"), "2026-09-23 16:01:02 +08:00");
  assert.equal(formatEpochMs(Date.parse("2026-09-23T08:01:02.000Z")), "2026-09-23 16:01:02 +08:00");
});

test("returns an empty value for missing or invalid timestamps", () => {
  assert.equal(formatLocalDateTime(null), "");
  assert.equal(formatLocalDateTime("not-a-date"), "");
  assert.equal(formatEpochMs(""), "");
});

test("table formats timestamp columns without changing other values", () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    table([{ createdAt: "2026-09-23T08:01:02.000Z", title: "Example" }], [
      { key: "createdAt", label: "Created" },
      { key: "title", label: "Title" },
    ]);
  } finally {
    console.log = originalLog;
  }

  assert.match(lines.join("\n"), /2026-09-23 16:01:02 \+08:00/);
  assert.match(lines.join("\n"), /Example/);
});

test("JSON errors carry the HTTP status next to the response body", () => {
  const printed: unknown[] = [];
  const originalWrite = process.stderr.write;
  const originalExit = process.exit;
  process.argv.push("--json");
  process.stderr.write = ((chunk: string) => printed.push(JSON.parse(chunk))) as typeof process.stderr.write;
  process.exit = (() => {
    throw new Error("exit");
  }) as typeof process.exit;
  try {
    for (const body of [{ message: "Provider stopped with: SAFETY" }, { message: "this is your referral link", status: "self" }]) {
      assert.throws(() => handleHttp(Object.assign(new Error(body.message), { status: 502, body })), /exit/);
    }
  } finally {
    process.argv.pop();
    process.stderr.write = originalWrite;
    process.exit = originalExit;
  }

  assert.deepEqual(printed, [
    { status: 502, message: "Provider stopped with: SAFETY" },
    { status: "self", message: "this is your referral link" },
  ]);
});
