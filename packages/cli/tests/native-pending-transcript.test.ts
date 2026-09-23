// Must precede every Cohub module: `auth.ts`/`space.ts` bind `~/.config/cohub` at load time.
import { nativeFixtureHome } from "./fixtures/native-home.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
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
