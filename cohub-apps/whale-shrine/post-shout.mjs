#!/usr/bin/env node
/**
 * post-shout.mjs — Append one shout to data/shouts.jsonl
 *
 * Called via Cohub prompt as a direct shell command:
 *   !node cohub-apps/whale-shrine/post-shout.mjs <base64-json>
 *
 * The `!` prefix makes Cohub run this as a deterministic shell command
 * (no LLM involved), so the write is stable and repeatable.
 *
 * Idempotent: if the shout id already exists in the file, it is silently
 * skipped — safe to retry with the same id.
 */
import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(HERE, "data", "shouts.jsonl");

const MAX_NAME = 32;
const MAX_MESSAGE = 280;
const REQUIRED = ["id", "ts", "userId", "name", "message", "amountUsd"];

const arg = process.argv[2];
if (!arg) {
  console.error(JSON.stringify({ status: "error", message: "missing base64 argument" }));
  process.exit(1);
}

let shout;
try {
  shout = JSON.parse(Buffer.from(arg, "base64").toString("utf-8"));
} catch {
  console.error(JSON.stringify({ status: "error", message: "invalid base64 json" }));
  process.exit(1);
}

for (const field of REQUIRED) {
  if (shout[field] === undefined || shout[field] === null || shout[field] === "") {
    console.error(JSON.stringify({ status: "error", message: `missing field: ${field}` }));
    process.exit(1);
  }
}

// Sanitize — keep raw values but cap length to prevent abuse.
shout.name = String(shout.name).trim().slice(0, MAX_NAME);
shout.message = String(shout.message).trim().slice(0, MAX_MESSAGE);
if (!shout.name || !shout.message) {
  console.error(JSON.stringify({ status: "error", message: "name and message must not be empty" }));
  process.exit(1);
}

// Idempotency — skip if this shout id was already written.
if (existsSync(DATA_FILE)) {
  const content = readFileSync(DATA_FILE, "utf-8");
  const seen = content.split("\n").some((line) => {
    if (!line.trim()) return false;
    try {
      return JSON.parse(line).id === shout.id;
    } catch {
      return false;
    }
  });
  if (seen) {
    console.log(JSON.stringify({ status: "duplicate", id: shout.id }));
    process.exit(0);
  }
}

mkdirSync(dirname(DATA_FILE), { recursive: true });
appendFileSync(DATA_FILE, `${JSON.stringify(shout)}\n`, "utf-8");
console.log(JSON.stringify({ status: "ok", id: shout.id }));
