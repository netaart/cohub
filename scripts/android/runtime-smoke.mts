import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

process.env.LOG_LEVEL ??= "warn";
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const { WebSocketServer } = createRequire(join(repo, "apps/gateway/package.json"))("ws");
const { createSandboxRelay } = await import(join(repo, "apps/gateway/src/relay/sandbox.ts"));
const client = await import(join(repo, "packages/sandbox-client/src/index.ts"));
const { formatRgJsonGrepResult } = await import(join(repo, "apps/agent/src/runtime/tools/grep-json-format.ts"));

const photosSpace = "8c4ba1d2-5d8e-4c49-9f9a-2f1c3c1b9a10";
const storageSpace = "3d9e1f2a-7b4c-4d5e-8f6a-1b2c3d4e5f60";
const workerSecret = "worker-secret";
const step = (name: string) => console.log(`▶ ${name}`);

const base = mkdtempSync(join(tmpdir(), "cohub-android-smoke-"));
const root = join(base, "storage");
const unreadable = join(root, "Android/data");
const server = http.createServer();
const bridges: ReturnType<typeof spawn>[] = [];

function serveDisplay(path: string, inputs: unknown[][]) {
  const frame = (message: object) => {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(5);
    header.writeUInt32BE(body.length + 1);
    header[4] = 1;
    return Buffer.concat([header, body]);
  };
  return net.createServer((socket) => {
    socket.write(frame({ type: "hello", version: 1, name: "smoke" }));
    socket.write(frame({ type: "displays", displays: [{ id: "screen", name: "Smoke phone", width: 1080, height: 2400, stream: true, capture: true, input: true }] }));
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
        const size = pending.readUInt32BE(0);
        const call = JSON.parse(pending.subarray(5, 4 + size).toString()) as { type: string; id?: number; method: string; params: { events?: unknown[] } };
        pending = pending.subarray(4 + size);
        if (call.type !== "call" || !call.id) continue;
        if (call.method === "input") inputs.push(call.params.events ?? []);
        const result = call.method === "capture" ? { mimeType: "image/png", data: "iVBORw0KGgo=", width: 2, height: 2 } : null;
        socket.write(frame({ type: "reply", id: call.id, result }));
      }
    });
  }).listen(path);
}

