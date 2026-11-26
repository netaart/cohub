import { list, number, object, pick, string, summarize, type HarnessTool, type Keys, type ToolAdapter, type ToolContext, type ToolDiffLine, type ToolInput, type ToolSectionSpec, type ToolSpec, type ToolTarget, type ToolTodo } from "./view.js";

const text = (value: unknown) => typeof value === "string" ? value : undefined;
const shown = (...entries: [Keys | undefined, unknown][]) => entries.flatMap(([keys, value]) => keys !== undefined && value !== undefined && value !== false ? (typeof keys === "string" ? [keys] : keys) : []);

const SHELL = /^(?:\S*\/)?(?:ba|z)?sh$/;
const WRAPPED = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\[\s\S])*)")\s*$/;
export function shellText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const args = value.filter((arg): arg is string => typeof arg === "string");
    if (args.length === 3 && SHELL.test(args[0] ?? "") && /^-l?c$/.test(args[1] ?? "")) return args[2] || undefined;
    return args.map((arg) => /[\s"'$`\\]/.test(arg) ? `'${arg.replaceAll("'", `'\\''`)}'` : arg).join(" ") || undefined;
  }
  const command = string(value);
  const wrapped = command ? WRAPPED.exec(command) : null;
  if (!wrapped) return command;
  return wrapped[1] !== undefined ? wrapped[1].replaceAll(`'\\''`, "'") : (wrapped[2] ?? "").replace(/\\(["\\$`])/g, "$1");
}

export function duration(value: unknown, unit: "s" | "ms"): string | undefined {
  const amount = number(value);
  if (amount === undefined) return undefined;
  const ms = unit === "s" ? amount * 1000 : amount;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60}m` : `${Number(seconds.toFixed(1))}s`;
}

const pathView = (path: string | undefined, context: ToolContext): Pick<ToolSpec, "target" | "primary"> => path
  ? { target: { kind: "path", text: path }, primary: { kind: "path", text: context.path(path) } }
  : {};

export const shell = (keys: { command: Keys; cwd?: Keys; timeout?: Keys; timeoutUnit?: "s" | "ms"; description?: Keys }): ToolAdapter => (input) => {
  const command = shellText(pick(input, keys.command));
  const cwd = string(pick(input, keys.cwd));
  const timeout = duration(pick(input, keys.timeout), keys.timeoutUnit ?? "s");
  const description = string(pick(input, keys.description));
  const target: ToolTarget | undefined = command ? { kind: "command", text: command } : undefined;
  return {
    verb: "run", target, primary: target, subtitle: description,
    fields: [cwd && { label: "cwd", value: cwd, mono: true }, timeout && { label: "timeout", value: timeout }],
    uses: shown([keys.command, command], [keys.cwd, cwd], [keys.timeout, timeout], [keys.description, description]),
  };
};

export const readFile = (keys: { path: Keys; offset?: Keys; limit?: Keys; end?: Keys }): ToolAdapter => (input, context) => {
  const path = string(pick(input, keys.path));
  const start = number(pick(input, keys.offset));
  const limit = number(pick(input, keys.limit));
  const end = number(pick(input, keys.end)) ?? (start !== undefined && limit !== undefined ? start + limit - 1 : undefined);
  const range = start !== undefined && end !== undefined ? `${start}–${end}` : undefined;
  return {
    verb: "read", ...pathView(path, context),
    fields: [range && { label: "lines", value: range }],
    uses: shown([keys.path, path], [keys.offset, range], [keys.limit, range], [keys.end, range]),
  };
};

export const writeFile = (keys: { path: Keys; content: Keys }): ToolAdapter => (input, context) => {
  const path = string(pick(input, keys.path));
  const content = text(pick(input, keys.content));
  return {
    verb: "write", ...pathView(path, context),
    sections: [content !== undefined && { kind: "text", label: "content", text: content }],
    uses: shown([keys.path, path], [keys.content, content]),
  };
};

export const deleteFile = (keys: { path: Keys }): ToolAdapter => (input, context) => {
  const path = string(pick(input, keys.path));
  return { verb: "delete", ...pathView(path, context), uses: shown([keys.path, path]) };
};

export const listFiles = (keys: { path: Keys }): ToolAdapter => (input, context) => {
  const path = string(pick(input, keys.path));
  return { verb: "list", ...pathView(path, context), uses: shown([keys.path, path]) };
};

export function replacement(before: string | undefined, after: string | undefined): { lines: ToolDiffLine[]; before?: string; after?: string } {
  return {
    lines: [
      ...(before === undefined ? [] : before.split("\n").map((line): ToolDiffLine => ({ sign: "-", text: line }))),
      ...(after === undefined ? [] : after.split("\n").map((line): ToolDiffLine => ({ sign: "+", text: line }))),
    ],
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

export const editFile = (keys: { path: Keys; edits?: Keys; old: Keys; new: Keys }): ToolAdapter => (input, context) => {
  const path = string(pick(input, keys.path));
  const edits = keys.edits ? pick(input, keys.edits) : undefined;
  const pairs = Array.isArray(edits) ? edits : [input];
  const sections = pairs.map((pair, index): ToolSectionSpec | null => {
    const label = Array.isArray(edits) ? `#${index + 1}` : "diff";
    const before = text(pick(object(pair), keys.old)), after = text(pick(object(pair), keys.new));
    if (before !== undefined || after !== undefined) return { kind: "diff", label, ...replacement(before, after) };
    return Array.isArray(edits) ? { kind: "json", label, text: JSON.stringify(pair, null, 2) ?? String(pair) } : null;
  });
  const single = !Array.isArray(edits) && sections[0] !== null;
  return {
    verb: "edit", ...pathView(path, context), sections,
    uses: shown([keys.path, path], [keys.edits, Array.isArray(edits) || undefined], [keys.old, single || undefined], [keys.new, single || undefined]),
  };
};

