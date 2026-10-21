import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { RUNTIME_MAX_FRAME_BYTES } from "@neta-art/cohub";
import type { JsonRecord } from "../json-rpc.js";

/** A structurally unrestorable archive (e.g. its history reference is not carried); never retried. */
export class ArchiveNotRestorableError extends Error {
  constructor(message: string) { super(message); this.name = "ArchiveNotRestorableError"; }
}

const NEWLINE = Buffer.from("\n");
const SESSION_ID_KEY = Buffer.from('"sessionId"');

/** End of the JSON string starting at `start`, or -1 when the line ends inside it. */
function stringEnd(line: Buffer, start: number) {
  for (let index = start + 1; index < line.length; index++) {
    if (line[index] === 0x5c) index++;
    else if (line[index] === 0x22) return index;
  }
  return -1;
}

const skipSpace = (line: Buffer, index: number) => {
  while ([0x20, 0x09, 0x0d].includes(line[index] ?? -1)) index++;
  return index;
};

/**
 * Replace the top-level `sessionId` string of one JSON line; every other byte, including numbers a
 * parser would round and lines that are not JSON, is kept as written. Structural JSON bytes are
 * ASCII, which UTF-8 never uses inside a multi-byte character, so bytes are scanned directly.
 */
function rebindLine(line: Buffer, sessionId: string): Buffer {
  let depth = 0;
  for (let index = 0; index < line.length; index++) {
    const byte = line[index];
    if (byte === 0x22) {
      const end = stringEnd(line, index);
      if (end < 0) return line;
      const colon = skipSpace(line, end + 1);
      if (depth === 1 && line[colon] === 0x3a && line.subarray(index, end + 1).equals(SESSION_ID_KEY)) {
        const value = skipSpace(line, colon + 1);
        const valueEnd = line[value] === 0x22 ? stringEnd(line, value) : -1;
        if (valueEnd < 0) return line;
        return Buffer.concat([line.subarray(0, value), Buffer.from(JSON.stringify(sessionId)), line.subarray(valueEnd + 1)]);
      }
      index = end;
    } else if (byte === 0x7b || byte === 0x5b) depth++;
    else if (byte === 0x7d || byte === 0x5d) depth--;
  }
  return line;
}

/**
 * Create a working copy of raw archive bytes. The header line may be rewritten, or with `sessionId`
 * the top-level session id of every line; the target is created exclusively, so an existing native
 * file is never replaced.
 */
export async function copyNativeArchive(input: { source: string; target: string; signal?: AbortSignal; header?: (header: JsonRecord) => JsonRecord; sessionId?: string }) {
  await mkdir(dirname(input.target), { recursive: true, mode: 0o700 });
  const temporary = `${input.target}.${randomUUID()}.importing`;
  const file = await open(temporary, "wx", 0o600);
  const digest = createHash("sha256");
  let headerReady = !input.header, headerBytes = 0;
  const fragments: Buffer[] = [];
  const write = async (bytes: Buffer) => { digest.update(bytes); await file.writeFile(bytes); };
  const writeHeader = async () => {
    const header = input.header?.(JSON.parse(Buffer.concat(fragments).toString("utf8")) as JsonRecord);
    await write(Buffer.from(`${JSON.stringify(header)}\n`));
    fragments.length = 0; headerReady = true;
  };
  try {
    if (input.sessionId) {
      const sessionId = input.sessionId;
      const line: Buffer[] = [];
      let lineBytes = 0;
      const flush = async (newline: boolean) => {
        const bytes = Buffer.concat(line);
        line.length = 0; lineBytes = 0;
        await write(Buffer.concat([rebindLine(bytes, sessionId), newline ? NEWLINE : Buffer.alloc(0)]));
      };
      for await (const chunk of createReadStream(input.source, { signal: input.signal })) {
        let bytes = chunk as Buffer;
        for (let newline = bytes.indexOf(10); newline >= 0; newline = bytes.indexOf(10)) {
          line.push(bytes.subarray(0, newline));
          await flush(true);
          bytes = bytes.subarray(newline + 1);
        }
        lineBytes += bytes.length;
        if (lineBytes > RUNTIME_MAX_FRAME_BYTES) throw new Error("Native record is too large");
        if (bytes.length) line.push(bytes);
      }
      if (line.length) await flush(false);
    } else {
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
    }
    input.signal?.throwIfAborted();
    await file.sync(); await file.close();
    await link(temporary, input.target);
    if (process.platform !== "win32") {
      const directory = await open(dirname(input.target), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return { checksum: digest.digest("hex") };
  } finally { await file.close(); await rm(temporary, { force: true }); }
}
