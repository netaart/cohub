import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine, type GrepToolDetails } from "./index.js";

const GREP_MAX_LINE_LENGTH = 500;
const SANDBOX_WORKSPACE_PATH = "/workspace";

type RgJsonEvent = {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
};

function normalizeSlashes(value: string) {
  return value.replace(/\\/g, "/");
}

export function formatGrepPath(filePath: string, searchPath: string | undefined) {
  const normalizedFile = normalizeSlashes(filePath);
  let search = normalizeSlashes(searchPath?.trim() || ".");

  if (search === "." || search === SANDBOX_WORKSPACE_PATH) {
    if (normalizedFile === SANDBOX_WORKSPACE_PATH) return ".";
    if (normalizedFile.startsWith(`${SANDBOX_WORKSPACE_PATH}/`)) return normalizedFile.slice(SANDBOX_WORKSPACE_PATH.length + 1);
    return normalizedFile.replace(/^\.\//, "");
  }

  if (!search.startsWith("/")) search = `${SANDBOX_WORKSPACE_PATH}/${search}`;
  if (normalizedFile.startsWith(`${search}/`)) return normalizedFile.slice(search.length + 1);
  return normalizedFile.replace(/^\.\//, "");
}

export function formatRgJsonGrepResult(input: {
  lines: string[];
  searchPath?: string;
  limit: number;
}) {
  const outputLines: string[] = [];
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  let matchCount = 0;
  let matchLimitReached = false;
  let includeTrailingContext = false;
  let linesTruncated = false;

  for (const rawLine of input.lines) {
    if (!rawLine.trim()) continue;
    let event: RgJsonEvent;
    try {
      event = JSON.parse(rawLine) as RgJsonEvent;
    } catch {
      continue;
    }
    if (event.type !== "match" && event.type !== "context") {
      if (event.type === "end") includeTrailingContext = false;
      continue;
    }

    if (matchLimitReached && event.type === "match") break;
    if (matchLimitReached && event.type === "context" && !includeTrailingContext) continue;

    const filePath = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    const lineText = event.data?.lines?.text;
    if (!filePath || typeof lineNumber !== "number" || typeof lineText !== "string") continue;

    const sanitized = lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
    const { text, wasTruncated } = truncateLine(sanitized, GREP_MAX_LINE_LENGTH);
    if (wasTruncated) linesTruncated = true;

    const sep = event.type === "match" ? ":" : "-";
    outputLines.push(`${formatGrepPath(filePath, input.searchPath)}${sep}${lineNumber}${sep} ${text}`);

    if (event.type === "match") {
      matchCount += 1;
      includeTrailingContext = true;
      if (matchCount >= input.limit) matchLimitReached = true;
    }
  }

  if (matchCount === 0) {
    return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
  }

  const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  let output = truncation.content;
  if (matchLimitReached) {
    notices.push(`${input.limit} matches limit reached. Use limit=${input.limit * 2} for more, or refine pattern`);
    details.matchLimitReached = input.limit;
  }
  if (truncation.truncated) {
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
    details.linesTruncated = true;
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return { content: [{ type: "text" as const, text: output }], details: Object.keys(details).length > 0 ? details : undefined };
}

/**
 * Accumulates streamed `rg --json` stdout. Formatting always sees every line,
 * so the tool limit counts matches rather than rg's begin/end/context events.
 */
export function createRgJsonGrepCollector(input: { searchPath?: string; limit: number }) {
  const lines: string[] = [];
  let pending = "";
  let matches = 0;
  const append = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    lines.push(trimmed);
    if (isRgMatchLine(trimmed)) matches += 1;
    return true;
  };
  return {
    lines: lines as readonly string[],
    /** Number of rg match events seen so far. */
    get matches() {
      return matches;
    },
    /** Returns true when the chunk completed at least one line. */
    push(chunk: string) {
      pending += chunk;
      const complete = pending.split("\n");
      pending = complete.pop() ?? "";
      let added = false;
      for (const line of complete) added = append(line) || added;
      return added;
    },
    /** Flushes a final line that had no trailing newline. */
    end() {
      const added = append(pending);
      pending = "";
      return added;
    },
    format() {
      return formatRgJsonGrepResult({ lines, searchPath: input.searchPath, limit: input.limit });
    },
  };
}

function isRgMatchLine(line: string) {
  try {
    return (JSON.parse(line) as RgJsonEvent).type === "match";
  } catch {
    return false;
  }
}
