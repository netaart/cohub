import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve, win32 } from "node:path";
import type { ContentBlock, RuntimeCapabilities } from "@neta-art/cohub";
import { JsonRpcProcess, record, type JsonRecord } from "./json-rpc.js";
import { codexModelCatalog } from "./model-catalog.js";
import { downloadPublicImage } from "../safe-remote-image.js";

export type HarnessOptions = { pi?: string; codex?: string };

export function harnessExecutableCandidates(binary: string, cwd: string, path: string, platform = process.platform, pathExt = process.env.PATHEXT): string[] {
  const windows = platform === "win32";
  const paths = windows ? win32 : { delimiter, join, resolve };
  const extensions = windows && !win32.extname(binary)
    ? ["", ...(pathExt || ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => /^\.[a-z0-9]+$/i.test(ext))]
    : [""];
  const roots = binary.includes("/") || binary.includes("\\")
    ? [paths.resolve(cwd, binary)]
    : path.split(paths.delimiter).map((directory) => directory.replace(/^"(.*)"$/, "$1")).filter(Boolean).map((directory) => paths.resolve(cwd, directory, binary));
  return roots.flatMap((root) => extensions.map((ext) => `${root}${ext}`));
}

/** Discover installed executables only; authentication/capability errors stay explicit. */
export async function installedHarnesses(cwd: string, options: HarnessOptions, path = process.env.PATH ?? ""): Promise<("pi" | "codex")[]> {
  const names = options.pi || options.codex ? (["pi", "codex"] as const).filter((name) => options[name]) : ["pi", "codex"] as const;
  const found = await Promise.all(names.map(async (name) => {
    const binary = options[name] || name;
    const candidates = harnessExecutableCandidates(binary, cwd, path);
    for (const candidate of candidates) {
      try { await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); if ((await stat(candidate)).isFile()) return name; }
      catch { /* Try the next PATH entry. */ }
    }
    return null;
  }));
  return found.filter((name): name is "pi" | "codex" => name !== null);
}
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown) => typeof value === "string" ? value : "";

/** A stream cut off mid tool call leaves an empty shell; it says nothing and travels nowhere. */
const identifiable = (id: unknown) => typeof id === "string" && id.length > 0;

/** Map Pi content onto Cohub blocks, dropping streaming residue: tool calls and results without an id. */
export function piContent(value: unknown): ContentBlock[] {
  return array(value).flatMap((entry): ContentBlock[] => {
    const block = record(entry);
    if (block.type === "text") return [{ type: "text", text: text(block.text) }];
    if (block.type === "thinking") return [{ type: "thinking", thinking: text(block.thinking), ...(typeof (block.thinkingSignature ?? block.signature) === "string" ? { signature: String(block.thinkingSignature ?? block.signature) } : {}) }];
    if (block.type === "toolCall") return identifiable(block.id) && identifiable(block.name) ? [{ type: "tool_use", id: text(block.id), name: text(block.name), input: record(block.arguments) }] : [];
    if (block.type === "image") return [{ type: "image", source: { type: "base64", data: text(block.data), media_type: text(block.mimeType) } }];
    return [{ type: "text", text: JSON.stringify(block) }];
  });
}

export async function imageForPi(block: Extract<ContentBlock, { type: "image" }>) {
  if (block.source.type === "base64") return { type: "image", data: block.source.data, mimeType: block.source.media_type };
  const image = await downloadPublicImage(block.source.url);
  return { type: "image", data: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType };
}

async function initializeCodex(rpc: JsonRpcProcess) {
  await rpc.request("initialize", { clientInfo: { name: "cohub", title: "Cohub", version: "1" }, capabilities: { experimentalApi: true } });
  rpc.write({ method: "initialized", params: {} });
}

export async function discoverHarnesses(harnesses: ("pi" | "codex")[], options: HarnessOptions, cwd: string): Promise<RuntimeCapabilities> {
  const models: RuntimeCapabilities["models"] = [];
  await Promise.all(harnesses.map(async (harness) => {
    const rpc = new JsonRpcProcess(options[harness] || harness, harness === "pi" ? ["--mode", "rpc", "--no-session"] : ["app-server", "--listen", "stdio://"], cwd, harness);
    try {
      if (harness === "pi") {
        const result = await rpc.request("get_available_models");
        for (const value of array(result.models)) {
          const model = record(value);
          if (model.id && model.provider) models.push({ harness, id: text(model.id), provider: text(model.provider), name: text(model.name) || text(model.id) });
        }
      } else {
        await initializeCodex(rpc);
        const config = await rpc.request("config/read", { includeLayers: false, cwd });
        const entries: unknown[] = [];
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const result = await rpc.request("model/list", { cursor, limit: 100 });
          entries.push(...array(result.data));
          cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
          if (entries.length > 2000 || cursor && cursors.has(cursor)) throw new Error("Invalid model catalog pagination");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        models.push(...codexModelCatalog(config, entries));
      }
    } finally { await rpc.close(); }
  }));
  return { harnesses, models };
}

export function codexItemContent(item: JsonRecord): ContentBlock[] {
  if (item.type === "agentMessage" || item.type === "plan") return [{ type: "text", text: text(item.text) }];
  if (item.type === "reasoning") return [{ type: "thinking", thinking: [...array(item.summary), ...array(item.content)].map(text).join("\n") }];
  if (item.type === "userMessage") return [];
  if (item.type === "contextCompaction") return [{ type: "system_note", note_type: "compacted", text: "Context compacted" }];
  const id = text(item.id);
  if (!identifiable(item.id)) return [];
  const name = item.type === "commandExecution" ? "bash" : item.type === "fileChange" ? "apply_patch" : text(item.tool) || text(item.type);
  const input = item.type === "commandExecution" ? { command: item.command, cwd: item.cwd } : item.type === "fileChange" ? { changes: item.changes } : record(item.arguments);
  return [
    { type: "tool_use", id, name, input },
    { type: "tool_result", tool_use_id: id, content: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : JSON.stringify(item.result ?? item.error ?? item.changes ?? item), is_error: item.status === "failed" || typeof item.exitCode === "number" && item.exitCode !== 0 },
  ];
}

