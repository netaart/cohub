// Must precede every Cohub module: `auth.ts`/`space.ts` bind `~/.config/cohub` at load time.
import { nativeFixtureHome } from "./fixtures/native-home.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveCohubEnvironment, type CohubEnvironment } from "@neta-art/cohub";
import { currentIdentityKey } from "../src/space.js";
import { nativeCaptureResponse, requestNativeDaemon } from "../src/runtime/native-ipc.js";
import { captureNativeSession, nativeRuntimeRoot, nativeSyncConfigPath, type NativeSyncConfig } from "../src/runtime/native-sync.js";
import { nativeIdentityHash } from "../src/runtime/native-sync-store.js";
import { runtimeSpaceBindingsPath } from "../src/runtime/space-binding.js";

// Identity comes from the isolated auth file, never from a scoped execution token:
// `captureNativeSession` deliberately refuses to sync inside Cohub-managed executions.
delete process.env.COHUB_EXECUTION_TOKEN;
delete process.env.COHUB_TURN_ID;

const identity = `${resolveCohubEnvironment()}:pending-transcript-placeholder`;
const at = "2026-09-21T00:00:00.000Z";
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
/** Paginated rollouts stamp every record with a file-wide continuous ordinal. */
const writeRollout = async (path: string, header: Record<string, unknown>, ...groups: Array<Array<Record<string, unknown>>>) => {
  const rows = [header, ...groups.flat()].map((row, ordinal) => ({ timestamp: at, ...row, ordinal }));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map(line).join(""));
};
const piHeader = (id: string, cwd: string) => line({ type: "session", version: 3, id, cwd, timestamp: at });
const jwt = (payload: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;

const roots: string[] = [];
async function tempRoot() {
  // Canonical so bindings match the launcher's `realpath`-resolved workspace (macOS `/var` is a symlink).
  const root = await realpath(await mkdtemp(join(tmpdir(), "cohub-native-pending-")));
  roots.push(root);
  return root;
}

test.after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await rm(nativeFixtureHome, { recursive: true, force: true });
});

