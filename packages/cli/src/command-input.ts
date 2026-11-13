import { readFile } from "node:fs/promises";
import { error } from "./output.js";

export function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

export async function readPromptContent(words: string[], options: { allowEmpty?: boolean } = {}): Promise<string> {
  let content = words.join(" ");
  if (!content && !process.stdin.isTTY) content = (await readStdin()).trim();
  if (!content && !options.allowEmpty) return error("No content", "Pass as argument or pipe via stdin");
  return content;
}

/** Content blocks given as an inline JSON array, a JSON file path, or `-` for stdin; sent as given. */
export async function readContentBlocks(source: string): Promise<Record<string, unknown>[]> {
  const text = source === "-"
    ? await readStdin()
    : source.trim().startsWith("[")
      ? source
      : await readFile(source, "utf-8").catch(() => error("Cannot read content", source));
  let blocks: unknown;
  try {
    blocks = JSON.parse(text);
  } catch {
    return error("Invalid content", "Expected a JSON array of content blocks, a path to a JSON file, or - for stdin");
  }
  if (!Array.isArray(blocks) || blocks.some((block) => !block || typeof block !== "object" || Array.isArray(block))) {
    return error("Invalid content", "Expected a JSON array of content block objects");
  }
  return blocks as Record<string, unknown>[];
}
