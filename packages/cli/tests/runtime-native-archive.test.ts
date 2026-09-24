import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importNativeArchive } from "../src/runtime/native-archive.js";

for (const harness of ["pi", "codex"] as const) test(`${harness} import changes only a working-copy header and preserves opaque history bytes`, async () => {
  const root = await mkdtemp(join(tmpdir(), "native-import-"));
  try {
    const source = join(root, "raw"), target = join(root, "working");
    const nativeSessionId = randomUUID(), id = randomUUID();
    const header = harness === "pi" ? { type: "session", id: nativeSessionId, cwd: "/old" } : { type: "session_meta", payload: { id: nativeSessionId, cwd: "/old" } };
    // Retain large integers and original whitespace instead of parse/stringify of the body.
    const tail = Buffer.from('{ "type": "event_msg", "payload": { "number": 9007199254740993, "text": "history" } }\r\n');
    const original = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), tail]);
    await writeFile(source, original);
    const result = await importNativeArchive({ source, target, harness, nativeSessionId, id, cwd: root });
    const working = await readFile(target);
    assert.deepEqual(working.subarray(working.indexOf(10) + 1), tail);
    assert.deepEqual(await readFile(source), original);
    assert.equal(result.nativeSessionId, harness === "pi" ? nativeSessionId : id);
    await assert.rejects(importNativeArchive({ source, target, harness, nativeSessionId, id, cwd: root }), /EEXIST/);
    assert.deepEqual(await readFile(target), working);
    assert.equal((await readdir(root)).some((name) => name.endsWith(".importing")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("codex import refuses an archive whose history_base reference it cannot satisfy", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-import-"));
  try {
    const source = join(root, "raw"), target = join(root, "working");
    const nativeSessionId = randomUUID(), id = randomUUID();
    const header = { type: "session_meta", payload: { id: nativeSessionId, cwd: "/old", history_mode: "paginated", history_base: { thread_id: randomUUID(), end_ordinal_exclusive: 4, end_byte_offset: 120 } } };
    const tail = Buffer.from('{ "type": "event_msg", "payload": { "text": "leaf" } }\n');
    await writeFile(source, Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), tail]));
    await assert.rejects(importNativeArchive({ source, target, harness: "codex", nativeSessionId, id, cwd: root }), /references history it does not carry/, "a leaf archive without its ancestor must not silently truncate history");
  } finally { await rm(root, { recursive: true, force: true }); }
});
