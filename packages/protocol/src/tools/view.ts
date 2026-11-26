export type ToolVerb = "run" | "read" | "write" | "edit" | "delete" | "search" | "list" | "fetch" | "delegate" | "plan" | "ask";

export type ToolTarget = { kind: "command" | "path" | "text"; text: string };
export type ToolField = { label: string; value: string; mono?: boolean };
export type ToolDiffLine = { sign: "+" | "-" | " "; text: string };
export type ToolTodo = { text: string; status: "pending" | "in_progress" | "completed" };

type ToolSectionBody =
  | { kind: "text"; text: string }
  | { kind: "json"; text: string }
  | { kind: "diff"; path?: string; lines: ToolDiffLine[]; before?: string; after?: string }
  | { kind: "todos"; items: ToolTodo[] };
export type ToolSectionSpec = { label: string } & ToolSectionBody;
export type ToolSection = { id: string } & ToolSectionSpec;

/**
 * A tool call as every client shows it, derived from the stored call on read and never stored.
 * Harness adapters own every difference in shape; renderers only draw these parts.
 */
export type ToolView = {
  name: string;
  label: string;
  verb: ToolVerb;
  target?: ToolTarget;
  subtitle?: string;
  primary?: ToolTarget;
  fields: ToolField[];
  sections: ToolSection[];
  quietResult?: boolean;
};

export type ToolInput = Record<string, unknown>;
export type ToolContext = { path(path: string): string };
type Spec<T> = T | null | undefined | false | "" | 0;
export type ToolSpec = {
  verb: ToolVerb;
  target?: Spec<ToolTarget>;
  subtitle?: string;
  primary?: Spec<ToolTarget>;
  fields?: Spec<ToolField>[];
  sections?: Spec<ToolSectionSpec>[];
  uses?: readonly string[];
  quietResult?: boolean;
};
export type ToolAdapter = (input: ToolInput, context: ToolContext) => ToolSpec;
export type HarnessTool = { label: string; adapter: ToolAdapter };

export type HarnessTools = {
  tools: Readonly<Record<string, ToolAdapter>>;
  labels?: Readonly<Record<string, string>>;
  other?(name: string): HarnessTool | null;
  path?(path: string): string;
};

const LONG_FIELD = 120;
const SUMMARY_LIMIT = 240;

export const string = (value: unknown) => typeof value === "string" && value ? value : undefined;
export const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
export const object = (value: unknown): ToolInput => value && typeof value === "object" && !Array.isArray(value) ? value as ToolInput : {};
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export type Keys = string | readonly string[];
const keysOf = (keys: Keys | undefined): readonly string[] => keys === undefined ? [] : typeof keys === "string" ? [keys] : keys;
export function pick(input: ToolInput, keys: Keys | undefined): unknown {
  for (const key of keysOf(keys)) if (input[key] !== undefined && input[key] !== null) return input[key];
  return undefined;
}

function json(value: unknown) {
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

function remaining(input: ToolInput, used: ReadonlySet<string>, fields: ToolField[], sections: ToolSectionSpec[]) {
  for (const [key, value] of Object.entries(input)) {
    if (used.has(key) || value === undefined || value === null) continue;
    if (typeof value === "string") {
      if (value.length > LONG_FIELD || value.includes("\n")) sections.push({ kind: "text", label: key, text: value });
      else fields.push({ label: key, value, mono: true });
    } else if (typeof value === "number" || typeof value === "boolean") fields.push({ label: key, value: String(value) });
    else if (typeof value === "object" && Object.keys(value).length) sections.push({ kind: "json", label: key, text: json(value) });
  }
}

const present = <T>(value: Spec<T>): value is T => Boolean(value);

export function assemble(name: string, label: string, input: ToolInput, spec: ToolSpec): ToolView {
  const fields = (spec.fields ?? []).filter(present);
  const sections = (spec.sections ?? []).filter(present);
  remaining(input, new Set(spec.uses ?? []), fields, sections);
  const target = present(spec.target) && spec.target.text ? spec.target : undefined;
  const primary = present(spec.primary) && spec.primary.text ? spec.primary : undefined;
  return {
    name, label, verb: spec.verb,
    ...(target ? { target } : {}),
    ...(spec.subtitle ? { subtitle: spec.subtitle } : {}),
    ...(primary ? { primary } : {}),
    fields,
    sections: sections.map((section, index) => ({ ...section, id: String(index) })),
    ...(spec.quietResult ? { quietResult: true } : {}),
  };
}

const SUMMARY_KEYS: readonly [string, ToolTarget["kind"]][] = [
  ["command", "command"], ["cmd", "command"], ["path", "path"], ["file_path", "path"], ["url", "text"], ["query", "text"],
  ["pattern", "text"], ["description", "text"], ["prompt", "text"], ["skill", "text"], ["name", "text"],
];

export function summarize(input: ToolInput): ToolTarget | undefined {
  for (const [key, kind] of SUMMARY_KEYS) {
    const value = string(input[key]);
    if (value) return { kind, text: value };
  }
  if (!Object.keys(input).length) return undefined;
  const text = JSON.stringify(input) ?? "";
  return { kind: "text", text: text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT)}…` : text };
}

export const generic: ToolAdapter = (input) => ({ verb: "run", target: summarize(input) });