const diffLine = (line: string): ToolDiffLine => {
  const sign = line[0];
  return sign === "+" || sign === "-" || sign === " " ? { sign, text: line.slice(1) } : { sign: " ", text: line };
};

export function unifiedLines(diff: string): ToolDiffLine[] {
  let hunk = false;
  return diff.split("\n").flatMap((line): ToolDiffLine[] => {
    hunk ||= line.startsWith("@@");
    return !hunk && /^(?:diff --git |index |--- |\+\+\+ )/.test(line) || line.startsWith("\\ No newline") ? [] : [diffLine(line)];
  });
}

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
export function patchSections(patch: string): ToolSectionSpec[] {
  const sections: Extract<ToolSectionSpec, { kind: "diff" }>[] = [];
  for (const line of patch.split("\n")) {
    const file = PATCH_FILE.exec(line);
    const current = sections.at(-1);
    if (file) sections.push({ kind: "diff", label: (file[1] ?? "").toLowerCase(), path: file[2]?.trim() ?? "", lines: [] });
    else if (line.startsWith("*** Move to: ") && current) current.path = `${current.path} → ${line.slice("*** Move to: ".length).trim()}`;
    else if (current && !line.startsWith("*** ")) current.lines.push(diffLine(line));
  }
  return sections.length ? sections : [{ kind: "text", label: "patch", text: patch }];
}

const firstPath = (sections: ToolSectionSpec[]): ToolTarget | undefined => {
  const paths = sections.flatMap((section) => section.kind === "diff" && section.path ? [section.path] : []);
  return paths[0] ? { kind: "path", text: paths.length > 1 ? `${paths[0]} +${paths.length - 1}` : paths[0] } : undefined;
};

export const applyPatch = (keys: { patch: Keys }): ToolAdapter => (input) => {
  const patch = string(pick(input, keys.patch));
  const sections = patch ? patchSections(patch) : [];
  return { verb: "edit", target: firstPath(sections), sections, uses: shown([keys.patch, patch]) };
};

export const fileChanges = (keys: { changes: Keys }): ToolAdapter => (input) => {
  const value = pick(input, keys.changes);
  const entries: ToolInput[] = Array.isArray(value) ? value.map(object) : Object.entries(object(value)).flatMap(([path, change]) => change && typeof change === "object" ? [{ path, ...object(change) }] : []);
  const sections = entries.map((change): ToolSectionSpec => {
    const kind = string(change.kind) ?? string(object(change.kind).type) ?? string(change.type) ?? "update";
    const moved = string(object(change.kind).move_path) ?? string(change.move_path);
    const path = `${string(change.path) ?? ""}${moved ? ` → ${moved}` : ""}`;
    const body = text(change.diff) ?? text(change.unified_diff) ?? text(change.content) ?? "";
    const lines = kind === "add" ? body.split("\n").map((line): ToolDiffLine => ({ sign: "+", text: line })) : kind === "delete" ? [] : unifiedLines(body);
    return { kind: "diff", label: kind, path, lines };
  });
  return { verb: "edit", target: firstPath(sections), sections, uses: shown([keys.changes, entries.length || undefined]) };
};

