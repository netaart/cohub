import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { RUNTIME_MAX_FRAME_BYTES } from "@neta-art/cohub";
import { readTranscriptLines } from "./transcript.js";
import { readWorkBuddyTranscript } from "./workbuddy-transcript.js";

/** A structurally unrestorable archive (e.g. its history reference is not carried); never retried. */
export class ArchiveNotRestorableError extends Error {
  constructor(message: string) { super(message); this.name = "ArchiveNotRestorableError"; }
}

/** Change only the header of a working copy. Raw archive bytes remain untouched. */
export async function importNativeArchive(input: {
  source: string; target: string; harness: "pi" | "codex" | "workbuddy"; nativeSessionId: string; id: string; cwd: string; signal?: AbortSignal;
}) {
  if (input.harness === "workbuddy") return importWorkBuddyArchive(input);
  await mkdir(dirname(input.target), { recursive: true, mode: 0o700 });
  const temporary = `${input.target}.${randomUUID()}.importing`;
  const file = await open(temporary, "wx", 0o600);
  const digest = createHash("sha256");
  let headerReady = false, headerBytes = 0;
  const fragments: Buffer[] = [];
  const write = async (bytes: Buffer) => { digest.update(bytes); await file.writeFile(bytes); };
  const writeHeader = async () => {
    const header = JSON.parse(Buffer.concat(fragments).toString("utf8"));
    if (input.harness === "pi") {
      if (header?.type !== "session" || header.id !== input.nativeSessionId) throw new Error("Pi archive identity mismatch");
      header.cwd = input.cwd; delete header.parentSession;
    } else {
      if (header?.type !== "session_meta" || header.payload?.id !== input.nativeSessionId) throw new Error("Codex archive identity mismatch");
      // A leaf archive does not carry its ancestor rollout.
      if (header.payload?.history_base != null) throw new ArchiveNotRestorableError("Codex archive references history it does not carry; rebuild from the Session instead");
      header.payload.id = input.id;
      if (header.payload.session_id != null) header.payload.session_id = input.id;
      header.payload.history_mode = "legacy";
      header.payload.cwd = input.cwd;
    }
    await write(Buffer.from(`${JSON.stringify(header)}\n`));
    fragments.length = 0; headerReady = true;
  };
  try {
    for await (const bytes of createReadStream(input.source, { signal: input.signal })) {
      if (headerReady) { await write(bytes); continue; }
      const newline = bytes.indexOf(10);
      const prefix = newline < 0 ? bytes : bytes.subarray(0, newline);
      headerBytes += prefix.length;
      if (headerBytes > RUNTIME_MAX_FRAME_BYTES) throw new Error("Native header is too large");
      fragments.push(prefix);
      if (newline >= 0) { await writeHeader(); await write(bytes.subarray(newline + 1)); }
    }
    if (!headerReady) await writeHeader();
    input.signal?.throwIfAborted();
    await file.sync(); await file.close();
    await link(temporary, input.target);
    if (process.platform !== "win32") {
      const directory = await open(dirname(input.target), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return { checksum: digest.digest("hex"), nativeSessionId: input.harness === "pi" ? input.nativeSessionId : input.id };
  } finally { await file.close(); await rm(temporary, { force: true }); }
}

/** WorkBuddy repeats its identity on every record. Validate a private snapshot before rebinding. */
async function importWorkBuddyArchive(input: { source: string; target: string; nativeSessionId: string; id: string; cwd: string; signal?: AbortSignal }) {
  await mkdir(dirname(input.target), { recursive: true, mode: 0o700 });
  const temporary = `${input.target}.${randomUUID()}.importing`, snapshot = `${temporary}.raw`;
  try {
    await copyFile(input.source, snapshot, constants.COPYFILE_EXCL);
    const transcript = await readWorkBuddyTranscript(snapshot, { settled: true, signal: input.signal });
    if (transcript.nativeSessionId !== input.nativeSessionId) throw new Error("WorkBuddy archive identity mismatch");
    const size = (await stat(snapshot)).size;
    if (!transcript.prefixes.has(size)) throw new ArchiveNotRestorableError("WorkBuddy archive has an incomplete trailing record; original retained");
    const read = await readTranscriptLines(createReadStream(snapshot, { signal: input.signal }));
    const file = await open(temporary, "wx", 0o600), digest = createHash("sha256");
    try {
      for (const line of read.lines) {
        input.signal?.throwIfAborted();
        const row = line.value;
        if (row.sessionId != null) {
          if (row.sessionId !== input.nativeSessionId) throw new Error("WorkBuddy archive identity mismatch");
          row.sessionId = input.id;
        }
        if (row.cwd != null) row.cwd = input.cwd;
        const bytes = Buffer.from(`${JSON.stringify(row, (_key, value: unknown) => {
          if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new ArchiveNotRestorableError("WorkBuddy archive contains an unsafe integer; original retained");
          return value;
        })}\n`);
        digest.update(bytes); await file.writeFile(bytes);
      }
      await file.sync();
    } finally { await file.close(); }
    await link(temporary, input.target);
    if (process.platform !== "win32") {
      const directory = await open(dirname(input.target), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return { checksum: digest.digest("hex"), nativeSessionId: input.id };
  } finally { await rm(temporary, { force: true }); await rm(snapshot, { force: true }); }
}
