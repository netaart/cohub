import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { RUNTIME_MAX_FRAME_BYTES } from "@neta-art/cohub";
import { JsonLineDecoder } from "./json-rpc.js";
import { codexArchiveTotals, type CodexTokenTotals } from "./codex-usage.js";

/** A structurally unrestorable archive (e.g. its history reference is not carried); never retried. */
export class ArchiveNotRestorableError extends Error {
  constructor(message: string) { super(message); this.name = "ArchiveNotRestorableError"; }
}

export async function readCodexArchiveTotals(path: string) {
  let totals: CodexTokenTotals | undefined;
  const decoder = new JsonLineDecoder((row) => { totals = codexArchiveTotals([row]) ?? totals; });
  for await (const bytes of createReadStream(path)) decoder.push(bytes);
  decoder.end();
  return totals;
}

/** Change only the header of a working copy. Raw archive bytes remain untouched. */
export async function importNativeArchive(input: {
  source: string; target: string; harness: "pi" | "codex"; nativeSessionId: string; id: string; cwd: string; signal?: AbortSignal;
}) {
  await mkdir(dirname(input.target), { recursive: true, mode: 0o700 });
  const temporary = `${input.target}.${randomUUID()}.importing`;
  const file = await open(temporary, "wx", 0o600);
  const digest = createHash("sha256");
  let headerReady = false, headerBytes = 0;
  const fragments: Buffer[] = [];
  let totals: CodexTokenTotals | undefined;
  const decoder = input.harness === "codex" ? new JsonLineDecoder((row) => { totals = codexArchiveTotals([row]) ?? totals; }) : null;
  const write = async (bytes: Buffer) => { digest.update(bytes); await file.writeFile(bytes); };
  const writeHeader = async () => {
    const header = JSON.parse(Buffer.concat(fragments).toString("utf8"));
    if (input.harness === "pi") {
      if (header?.type !== "session" || header.id !== input.nativeSessionId) throw new Error("Pi archive identity mismatch");
      header.cwd = input.cwd; delete header.parentSession;
    } else {
      if (header?.type !== "session_meta" || header.payload?.id !== input.nativeSessionId) throw new Error("Codex archive identity mismatch");
      // A leaf archive does not carry its ancestor rollout. Importing it as-is would resume with
      // silently truncated history; failing lets the caller rebuild from durable cloud Turns.
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
      decoder?.push(bytes);
      if (headerReady) { await write(bytes); continue; }
      const newline = bytes.indexOf(10);
      const prefix = newline < 0 ? bytes : bytes.subarray(0, newline);
      headerBytes += prefix.length;
      if (headerBytes > RUNTIME_MAX_FRAME_BYTES) throw new Error("Native header is too large");
      fragments.push(prefix);
      if (newline >= 0) { await writeHeader(); await write(bytes.subarray(newline + 1)); }
    }
    if (!headerReady) await writeHeader();
    decoder?.end();
    input.signal?.throwIfAborted();
    await file.sync(); await file.close();
    await link(temporary, input.target);
    if (process.platform !== "win32") {
      const directory = await open(dirname(input.target), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    return { checksum: digest.digest("hex"), nativeSessionId: input.harness === "pi" ? input.nativeSessionId : input.id, codexTokenTotals: totals };
  } finally { await file.close(); await rm(temporary, { force: true }); }
}
