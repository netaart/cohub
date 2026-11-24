import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, link, open, rename, stat, unlink } from "node:fs/promises";
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

async function readBounded(stream: AsyncIterable<Buffer | string>, maxBytes: number, source: string): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) throw new Error(`${source} exceeds the ${maxBytes} byte input limit`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readBoardJsonObject(
  source: string,
  maxBytes = BOARD_DOMAIN_INPUT_MAX_BYTES,
): Promise<Record<string, unknown>> {
  if (source === "-") return parseBoardJsonObject(await readBounded(process.stdin, maxBytes, "stdin"), "stdin");
  if ((await stat(source)).isFIFO()) return parseBoardJsonObject(await readBounded(createReadStream(source), maxBytes, source), source);
  const handle = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${source} must be a file or a pipe`);
    if (info.size > maxBytes) throw new Error(`${source} exceeds the ${maxBytes} byte input limit`);
    return parseBoardJsonObject(await readBounded(handle.createReadStream({ autoClose: false }), maxBytes, source), source);
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

export const BOARD_SIMULATION_MODES = ["edit", "play", "view"] as const;
export const BOARD_SIMULATION_POINTERS = ["fine", "coarse"] as const;
export const BOARD_SIMULATION_VIEWPORT = { width: 1280, height: 800 };

export function parseBoardSize(value: string, name: string): { width: number; height: number } {
  const size = /^(\d+)x(\d+)$/.exec(value.trim());
  const width = Number(size?.[1]);
  const height = Number(size?.[2]);
  if (!(width >= 1 && width <= 8192 && height >= 1 && height <= 8192)) throw new Error(`${name} must be widthxheight up to 8192x8192, e.g. 1600x900.`);
  return { width, height };
}
