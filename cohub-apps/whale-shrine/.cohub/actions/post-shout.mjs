#!/usr/bin/env node
/**
 * post-shout — App Action: append one shout to the Space's shouts.jsonl
 *
 * Runs as the App owner in the home Space sandbox (cwd = workspace root).
 * Input arrives as JSON on stdin:
 *   { "shout": { id, ts, userId, name, message, amountUsd }, "dataPath": "..." }
 *
 * The App owner pays for this execution; no viewer grant is involved.
 * Input comes from viewers, so every field is validated and dataPath is
 * restricted to a relative .jsonl path inside the workspace.
 *
 * Idempotent: a shout id already present is skipped, so retries are safe.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const MAX_NAME = 32;
const MAX_MESSAGE = 280;
const MAX_AMOUNT_USD = 10_000;

let body = "";
for await (const chunk of process.stdin) body += chunk;

const fail = (message) => {
  process.stderr.write(JSON.stringify({ status: "error", message }));
  process.exit(1);
};

let input;
try {
  input = body.trim() ? JSON.parse(body) : null;
} catch {
  fail("invalid json input");
}
if (!input || typeof input !== "object") fail("input must be an object");

// dataPath: workspace-relative .jsonl, no escaping the workspace root.
const dataPath = String(input.dataPath ?? "");
if (!dataPath.endsWith(".jsonl") || isAbsolute(dataPath) || dataPath.split(/[\\/]/).includes("..")) {
  fail("invalid dataPath");
}

// shout: validate, sanitize, and cap every field.
const raw = input.shout;
if (!raw || typeof raw !== "object") fail("missing shout");
const shout = {
  id: String(raw.id ?? "").slice(0, 64),
  ts: String(raw.ts ?? "").slice(0, 40),
  userId: String(raw.userId ?? "").slice(0, 64),
  name: String(raw.name ?? "").trim().slice(0, MAX_NAME),
  message: String(raw.message ?? "").trim().slice(0, MAX_MESSAGE),
  amountUsd: Number(raw.amountUsd),
};
for (const [key, value] of Object.entries(shout)) {
  if (key === "amountUsd") {
    if (!Number.isFinite(value) || value < 0 || value > MAX_AMOUNT_USD) fail("invalid amountUsd");
  } else if (!value) {
    fail(`missing field: ${key}`);
  }
}

const dataFile = resolve(process.cwd(), dataPath);

// Idempotency — skip a shout id that was already written.
if (existsSync(dataFile)) {
  const seen = readFileSync(dataFile, "utf-8").split("\n").some((line) => {
    if (!line.trim()) return false;
    try {
      return JSON.parse(line).id === shout.id;
    } catch {
      return false;
    }
  });
  if (seen) {
    process.stdout.write(JSON.stringify({ status: "duplicate", id: shout.id }));
    process.exit(0);
  }
}

mkdirSync(resolve(dataFile, ".."), { recursive: true });
appendFileSync(dataFile, `${JSON.stringify(shout)}${"\n"}`, "utf-8");
process.stdout.write(JSON.stringify({ status: "ok", id: shout.id }));
