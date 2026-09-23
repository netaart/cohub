import ignore from "ignore";

/** Search literals must reach the trigram index minimum after trimming. */
const MIN_LITERAL_CHARS = 3;

function isRequiredLiteral(value: string) {
  return [...value.trim()].length >= MIN_LITERAL_CHARS;
}

/**
 * Extract literal fragments that every match of a Rust-regex pattern must
 * contain contiguously. The extractor is deliberately conservative: anything
 * ambiguous ends the current fragment, alternation gives up entirely, and
 * optional groups discard fragments collected inside them. Returns an empty
 * list when the index cannot narrow the search.
 */
export function extractRequiredGrepLiterals(pattern: string, options: { literal?: boolean } = {}): string[] {
  if (options.literal) return isRequiredLiteral(pattern) ? [pattern] : [];

  const fragments: string[] = [];
  let current = "";
  const flush = () => {
    if (current) fragments.push(current);
    current = "";
  };
  // Each open group remembers how many fragments existed before it, so an
  // optional quantifier on `)` can drop everything collected inside.
  const groupStack: number[] = [];

  const chars = [...pattern];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    const next = chars[i + 1];

    if (ch === "|") return [];

    if (ch === "\\") {
      if (next === undefined) return [];
      i += 2;
      if (/[A-Za-z0-9]/.test(next)) {
        // Character classes, anchors, and escapes such as \d \w \b \n \x41.
        flush();
        continue;
      }
      if (isOptionalQuantifier(chars, i)) {
        flush();
        i = skipQuantifier(chars, i);
        continue;
      }
      current += next;
      if (isQuantifier(chars, i)) {
        flush();
        i = skipQuantifier(chars, i);
      }
      continue;
    }

    if (ch === "[") {
      flush();
      i = skipCharClass(chars, i);
      i = skipQuantifier(chars, i);
      continue;
    }

    if (ch === "(") {
      flush();
      if (next === "?") {
        const lookaround = chars[i + 2] === "=" || chars[i + 2] === "!" ||
          (chars[i + 2] === "<" && (chars[i + 3] === "=" || chars[i + 3] === "!"));
        if (lookaround) {
          i = skipGroup(chars, i);
          continue;
        }
        // Bare inline flags like (?i) open no group; (?i:...), (?:...) and
        // named groups still contain required content.
        const prefixEnd = skipGroupPrefix(chars, i);
        const bareFlags = chars[prefixEnd - 1] === ")";
        i = prefixEnd;
        if (bareFlags) continue;
      } else {
        i += 1;
      }
      groupStack.push(fragments.length);
      continue;
    }

    if (ch === ")") {
      flush();
      const marker = groupStack.pop();
      i += 1;
      if (isOptionalQuantifier(chars, i) && marker !== undefined) fragments.length = marker;
      i = skipQuantifier(chars, i);
      continue;
    }

    if (ch === "." || ch === "^" || ch === "$") {
      flush();
      i += 1;
      i = skipQuantifier(chars, i);
      continue;
    }

    if (isQuantifier(chars, i)) {
      // A quantifier applied to nothing we tracked; stay conservative.
      flush();
      i = skipQuantifier(chars, i);
      continue;
    }

    i += 1;
    if (isOptionalQuantifier(chars, i)) {
      flush();
      i = skipQuantifier(chars, i);
      continue;
    }
    current += ch;
    if (isQuantifier(chars, i)) {
      flush();
      i = skipQuantifier(chars, i);
    }
  }
  flush();

  return fragments.filter(isRequiredLiteral);
}

function isQuantifier(chars: string[], index: number) {
  const ch = chars[index];
  return ch === "?" || ch === "*" || ch === "+" || ch === "{";
}

function isOptionalQuantifier(chars: string[], index: number) {
  const ch = chars[index];
  if (ch === "?" || ch === "*") return true;
  if (ch !== "{") return false;
  const rest = chars.slice(index).join("");
  const match = /^\{(\d*)(?:,\d*)?\}/.exec(rest);
  if (!match) return false;
  return match[1] === "" || Number(match[1]) === 0;
}

function skipQuantifier(chars: string[], index: number) {
  let i = index;
  if (chars[i] === "{") {
    while (i < chars.length && chars[i] !== "}") i += 1;
    i += 1;
  } else if (chars[i] === "?" || chars[i] === "*" || chars[i] === "+") {
    i += 1;
  } else {
    return i;
  }
  // Lazy / possessive modifiers.
  if (chars[i] === "?" || chars[i] === "+") i += 1;
  return i;
}

function skipCharClass(chars: string[], index: number) {
  let i = index + 1;
  if (chars[i] === "^") i += 1;
  if (chars[i] === "]") i += 1;
  while (i < chars.length && chars[i] !== "]") {
    if (chars[i] === "\\") i += 1;
    else if (chars[i] === "[" && chars[i + 1] === ":") {
      while (i < chars.length && !(chars[i] === ":" && chars[i + 1] === "]")) i += 1;
      i += 1;
    }
    i += 1;
  }
  return i + 1;
}

function skipGroupPrefix(chars: string[], index: number) {
  // Positioned at "(?"; consume through the ":" or ">" that starts content, or
  // the ")" that closes a bare flag group.
  let i = index + 2;
  while (i < chars.length && chars[i] !== ":" && chars[i] !== ">" && chars[i] !== ")") i += 1;
  return i + 1;
}

function skipGroup(chars: string[], index: number) {
  let depth = 0;
  let i = index;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      i = skipCharClass(chars, i);
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return skipQuantifier(chars, i + 1);
    }
    i += 1;
  }
  return i;
}

/**
 * Apply a ripgrep `--glob` to candidate paths relative to the search root.
 * ripgrep never applies globs to explicitly listed files, so this must happen
 * before candidates become argv. Both sides use gitignore matching semantics.
 */
export function filterGrepCandidatesByGlob(candidates: string[], glob: string | undefined): string[] {
  const trimmed = glob?.trim();
  if (!trimmed) return candidates;
  const negated = trimmed.startsWith("!");
  const matcher = ignore().add(negated ? trimmed.slice(1) : trimmed);
  return candidates.filter((candidate) => matcher.ignores(candidate) !== negated);
}

/** Mirror how ripgrep prints paths when given `searchPath` as a directory. */
export function joinGrepCandidatePath(searchPath: string, relative: string): string {
  if (relative === "." || relative === "") return searchPath;
  if (searchPath === ".") return `./${relative}`;
  return `${searchPath.replace(/\/+$/, "")}/${relative}`;
}

export type GrepArgvChunkLimits = {
  maxItems: number;
  maxBytes: number;
};

/**
 * Split candidate files into argv chunks that respect the sandbox process
 * limits, accounting for the fixed rg flags already in `baseArgv`.
 */
export function chunkGrepFileArgs(baseArgv: string[], files: string[], limits: GrepArgvChunkLimits): string[][] {
  const baseBytes = baseArgv.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0);
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = baseBytes;
  for (const file of files) {
    const fileBytes = Buffer.byteLength(file, "utf8");
    const exceeds = current.length > 0 &&
      (current.length + baseArgv.length >= limits.maxItems || currentBytes + fileBytes > limits.maxBytes);
    if (exceeds) {
      chunks.push(current);
      current = [];
      currentBytes = baseBytes;
    }
    current.push(file);
    currentBytes += fileBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
