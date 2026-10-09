import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { formatEpochMs, formatLocalDateTime, table } from "../src/output.js";

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
