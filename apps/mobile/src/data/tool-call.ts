/** One-line caption budget. Longer values are truncated before normalization. */
const PREVIEW_LIMIT = 400;

const PREFERRED_INPUT_KEYS = [
  "command",
  "skill",
  "skill_name",
  "query",
  "url",
  "path",
  "file_path",
  "pattern",
  "name",
  "description",
  "text",
  "content",
] as const;

function asPreviewText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Cap before normalizing: a large tool input (file contents, search text) would otherwise
  // pay a full whitespace pass per render, and the caption calls this twice.
  const text = value.slice(0, PREVIEW_LIMIT).replace(/\s+/g, " ").trim();
  return text || null;
}

function commandPreview(value: unknown): string | null {
  const direct = asPreviewText(value);
  if (direct) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return asPreviewText(record.preview) ?? asPreviewText(record.command);
}

export function toolCallPreview(name: string, input?: Record<string, unknown> | null) {
  if (!input) return "";
  const tool = name.trim().toLowerCase();
  if (tool === "bash" || tool === "terminal" || tool === "shell" || tool.includes("command")) {
    const command = commandPreview(input.command);
    if (command) return command;
  }
  for (const key of PREFERRED_INPUT_KEYS) {
    if (key === "command") {
      const command = commandPreview(input.command);
      if (command) return command;
      continue;
    }
    const value = asPreviewText(input[key]);
    if (value) return value;
  }
  const strings = Object.values(input).map(asPreviewText).filter((value): value is string => Boolean(value));
  if (strings.length === 1) return strings[0]!;
  try {
    const json = JSON.stringify(input);
    return json === "{}" ? "" : json.slice(0, PREVIEW_LIMIT).replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

export function formatToolCallCaption(name: string, input?: Record<string, unknown> | null) {
  const preview = toolCallPreview(name, input);
  return preview ? `${name}: "${preview}"` : name;
}
