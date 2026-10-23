import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const BOARD_TRANSACTION_INPUT_MAX_BYTES = 16 * 1024 * 1024;
export const BOARD_CREATE_INPUT_MAX_BYTES = 32 * 1024 * 1024;
export const BOARD_DOMAIN_INPUT_MAX_BYTES = 1024 * 1024;

export function parseBoardJsonObject(
  text: string,
  source = "input",
): Record<string, unknown> {
  if (!text.trim()) throw new Error(`${source} is empty`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${source} must contain valid JSON`, { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function readStdinBounded(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new Error(`stdin exceeds the ${maxBytes} byte input limit`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readBoardJsonObject(
  source: string,
  maxBytes = BOARD_DOMAIN_INPUT_MAX_BYTES,
): Promise<Record<string, unknown>> {
  if (source === "-") return parseBoardJsonObject(await readStdinBounded(maxBytes), "stdin");
  const handle = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${source} must be a regular file`);
    if (info.size > maxBytes) throw new Error(`${source} exceeds the ${maxBytes} byte input limit`);
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(64 * 1024, maxBytes + 1)));
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error(`${source} exceeds the ${maxBytes} byte input limit`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return parseBoardJsonObject(Buffer.concat(chunks).toString("utf8"), source);
  } finally {
    await handle.close();
  }
}

export async function writeBoardOutput(
  path: string,
  bytes: Uint8Array,
  force = false,
): Promise<void> {
  if (!force) {
    await access(path).then(
      () => { throw new Error(`Output already exists: ${path}; use --force to replace it`); },
      () => undefined,
    );
  }
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (force) await rename(temp, path);
    else {
      await link(temp, path);
      await unlink(temp);
    }
  } catch (cause) {
    await unlink(temp).catch(() => undefined);
    throw cause;
  }
}
