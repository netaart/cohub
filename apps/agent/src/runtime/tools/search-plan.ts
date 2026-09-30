/** Turns fs.search and fs.pathSearch plans into rg and fd invocations. */

/** Stays under the sandbox process.start argv limits (256 items, 64 KiB). */
export const PROCESS_ARGV_LIMITS = { maxItems: 240, maxBytes: 60 * 1024 };

export type ArgvLimits = { maxItems: number; maxBytes: number };

/** A plan from fs.search; paths are relative to the search path. */
export type RgSearchPlan = {
  root: string;
  files: string[];
  walkFiles: string[];
  dirs: string[];
};

/** One rg invocation and the targets it names. */
export type RgRun = { argv: string[]; targets: string[] };

/**
 * Builds rg invocations that together search exactly what
 * `[...flags, ...globArgv, "--", pattern, searchPath]` searches, printing the
 * same paths. `flags` starts with the rg executable and never names targets.
 *
 * - Plain files are searched as explicit arguments; rg applies no filters to
 *   those, and the index has already applied ignore rules and the glob.
 * - Walk files keep rg's directory-walk semantics, where binary detection
 *   stops at the first NUL instead of converting it, by walking their parent
 *   directory one level deep with an anchored whitelist glob per file.
 * - Directories are walked like the full search would walk them.
 *
 * Returns null when a path cannot be expressed as an argument or glob.
 */
export function buildRgPlanRuns(input: {
  flags: string[];
  globArgv: string[];
  pattern: string;
  searchPath: string;
  plan: RgSearchPlan;
  limits?: ArgvLimits;
}): RgRun[] | null {
  const limits = input.limits ?? PROCESS_ARGV_LIMITS;
  const { plan, searchPath } = input;
  const all = [...plan.files, ...plan.walkFiles, ...plan.dirs];
  if (all.some((path) => /[\n\r]/.test(path))) return null;

  const runs: RgRun[] = [];
  const fileHead = [...input.flags, "--", input.pattern];
  for (const chunk of chunkArgs(fileHead, plan.files.map((file) => joinSearchPath(searchPath, file)), limits)) {
    runs.push({ argv: [...fileHead, ...chunk], targets: chunk });
  }

  const walkHead = [...input.flags, "--max-depth", "1"];
  const walkTail = ["--", input.pattern];
  let globs: string[] = [];
  let parents: string[] = [];
  const flush = () => {
    if (parents.length === 0) return;
    runs.push({ argv: [...walkHead, ...globs, ...walkTail, ...parents], targets: parents });
    globs = [];
    parents = [];
  };
  const walkBytes = (items: string[]) => byteLength([...walkHead, ...walkTail, ...items]);
  for (const file of plan.walkFiles) {
    const parent = joinSearchPath(searchPath, parentOf(file));
    const glob = ["--glob", `/${escapeGlobPath(plan.root ? `${plan.root}/${file}` : file)}`];
    const addsParent = !parents.includes(parent);
    const nextItems = [...globs, ...glob, ...parents, ...(addsParent ? [parent] : [])];
    const itemCount = walkHead.length + walkTail.length + nextItems.length;
    if (parents.length > 0 && (itemCount > limits.maxItems || walkBytes(nextItems) > limits.maxBytes)) flush();
    globs.push(...glob);
    if (!parents.includes(parent)) parents.push(parent);
  }
  flush();

  const dirHead = [...input.flags, ...input.globArgv, "--", input.pattern];
  for (const chunk of chunkArgs(dirHead, plan.dirs.map((dir) => joinSearchPath(searchPath, dir)), limits)) {
    runs.push({ argv: [...dirHead, ...chunk], targets: chunk });
  }
  if (runs.some((run) => run.argv.length > limits.maxItems || byteLength(run.argv) > limits.maxBytes)) return null;
  return runs;
}

/** Mirror how rg and fd print paths below a `searchPath` argument. */
export function joinSearchPath(searchPath: string, relative: string): string {
  if (relative === "." || relative === "") return searchPath;
  if (searchPath === ".") return `./${relative}`;
  return `${searchPath.replace(/\/+$/, "")}/${relative}`;
}

/** Escapes a workspace-relative path for an anchored rg `--glob`. */
export function escapeGlobPath(path: string): string {
  return path.replace(/[\\*?[\]{}]/g, (character) => `\\${character}`).replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "));
}

/**
 * Splits target arguments into chunks that fit the argv limits together with
 * the fixed `head` arguments.
 */
export function chunkArgs(head: string[], args: string[], limits: ArgvLimits): string[][] {
  const headBytes = byteLength(head);
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = headBytes;
  for (const arg of args) {
    const bytes = Buffer.byteLength(arg, "utf8");
    if (current.length > 0 && (head.length + current.length + 1 > limits.maxItems || currentBytes + bytes > limits.maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = headBytes;
    }
    current.push(arg);
    currentBytes += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const RG_MISSING_TARGET = /^rg: (.+): No such file or directory \(os error 2\)$/;

/**
 * True when stderr only reports targets that vanished after the plan was
 * made. A walk of the search path would not have seen them either.
 */
export function onlyVanishedTargets(stderr: string, targets: string[]): boolean {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const named = new Set(targets);
  return lines.every((line) => {
    const match = RG_MISSING_TARGET.exec(line);
    return match !== null && named.has(match[1] ?? "");
  });
}

function parentOf(path: string) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function byteLength(items: string[]) {
  return items.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0);
}
