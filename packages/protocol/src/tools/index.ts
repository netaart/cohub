import type { HarnessKind } from "../runtime/harnesses.js";
import { antigravity } from "./antigravity.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { cohub, pi } from "./cohub.js";
import { cursor } from "./cursor.js";
import { assemble, generic, type HarnessTool, type HarnessTools, type ToolInput, type ToolView } from "./view.js";

export type { ToolDiffLine, ToolField, ToolSection, ToolTarget, ToolTodo, ToolVerb, ToolView } from "./view.js";

const HARNESS_TOOLS: Readonly<Record<HarnessKind, HarnessTools>> = { cohub, pi, claude, workbuddy: claude, codex, cursor, antigravity };

const own = <T>(table: Readonly<Record<string, T>> | undefined, key: string) => table && Object.hasOwn(table, key) ? table[key] : undefined;
const identity = (path: string) => path;
const SUMMARY = new Set(["preview", "_truncated", "originalLength"]);
/** A settled Turn lists its calls with long values cut to `{ preview, _truncated, originalLength }`; the preview stands in. */
function previewed(value: unknown) {
  const summary = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  return summary && typeof summary.preview === "string" && Object.keys(summary).every((key) => SUMMARY.has(key)) ? summary.preview : value;
}
const harnessTools = (harness: HarnessKind) => HARNESS_TOOLS[harness] ?? cohub;

function resolve(tools: HarnessTools, name: string): HarnessTool {
  const adapter = own(tools.tools, name);
  if (adapter) return { label: own(tools.labels, name) ?? name, adapter };
  return tools.other?.(name) ?? { label: name, adapter: generic };
}

export const toolLabel = (harness: HarnessKind, name: string) => resolve(harnessTools(harness), name).label;

export function presentTool(harness: HarnessKind, name: string, input: ToolInput | undefined): ToolView {
  const tools = harnessTools(harness);
  const { label, adapter } = resolve(tools, name);
  const args = Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => [key, previewed(value)]));
  const context = { path: tools.path ?? identity };
  try { return assemble(name, label, args, adapter(args, context)); }
  catch { return assemble(name, label, args, generic(args, context)); }
}