export const search = (keys: { pattern: Keys; path?: Keys }): ToolAdapter => (input, context) => {
  const pattern = string(pick(input, keys.pattern));
  const path = string(pick(input, keys.path));
  return {
    verb: "search",
    target: pattern && { kind: "text", text: [pattern, path].filter(Boolean).join(" · ") },
    primary: pattern && { kind: "text", text: pattern },
    fields: [path && { label: "path", value: context.path(path), mono: true }],
    uses: shown([keys.pattern, pattern], [keys.path, path]),
  };
};

export const webSearch = (keys: { query: Keys }): ToolAdapter => (input) => {
  const query = string(pick(input, keys.query));
  return { verb: "search", target: query && { kind: "text", text: query }, primary: query && { kind: "text", text: query }, uses: shown([keys.query, query]) };
};

export const fetchUrl = (keys: { url: Keys; prompt?: Keys }): ToolAdapter => (input) => {
  const url = string(pick(input, keys.url));
  const prompt = string(pick(input, keys.prompt));
  return {
    verb: "fetch", target: url && { kind: "text", text: url }, primary: url && { kind: "text", text: url },
    sections: [prompt && { kind: "text", label: "prompt", text: prompt }],
    uses: shown([keys.url, url], [keys.prompt, prompt]),
  };
};

export const delegate = (keys: { title: Keys; agent?: Keys; prompt?: Keys }): ToolAdapter => (input) => {
  const title = string(pick(input, keys.title));
  const agent = string(pick(input, keys.agent));
  const prompt = string(pick(input, keys.prompt));
  return {
    verb: "delegate", target: title && { kind: "text", text: title }, subtitle: agent,
    sections: [prompt && { kind: "text", label: "prompt", text: prompt }],
    uses: shown([keys.title, title], [keys.agent, agent], [keys.prompt, prompt]),
  };
};

function todoStatus(value: unknown): ToolTodo["status"] {
  const status = string(value) ?? "";
  if (/complete|done/i.test(status)) return "completed";
  return /progress|active|running/i.test(status) ? "in_progress" : "pending";
}

export const todos = (keys: { list: Keys; text: Keys; status: Keys; active?: Keys }): ToolAdapter => (input) => {
  const entries = list(pick(input, keys.list)).map(object);
  const items = entries.flatMap((entry): ToolTodo[] => {
    const content = string(pick(entry, keys.text));
    return content ? [{ text: content, status: todoStatus(pick(entry, keys.status)) }] : [];
  });
  if (!items.length) return { verb: "plan" };
  const active = entries.find((entry) => todoStatus(pick(entry, keys.status)) === "in_progress");
  const current = active && (string(pick(active, keys.active)) ?? string(pick(active, keys.text)));
  const done = items.filter((item) => item.status === "completed").length;
  return {
    verb: "plan", target: { kind: "text", text: current ?? `${done}/${items.length}` },
    sections: [{ kind: "todos", label: "todos", items }], uses: shown([keys.list, items]), quietResult: true,
  };
};

export const plan = (keys: { text: Keys }): ToolAdapter => (input) => {
  const body = string(pick(input, keys.text));
  const heading = body?.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean);
  return {
    verb: "plan", target: heading && { kind: "text", text: heading },
    sections: [body && { kind: "text", label: "plan", text: body }], uses: shown([keys.text, body]),
  };
};

export const ask = (keys: { questions: Keys; question: Keys; header?: Keys; options?: Keys }): ToolAdapter => (input) => {
  const questions = list(pick(input, keys.questions)).map(object);
  const sections = questions.flatMap((entry, index): ToolSectionSpec[] => {
    const question = string(pick(entry, keys.question));
    if (!question) return [];
    const options = list(pick(entry, keys.options)).flatMap((option) => {
      const choice = typeof option === "string" ? { label: option } : object(option);
      const label = string(choice.label);
      const description = string(choice.description);
      return label ? [`- ${label}${description ? ` — ${description}` : ""}`] : [];
    });
    return [{ kind: "text", label: string(pick(entry, keys.header)) ?? `#${index + 1}`, text: [question, ...options].join("\n") }];
  });
  const first = string(pick(questions[0] ?? {}, keys.question));
  return { verb: "ask", target: first && { kind: "text", text: first }, sections, uses: shown([keys.questions, sections.length || undefined]) };
};

const MCP = /^mcp__(.+?)__(.+)$/;
export function mcpTool(name: string): HarnessTool | null {
  const [, server, tool] = MCP.exec(name) ?? [];
  return server && tool ? { label: tool, adapter: (input) => ({ verb: "run", subtitle: server, target: summarize(input) }) } : null;
}
