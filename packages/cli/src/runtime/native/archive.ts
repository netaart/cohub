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

/**
 * Create a working copy of raw archive bytes. Only the header line may be rewritten; the target is
 * created exclusively, so an existing native file is never replaced.
 */
export async function copyNativeArchive(input: { source: string; target: string; signal?: AbortSignal; header?: (header: JsonRecord) => JsonRecord }) {
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
    return { checksum: digest.digest("hex") };
  } finally { await file.close(); await rm(temporary, { force: true }); }
}