try {
  const files: Record<string, string | Buffer> = {
    "DCIM/Camera/IMG_20261001_101500.jpg": Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0x20]), Buffer.from("Exif\0\0MM\0*Canon EOS R5\0"), Buffer.alloc(64)]),
    "DCIM/Camera/IMG_20261002_093000.JPG": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]),
    "DCIM/Camera/VID_20261002.mp4": Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]),
    "DCIM/.thumbnails/1.jpg": "thumb",
    "Documents/trip/kyoto.md": "# Kyoto\nday 1: Fushimi Inari\nday 2: Arashiyama\n",
    "Download/notes.txt": "shopping list\nmatcha\n",
    "Android/data/com.other.app/secret.txt": "kyoto secret",
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  chmodSync(unreadable, 0o000); // other apps' data is unreadable on Android 11+

  const bin = join(base, "bin");
  mkdirSync(bin);
  for (const tool of ["sh", "ls", "cat", "wc", "mv", "mkdir"]) {
    symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`]).toString().trim(), join(bin, tool));
  }

  step("build sandboxd");
  execFileSync("go", ["build", "-o", join(base, "sandboxd"), "."], { cwd: join(repo, "apps/sandbox"), stdio: "inherit" });

  const authorized: string[] = [];
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
  const relay = createSandboxRelay({
    workerSecret, nodeId: "smoke", selfEndpoint: `127.0.0.1:${port}`,
    peerEndpoint: (id: string) => `ws://127.0.0.1:${port}/internal/sandbox-relay/${id}`,
    authorize: async (token: string) => { authorized.push(token); return { ok: true, userId: "owner" }; },
    renewWorkspace: async () => true, releaseWorkspace: async () => undefined, reportStatus: async () => undefined,
    runtimeChanged: async () => undefined, publishWatcherEvent: async () => undefined, storeWatcherStatus: async () => undefined, storeDisplays: async () => undefined,
    publishChannelHint: async () => undefined, readChannelHint: async () => null, clearChannelHint: async () => undefined,
    dialForward: async () => { throw new Error("single gateway"); },
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    wss.handleUpgrade(request, socket, head, (ws: never) => {
      if (pathname === "/sandbox/relay") void relay.handleControlConnection(ws, request);
      else if (pathname === "/sandbox/relay/data") relay.handleDataConnection(ws, request);
      else if (pathname.startsWith("/internal/sandbox-relay/")) void relay.handlePeerConnection(ws, request, pathname.split("/").pop());
    });
  });

  const startBridge = async (spaceId: string, runtimeId: string, root: string, display?: string) => {
    const started = spawn(join(base, "sandboxd"), ["--local", "--space", spaceId, "--root", root, "--relay", `ws://127.0.0.1:${port}/sandbox/relay`], {
      cwd: root,
      env: {
        PATH: bin, HOME: join(base, spaceId), TMPDIR: base, COHUB_RELAY_TOKEN: `token-${spaceId}`, COHUB_RUNTIME_ID: runtimeId,
        COHUB_RUNTIME_MANAGED: "1", COHUB_RUNTIME_CONTROL_FD: "2", COHUB_LOG_FORMAT: "json",
        ...(display ? { COHUB_DISPLAY: `unix:${display}` } : {}),
      },
      stdio: ["pipe", "ignore", "pipe"],
    });
    bridges.push(started);
    const control: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sandboxd did not connect:\n${control.join("\n")}`)), 15_000);
      createInterface({ input: started.stderr }).on("line", (line) => {
        control.push(line);
        if (line === '{"type":"connected"}') { clearTimeout(timer); resolve(); }
      });
    });
    assert.deepEqual(control, ['{"type":"hello"}', '{"type":"connected"}']);
    return started;
  };

  const attach = async (spaceId: string) => {
    await client.startSandboxWsClient({ spaceId, wsUrl: `ws://127.0.0.1:${port}/internal/sandbox-relay/${spaceId}`, identity: "smoke", headers: { "x-worker-secret": workerSecret } });
    const connection = await client.waitForSandboxConnection(spaceId, 15_000);
    assert.equal(connection.capabilities?.processStartArgv, true);
    assert.equal(connection.capabilities?.processRg, false, "rg is not on PATH");
    assert.equal(connection.capabilities?.processFd, false, "fd is not on PATH");
    const target = { spaceId, sandboxId: connection.sandboxId ?? "local" };
    return <T,>(method: string, params: object, onEvent?: (event: { type: string; chunk?: string }) => void) =>
      connection.request(method as never, params as never, { ...target, onEvent } as never) as Promise<T>;
  };

  const stopBridge = async (spaceId: string, bridge: ReturnType<typeof spawn>) => {
    client.disconnectSandboxWsClient(spaceId, "smoke done");
    const exited = new Promise<number | null>((resolve) => bridge.once("exit", resolve));
    bridge.stdin?.end();
    assert.equal(await exited, 0);
  };

  step("serve two folders side by side: DCIM, and the whole storage with the screen shared");
  const displaySocket = join(base, "display.sock");
  const displayInputs: unknown[][] = [];
  const displayServer = serveDisplay(displaySocket, displayInputs);
  const [photosBridge, storageBridge] = await Promise.all([
    startBridge(photosSpace, "2f0d1c55-8b1a-4e3e-9d4c-6a1c2b3d4e5f", join(root, "DCIM")),
    startBridge(storageSpace, "6b7e2d1a-1c4f-4a8e-9b3d-2e5f6a7b8c9d", root, displaySocket),
  ]);
  assert.deepEqual([...authorized].sort(), [`token-${photosSpace}`, `token-${storageSpace}`].sort());
  const [photos, storage] = await Promise.all([attach(photosSpace), attach(storageSpace)]);

  step("find photos: glob, smart case, hidden thumbnails skipped");
  const found = await photos<{ matches: string[] }>("fs.find", { pattern: "*.jpg", path: ".", limit: 100, mode: "glob", requireGit: false });
  assert.deepEqual([...found.matches].sort(), ["Camera/IMG_20261001_101500.jpg", "Camera/IMG_20261002_093000.JPG"]);
  const videos = await storage<{ matches: string[] }>("fs.find", { pattern: "**/DCIM/**/*.mp4", path: "/workspace", limit: 100, mode: "glob", hidden: true, fullPath: true });
  assert.deepEqual(videos.matches, ["DCIM/Camera/VID_20261002.mp4"]);

  step("grep the whole storage: binaries and other apps' private folders are skipped");
  const grep = await storage<{ lines: string[] }>("fs.grep", { pattern: "kyoto", ignoreCase: true, path: ".", json: true, hidden: true, limit: 100 });
  const shown = formatRgJsonGrepResult({ lines: grep.lines, searchPath: ".", limit: 100 }).content[0] as { text: string };
  assert.equal(shown.text, "Documents/trip/kyoto.md:1: # Kyoto");

  step("file tools stay inside the bound folder");
  await assert.rejects(photos("fs.read", { path: "../Documents/trip/kyoto.md" }), /escapes sandbox root/);

  step("read a photo's bytes; the agent reads EXIF itself");
  const photo = await photos<{ contentBase64: string; mimeType: string }>("fs.read", { path: "Camera/IMG_20261001_101500.jpg", binary: true });
  const bytes = Buffer.from(photo.contentBase64, "base64");
  assert.equal(photo.mimeType, "image/jpeg");
  assert(bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) && bytes.includes(Buffer.from("Canon EOS R5")));

  step("run a string command with sh: bash is absent");
  const output: string[] = [];
  const run = await photos<{ exitCode: number }>("process.start", { command: 'echo "shell=$0"; ls Camera | wc -l', cwd: "/workspace" }, (event) => {
    if (event.type === "stdout" && event.chunk) output.push(event.chunk);
  });
  assert.equal(run.exitCode, 0);
  assert.match(output.join(""), /^shell=sh\s+3\s*$/);

  step("organise: write and move");
  await photos("fs.write", { path: "2026-10-01/.keep", content: "" });
  const moved = await photos<{ exitCode: number }>("process.start", { argv: ["mv", "Camera/IMG_20261001_101500.jpg", "2026-10-01/"], cwd: "/workspace" });
  assert.equal(moved.exitCode, 0);
  const after = await storage<{ matches: string[] }>("fs.find", { pattern: "IMG_20261001*", path: "DCIM", mode: "glob", limit: 10 });
  assert.deepEqual(after.matches, ["2026-10-01/IMG_20261001_101500.jpg"], "the other Space sees the move");

  step("the shared screen: listed, captured and steered through the relay; viewers only via the API");
  let shared: Array<{ id: string }> = [];
  for (let attempt = 0; attempt < 50 && shared.length === 0; attempt += 1) {
    shared = (await storage<{ displays: Array<{ id: string }> }>("display.list", {})).displays;
    if (shared.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepEqual(shared.map((display) => display.id), ["screen"]);
  assert.deepEqual((await photos<{ displays: unknown[] }>("display.list", {})).displays, [], "only the sharing Space sees it");
  const shot = await storage<{ mimeType: string; width: number }>("display.capture", { display: "screen", maxSize: 640 });
  assert.equal(shot.mimeType, "image/png");
  const tap = [{ type: "pointer", action: "down", x: 0.5, y: 0.5, t: 0 }, { type: "pointer", action: "up", x: 0.5, y: 0.5, t: 60 }];
  assert.deepEqual(await storage("display.input", { display: "screen", events: tap }), { applied: 2 });
  assert.deepEqual(displayInputs, [tap]);
  await assert.rejects(storage("rtc.open", { sessionId: "0b5f7c2e-8c1d-4a3e-9f6b-2d7a1c9e4b10", display: "screen", offer: "v=0", iceServers: [], control: true }), /through the API/);
  displayServer.close();

  step("stopping one folder leaves the other serving");
  await stopBridge(photosSpace, photosBridge);
  const stat = await storage<{ exists: boolean }>("fs.stat", { path: "Download/notes.txt" });
  assert.equal(stat.exists, true);
  await stopBridge(storageSpace, storageBridge);
  bridges.length = 0;

  console.log("✅ Android-like Runtime smoke passed");
} finally {
  for (const bridge of bridges) bridge.kill("SIGKILL");
  server.close();
  try { chmodSync(unreadable, 0o755); } catch { /* never created */ }
  rmSync(base, { recursive: true, force: true });
}
process.exit(0);
