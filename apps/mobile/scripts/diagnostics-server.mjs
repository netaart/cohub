import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const host = process.env.DIAGNOSTICS_HOST?.trim() || "0.0.0.0";
const port = parsePort(process.env.DIAGNOSTICS_PORT || "3000");
const databasePath = resolve(process.env.DIAGNOSTICS_DATABASE?.trim() || "./data/diagnostics.sqlite");
const maxBodyBytes = 1_000_000;
const rateWindowMs = 60_000;
const rateLimit = 20;
const requestCounts = new Map();

mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY NOT NULL,
    description TEXT NOT NULL,
    session_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    app_version TEXT,
    platform TEXT NOT NULL,
    os_version TEXT,
    update_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS feedback_events (
    feedback_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    name TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (feedback_id, sequence),
    FOREIGN KEY (feedback_id) REFERENCES feedback(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS feedback_created_at ON feedback(created_at);
  CREATE INDEX IF NOT EXISTS feedback_events_name ON feedback_events(name);
`);

const insertFeedback = db.prepare(`INSERT INTO feedback (id, description, session_id, started_at, app_version, platform, os_version, update_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const insertEvent = db.prepare(`INSERT INTO feedback_events (feedback_id, sequence, timestamp, name, payload) VALUES (?, ?, ?, ?, ?)`);
const selectFeedback = db.prepare("SELECT id, description, session_id AS sessionId, started_at AS startedAt, app_version AS appVersion, platform, os_version AS osVersion, update_id AS updateId, created_at AS createdAt FROM feedback WHERE id = ?");
const selectEvents = db.prepare("SELECT e.feedback_id AS feedbackId, f.session_id AS sessionId, e.sequence, e.timestamp, e.name, e.payload FROM feedback_events e JOIN feedback f ON f.id = e.feedback_id WHERE e.feedback_id = ? ORDER BY e.sequence ASC");

function parsePort(value) {
  const portValue = Number(value);
  if (!Number.isInteger(portValue) || portValue < 1 || portValue > 65535) throw new Error("DIAGNOSTICS_PORT must be an integer between 1 and 65535.");
  return portValue;
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sanitize(value, depth = 0) {
  if (depth > 4) return "[depth-limited]";
  if (typeof value === "string") return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(token|secret|password|cookie|authorization|body|content|data|base64|text|title|url)$/i.test(key) || /(?:access|refresh)[_-]?token|message[_-]?text|assistant[_-]?text|user[_-]?text/i.test(key)) continue;
      result[key] = sanitize(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

function clientKey(request) {
  const forwarded = request.headers["x-forwarded-for"];
  return typeof forwarded === "string" ? forwarded.split(",")[0].trim() : request.socket.remoteAddress || "unknown";
}

function allowed(request) {
  const now = Date.now();
  const key = clientKey(request);
  const current = requestCounts.get(key);
  if (!current || current.expiresAt <= now) {
    requestCounts.set(key, { count: 1, expiresAt: now + rateWindowMs });
    return true;
  }
  current.count += 1;
  return current.count <= rateLimit;
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function requiredString(value, name, maxLength) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim().slice(0, maxLength);
}

function storeFeedback(input) {
  const feedbackId = requiredString(input.feedbackId, "feedbackId", 120);
  const description = requiredString(input.description, "description", 4_000);
  const session = input.session;
  if (!session || typeof session !== "object") throw new Error("session is required.");
  const sessionId = requiredString(session.id, "session.id", 120);
  const startedAt = requiredString(session.startedAt, "session.startedAt", 80);
  const app = input.app && typeof input.app === "object" ? input.app : {};
  const platform = requiredString(app.platform, "app.platform", 40);
  const events = Array.isArray(session.events) ? session.events.slice(0, 4_000) : [];
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    insertFeedback.run(feedbackId, description, sessionId, startedAt, typeof app.version === "string" ? app.version.slice(0, 80) : null, platform, typeof app.osVersion === "string" ? app.osVersion.slice(0, 80) : null, typeof app.updateId === "string" ? app.updateId.slice(0, 120) : null, now);
    for (const event of events) {
      const sequence = Number(event?.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1) continue;
      const name = requiredString(event?.name, "event.name", 160);
      const payload = typeof event?.payload === "string" ? JSON.parse(event.payload) : sanitize(event?.payload ?? {});
      insertEvent.run(feedbackId, sequence, typeof event.timestamp === "string" ? event.timestamp.slice(0, 80) : now, name, JSON.stringify(sanitize(payload)));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return feedbackId;
}

const server = createServer(async (request, response) => {
  try {
    if (!allowed(request)) return json(response, 429, { error: "rate limit exceeded" });
    const pathname = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`).pathname;
    if (request.method === "GET" && pathname === "/health") return json(response, 200, { ok: true, service: "cohub-diagnostics" });
    if (request.method === "POST" && pathname === "/v1/feedback") {
      if (request.headers["content-type"] !== "application/json") return json(response, 415, { error: "content-type must be application/json" });
      const input = await readJson(request);
      const id = storeFeedback(input);
      return json(response, 201, { id });
    }
    const match = /^\/v1\/feedback\/([^/]+)$/.exec(pathname);
    if (request.method === "GET" && match) {
      const feedback = selectFeedback.get(decodeURIComponent(match[1]));
      if (!feedback) return json(response, 404, { error: "feedback not found" });
      return json(response, 200, { ...feedback, events: selectEvents.all(feedback.id).map((event) => ({ ...event, payload: JSON.parse(event.payload) })) });
    }
    return json(response, 404, { error: "not found" });
  } catch (error) {
    const status = Number(error?.status) || 400;
    return json(response, status >= 500 ? 500 : status, { error: error instanceof Error ? error.message : "request failed" });
  }
});

server.listen(port, host, () => console.log(`Cohub diagnostics listening on http://${host}:${port} using ${databasePath}`));

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