/** Bind one project to a Space the way `cohub runtime up` would, without touching the network. */
async function bindProject(root: string) {
  const env: CohubEnvironment = resolveCohubEnvironment();
  const configDir = join(nativeFixtureHome, ".config", "cohub");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, env === "dev" ? "auth.dev.json" : "auth.json"), `${JSON.stringify({
    schemaVersion: 1, env, accessToken: jwt({ sub: "pending-transcript-placeholder" }), refreshToken: "",
    accessTokenExpiresAt: Date.now() + 3_600_000, createdAt: Date.now(), updatedAt: Date.now(),
  })}\n`);
  assert.equal(currentIdentityKey(), identity, "the fixture must isolate identity");
  const spaceId = randomUUID();
  await writeFile(runtimeSpaceBindingsPath(), `${JSON.stringify({ version: 1, bindings: [{ root, key: identity, spaceId }] })}\n`);
  const config: NativeSyncConfig = { version: 1, identity, spaceId, root, harnesses: ["pi"] };
  const path = nativeSyncConfigPath(nativeRuntimeRoot(spaceId), identity);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config)}\n`);
  return spaceId;
}

const completedTurn = (id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "message", id, parentId, timestamp: at, message: { role, content, timestamp: Date.parse(at), ...extra } });
const oneTurn = (nativeSessionId: string, root: string) => piHeader(nativeSessionId, root)
  + completedTurn("u1", null, "user", "hello")
  + completedTurn("a1", "u1", "assistant", [{ type: "text", text: "hi" }], { stopReason: "stop", provider: "native", model: "native-model" });

test("a transcript Pi has not written yet reports nothing to capture", async () => {
  const root = await tempRoot();
  const spaceId = await bindProject(root);
  const path = join(root, "never-created.jsonl");
  const nativeSessionId = randomUUID();

  // Exactly the state right after `session_start`: Pi knows the path, the file does not exist yet.
  // This used to reject with `ENOENT: ... realpath '<path>'`, which Pi surfaced as a sync warning.
  assert.equal(await captureNativeSession({ harness: "pi", cwd: root, path, nativeSessionId }), null);
  assert.equal(await captureNativeSession({ harness: "pi", cwd: root, path, nativeSessionId, settled: true }), null);

  // Nothing is invented locally for a Session that has no data yet.
  const identityDirectory = join(nativeRuntimeRoot(spaceId), "native", nativeIdentityHash(identity));
  assert.deepEqual(await readdir(identityDirectory), ["config.json"]);
});

test("a transcript written later captures normally after pending no-ops", async () => {
  const root = await tempRoot();
  await bindProject(root);
  const path = join(root, "session.jsonl");
  const nativeSessionId = randomUUID();

  assert.equal(await captureNativeSession({ harness: "pi", cwd: root, path, nativeSessionId }), null);
  await writeFile(path, oneTurn(nativeSessionId, root));
  const store = await captureNativeSession({ harness: "pi", cwd: root, path, nativeSessionId, settled: true });
  assert(store);
  assert.equal((await store.receipts()).length, 1);
});

test("a workspace removed mid-session is unbound rather than an ENOENT failure", async () => {
  const root = await tempRoot();
  await bindProject(root);
  const path = join(root, "session.jsonl");
  const deleted = join(root, "deleted-workspace");

  assert.equal(await captureNativeSession({ harness: "pi", cwd: deleted, path, nativeSessionId: randomUUID() }), null);
  assert.deepEqual(await requestNativeDaemon({ harness: "pi", cwd: deleted, path, nativeSessionId: "x" }), { ok: false, skipped: true, message: "Native Runtime is not bound" });
});

test("the daemon maps nothing-to-capture to a skip instead of an error", async () => {
  const root = await tempRoot();
  await bindProject(root);
  const path = join(root, "session.jsonl");
  const nativeSessionId = randomUUID();

  assert.deepEqual(await nativeCaptureResponse({ store: null }), { ok: false, skipped: true, message: "No native capture is pending" });
  await writeFile(path, oneTurn(nativeSessionId, root));
  const store = await captureNativeSession({ harness: "pi", cwd: root, path, nativeSessionId, settled: true });
  assert(store);
  assert.deepEqual(await nativeCaptureResponse({ store }), { ok: true, pendingTurns: 1 });
});

test("a Codex rollover keeps capturing through the real capture path", async () => {
  const root = await tempRoot();
  const spaceId = await bindProject(root);
  // Enable Codex for this project's native sync config.
  const configPath = nativeSyncConfigPath(nativeRuntimeRoot(spaceId), identity);
  await writeFile(configPath, `${JSON.stringify({ version: 1, identity, spaceId, root, harnesses: ["pi", "codex"] } satisfies NativeSyncConfig)}\n`);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex-home");
  try {
    const day = (n: number) => join(root, "codex-home", "sessions", "2026", "09", `0${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-0${n}T00-00-00-${id}.jsonl`);
    const turn = (key: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    const threadId = randomUUID();
    const rootPath = rollout(1, threadId);
    await writeRollout(rootPath, { type: "session_meta", payload: { id: threadId, cwd: root, history_mode: "paginated" } }, turn("r1"));
    // First capture through the real path (as the Codex hook would).
    const first = await captureNativeSession({ harness: "codex", cwd: root, path: rootPath, nativeSessionId: threadId, settled: true });
    assert(first, "the root rollout captures");
    assert.equal((await first.receipts()).length, 1);

    // Codex rolls over to a fresh leaf referencing the root.
    const rootEnd = (await stat(rootPath)).size;
    const leafPath = rollout(2, `${threadId}_${randomUUID()}`);
    await mkdir(dirname(leafPath), { recursive: true });
    await writeRollout(leafPath, { type: "session_meta", payload: { id: threadId, cwd: root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 4, end_byte_offset: rootEnd } } }, turn("l1"));
    // This is the previously failing path: capture must follow the rollover, not error out.
    const second = await captureNativeSession({ harness: "codex", cwd: root, path: leafPath, nativeSessionId: threadId, settled: true });
    assert(second, "the leaf rollout captures after rollover");
    assert.equal(second.root, first.root, "the same store handles the whole conversation");
    const receipts = await second.receipts();
    assert.deepEqual(receipts.map((receipt) => receipt.key), ["r1", "l1"], "one stitched conversation");
    assert.equal((await second.binding()).path, leafPath, "the binding follows the leaf");
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test("a managed Codex session that rolled over before its first capture persists a usable binding", async () => {
  const root = await tempRoot();
  const spaceId = await bindProject(root);
  const configPath = nativeSyncConfigPath(nativeRuntimeRoot(spaceId), identity);
  await writeFile(configPath, `${JSON.stringify({ version: 1, identity, spaceId, root, harnesses: ["pi", "codex"] } satisfies NativeSyncConfig)}\n`);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex-home");
  try {
    const day = (n: number) => join(root, "codex-home", "sessions", "2026", "09", `0${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-0${n}T00-00-00-${id}.jsonl`);
    const turn = (key: string) => [
      { type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    // The managed Runtime projected two Turns into the root rollout, then Codex rolled over
    // before any native capture happened.
    const threadId = randomUUID(), sessionId = randomUUID(), throughTurnId = randomUUID();
    const rootPath = rollout(1, threadId);
    await mkdir(dirname(rootPath), { recursive: true });
    // r1 is a projected Turn carrying its cloud Turn id; r2 was executed by the managed Runtime
    // (no Cohub metadata) and ends exactly at the managed boundary.
    await writeRollout(rootPath, { type: "session_meta", payload: { id: threadId, cwd: root, history_mode: "legacy" } },
      [
        { type: "event_msg", payload: { type: "turn_started", turn_id: "r1" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "q r1" }] }, metadata: { cohub: { turnId: throughTurnId } } },
        { type: "event_msg", payload: { type: "turn_complete", turn_id: "r1", last_agent_message: "a r1" } },
      ], turn("r2"));
    const rootContent = await readFile(rootPath);
    await mkdir(join(nativeRuntimeRoot(spaceId), "codex"), { recursive: true });
    const { createHash } = await import("node:crypto");
    await writeFile(join(nativeRuntimeRoot(spaceId), "codex", `${sessionId}.json`), JSON.stringify({ version: 1, harness: "codex", sessionId, nativeSessionId: threadId, path: rootPath, throughTurnId, pendingTurnId: null, checksum: createHash("sha256").update(rootContent).digest("hex") }));
    const rootEnd = (await stat(rootPath)).size;
    const leafPath = rollout(2, `${threadId}_${randomUUID()}`);
    await mkdir(dirname(leafPath), { recursive: true });
    await writeRollout(leafPath, { type: "session_meta", payload: { id: threadId, cwd: root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 7, end_byte_offset: rootEnd } } }, turn("l1"));

    const store = await captureNativeSession({ harness: "codex", cwd: root, path: leafPath, nativeSessionId: threadId, settled: true });
    assert(store, "the first-ever capture lands on the rolled-over leaf");
    const binding = await store.binding();
    assert.equal(binding.path, leafPath);
    assert.equal(binding.sessionId, sessionId);
    assert.equal(binding.ancestor?.rolloutId, threadId);
    const receipts = await store.receipts();
    assert.deepEqual(receipts.map((receipt) => receipt.key), ["l1"], "managed ancestor Turns are not replayed");
    assert.equal(receipts[0]?.parentCloudTurnId, throughTurnId);
    // flush/status read binding.json first; a missing write would throw here.
    await assert.rejects(store.flush(new AbortController().signal), /unavailable|Runtime WS/);
    assert.equal((await store.status()).sessionId, sessionId);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});

test("a managed ancestor with trailing usage records still binds at the verified boundary", async () => {
  const root = await tempRoot();
  const spaceId = await bindProject(root);
  await writeFile(nativeSyncConfigPath(nativeRuntimeRoot(spaceId), identity), `${JSON.stringify({ version: 1, identity, spaceId, root, harnesses: ["pi", "codex"] } satisfies NativeSyncConfig)}\n`);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, "codex-home");
  try {
    const day = (n: number) => join(root, "codex-home", "sessions", "2026", "09", `0${n}`);
    const rollout = (n: number, id: string) => join(day(n), `rollout-2026-09-0${n}T00-00-00-${id}.jsonl`);
    const turnRows = (key: string) => [
      { timestamp: at, type: "event_msg", payload: { type: "turn_started", turn_id: key } },
      { timestamp: at, type: "event_msg", payload: { type: "user_message", message: `q ${key}` } },
      { timestamp: at, type: "event_msg", payload: { type: "turn_complete", turn_id: key, last_agent_message: `a ${key}` } },
    ];
    const threadId = randomUUID(), sessionId = randomUUID(), throughTurnId = randomUUID();
    const rootPath = rollout(1, threadId);
    await mkdir(dirname(rootPath), { recursive: true });
    // r1 is projected (cloud-marked); r2 was executed by the managed Runtime and Codex appended
    // a token_usage_record after its completion — contentEndBytes then undershoots the file.
    // header + r1 (3) + r2 (3) + usage (1) = 8 lines; ordinals 0..7.
    await writeRollout(rootPath, { type: "session_meta", payload: { id: threadId, cwd: root, history_mode: "legacy" } },
      [
        { type: "event_msg", payload: { type: "turn_started", turn_id: "r1" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "q r1" }] }, metadata: { cohub: { turnId: throughTurnId } } },
        { type: "event_msg", payload: { type: "turn_complete", turn_id: "r1", last_agent_message: "a r1" } },
      ], turnRows("r2"),
      [{ type: "token_usage_record", payload: { turn_id: "r2", turn_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
    const rootContent = await readFile(rootPath);
    await mkdir(join(nativeRuntimeRoot(spaceId), "codex"), { recursive: true });
    const { createHash } = await import("node:crypto");
    await writeFile(join(nativeRuntimeRoot(spaceId), "codex", `${sessionId}.json`), JSON.stringify({ version: 1, harness: "codex", sessionId, nativeSessionId: threadId, path: rootPath, throughTurnId, pendingTurnId: null, checksum: createHash("sha256").update(rootContent).digest("hex") }));
    const rootEnd = Buffer.byteLength(rootContent);
    const leafPath = rollout(2, `${threadId}_${randomUUID()}`);
    await mkdir(dirname(leafPath), { recursive: true });
    await writeRollout(leafPath, { type: "session_meta", payload: { id: threadId, cwd: root, history_mode: "paginated", history_base: { thread_id: threadId, end_ordinal_exclusive: 8, end_byte_offset: rootEnd } } }, turnRows("l1"));

    const store = await captureNativeSession({ harness: "codex", cwd: root, path: leafPath, nativeSessionId: threadId, settled: true });
    assert(store, "the trailing usage record must not block the binding");
    const receipts = await store.receipts();
    assert.deepEqual(receipts.map((receipt) => receipt.key), ["l1"]);
    assert.equal(receipts[0]?.parentCloudTurnId, throughTurnId, "the leaf continues from the managed boundary");
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
});
