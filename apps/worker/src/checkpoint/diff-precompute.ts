import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { uploadObjectFileIfMissing } from "./assets.js";
import { runGitWithOutput } from "./git.js";

const SYSTEM_PATH_PREFIX = ".cohub/system/";
const DIFF_SUMMARY_MAX_FILES = 500;
/** Inline into checkpoint.meta when payload is small enough. */
const INLINE_SUMMARY_MAX_BYTES = 48 * 1024;
/** Cap how many text file patches we precompute at save time (NFS + CPU). */
const PRECOMPUTE_PATCH_MAX_FILES = 40;
const PRECOMPUTE_PATCH_MAX_BYTES = 256 * 1024;
const PRECOMPUTE_PATCH_TOTAL_BYTES = 2 * 1024 * 1024;

export type PrecomputedDiffStatus = "A" | "M" | "D" | "R" | "C" | "T";

export type PrecomputedDiffFile = {
  status: PrecomputedDiffStatus;
  path: string;
  oldPath?: string | null;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  asset: boolean;
};

export type PrecomputedDiffStats = {
  changedFileCount: number;
  addedFileCount: number;
  modifiedFileCount: number;
  deletedFileCount: number;
  renamedFileCount: number;
  copiedFileCount: number;
  additions: number;
  deletions: number;
};

export type PrecomputedDiffSummary = {
  baseCheckpointId: string | null;
  baseCommitHash: string | null;
  headCheckpointId: string;
  headCommitHash: string;
  files: PrecomputedDiffFile[];
  truncated: boolean;
  stats: PrecomputedDiffStats;
  precomputed: true;
  delivery: "inline";
};

export type PrecomputedPatchLine = {
  type: "context" | "add" | "del" | "hunk" | "meta";
  text: string;
};

export type PrecomputedFilePatch = {
  path: string;
  oldPath?: string | null;
  status: PrecomputedDiffStatus | null;
  kind: "text" | "binary" | "asset" | "too_large" | "unavailable";
  binary: boolean;
  asset: boolean;
  additions: number | null;
  deletions: number | null;
  oldSize?: number | null;
  newSize?: number | null;
  truncated: boolean;
  lines: PrecomputedPatchLine[];
};

export type CheckpointDiffFilePatchMeta =
  | {
      version: 1;
      delivery: "inline";
      patch: PrecomputedFilePatch;
    }
  | {
      version: 1;
      delivery: "url";
      objectKey: string;
      size: number;
      sha256: string;
      path: string;
      oldPath?: string | null;
      kind: PrecomputedFilePatch["kind"];
      status: PrecomputedDiffStatus | null;
      binary: boolean;
      asset: boolean;
      additions: number | null;
      deletions: number | null;
      oldSize?: number | null;
      newSize?: number | null;
      truncated: boolean;
    };

export type CheckpointDiffMeta =
  | {
      version: 1;
      kind: "parent";
      delivery: "inline";
      summary: PrecomputedDiffSummary;
      /** Sparse map of path → precomputed patch (only text-ish files, capped). */
      files?: Record<string, CheckpointDiffFilePatchMeta>;
    }
  | {
      version: 1;
      kind: "parent";
      delivery: "url";
      objectKey: string;
      size: number;
      sha256: string;
      /** Lightweight stats always kept in meta for list UIs. */
      stats: PrecomputedDiffStats;
      truncated: boolean;
      baseCheckpointId: string | null;
      baseCommitHash: string | null;
      fileCount: number;
      files?: Record<string, CheckpointDiffFilePatchMeta>;
    };

function isSystemPath(path: string) {
  return path === ".cohub/system" || path.startsWith(SYSTEM_PATH_PREFIX);
}

function parseStatusCode(raw: string): PrecomputedDiffStatus | null {
  const code = raw.trim().charAt(0).toUpperCase();
  if (code === "A" || code === "M" || code === "D" || code === "R" || code === "C" || code === "T") return code;
  return null;
}

/** Parse `git diff -z --name-status` (NUL-delimited) into file entries. */
function parseNameStatusZ(output: string): Array<{ status: PrecomputedDiffStatus; path: string; oldPath?: string }> {
  const parts = output.split("\0").filter((part) => part.length > 0);
  const files: Array<{ status: PrecomputedDiffStatus; path: string; oldPath?: string }> = [];
  let index = 0;
  while (index < parts.length) {
    const statusToken = parts[index] ?? "";
    const status = parseStatusCode(statusToken);
    if (!status) {
      index += 1;
      continue;
    }
    if (status === "R" || status === "C") {
      const oldPath = parts[index + 1] ?? "";
      const path = parts[index + 2] ?? "";
      if (path) files.push({ status, path, oldPath: oldPath || undefined });
      index += 3;
      continue;
    }
    const path = parts[index + 1] ?? "";
    if (path) files.push({ status, path });
    index += 2;
  }
  return files;
}

/**
 * Parse `git diff -z --numstat` (NUL-delimited).
 * Rename form: `0\t0\t\0old\0new\0`
 */
function parseNumstatZ(output: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const map = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const parts = output.split("\0");
  let index = 0;
  while (index < parts.length) {
    const part = parts[index] ?? "";
    if (!part) {
      index += 1;
      continue;
    }
    const tabs = part.split("\t");
    if (tabs.length < 3) {
      index += 1;
      continue;
    }
    const addedRaw = tabs[0] ?? "";
    const deletedRaw = tabs[1] ?? "";
    if (addedRaw !== "-" && Number.isNaN(Number.parseInt(addedRaw, 10))) {
      index += 1;
      continue;
    }
    const binary = addedRaw === "-" || deletedRaw === "-";
    const additions = binary ? null : Number.parseInt(addedRaw, 10);
    const deletions = binary ? null : Number.parseInt(deletedRaw, 10);
    const pathField = tabs.slice(2).join("\t");
    let path = pathField;
    if (!path) {
      const oldPath = parts[index + 1] ?? "";
      const newPath = parts[index + 2] ?? "";
      path = newPath || oldPath;
      index += 3;
    } else {
      index += 1;
    }
    if (!path) continue;
    map.set(path, {
      additions: Number.isFinite(additions as number) ? (additions as number) : null,
      deletions: Number.isFinite(deletions as number) ? (deletions as number) : null,
      binary,
    });
  }
  return map;
}

function emptyStats(): PrecomputedDiffStats {
  return {
    changedFileCount: 0,
    addedFileCount: 0,
    modifiedFileCount: 0,
    deletedFileCount: 0,
    renamedFileCount: 0,
    copiedFileCount: 0,
    additions: 0,
    deletions: 0,
  };
}

function accumulate(stats: PrecomputedDiffStats, file: PrecomputedDiffFile) {
  stats.changedFileCount += 1;
  if (file.status === "A") stats.addedFileCount += 1;
  else if (file.status === "M" || file.status === "T") stats.modifiedFileCount += 1;
  else if (file.status === "D") stats.deletedFileCount += 1;
  else if (file.status === "R") stats.renamedFileCount += 1;
  else if (file.status === "C") stats.copiedFileCount += 1;
  if (typeof file.additions === "number") stats.additions += file.additions;
  if (typeof file.deletions === "number") stats.deletions += file.deletions;
}

/** Build a parent-diff summary by comparing two commit trees; reads git metadata only. */
export async function buildCommitDiffSummary(input: {
  repoDir: string;
  checkpointId: string;
  commitHash: string;
  parentCheckpointId: string | null;
  parentCommitHash: string | null;
  /** Asset paths known at save time. */
  assetPaths: Set<string>;
}): Promise<{ summary: PrecomputedDiffSummary; stats: PrecomputedDiffStats }> {
  const range = input.parentCommitHash ? [input.parentCommitHash, input.commitHash] : ["--root", input.commitHash];
  const [nameStatus, numstat] = await Promise.all([
    runGitWithOutput(["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--name-status", ...range], input.repoDir),
    runGitWithOutput(["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--numstat", ...range], input.repoDir),
  ]);

  const nameEntries = parseNameStatusZ(nameStatus.stdout);
  const numstatMap = parseNumstatZ(numstat.stdout);
  const stats = emptyStats();
  const files: PrecomputedDiffFile[] = [];
  let truncated = false;

  for (const entry of nameEntries) {
    if (isSystemPath(entry.path) || (entry.oldPath && isSystemPath(entry.oldPath))) continue;
    const counts = numstatMap.get(entry.path);
    const asset = input.assetPaths.has(entry.path) || (entry.oldPath ? input.assetPaths.has(entry.oldPath) : false);
    const file: PrecomputedDiffFile = {
      status: entry.status,
      path: entry.path,
      oldPath: entry.oldPath ?? null,
      additions: asset ? null : (counts?.additions ?? null),
      deletions: asset ? null : (counts?.deletions ?? null),
      binary: asset ? true : Boolean(counts?.binary),
      asset,
    };
    accumulate(stats, file);
    if (files.length >= DIFF_SUMMARY_MAX_FILES) {
      truncated = true;
      continue;
    }
    files.push(file);
  }

  const summary: PrecomputedDiffSummary = {
    baseCheckpointId: input.parentCheckpointId,
    baseCommitHash: input.parentCommitHash,
    headCheckpointId: input.checkpointId,
    headCommitHash: input.commitHash,
    files,
    truncated,
    stats,
    precomputed: true,
    delivery: "inline",
  };
  return { summary, stats };
}

export function buildDiffObjectKey(spaceId: string, checkpointId: string, sha256: string, kind: "summary" | "file" = "summary") {
  const suffix = kind === "file" ? "file" : "parent-summary";
  return `checkpoint-diffs/${spaceId}/${checkpointId}/${suffix}.${sha256.slice(0, 16)}.json`;
}

function parseUnifiedDiffLines(patch: string): PrecomputedPatchLine[] {
  const lines: PrecomputedPatchLine[] = [];
  for (const raw of patch.split("\n")) {
    if (
      raw.startsWith("diff --git ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("rename from") ||
      raw.startsWith("rename to") ||
      raw.startsWith("copy from") ||
      raw.startsWith("copy to") ||
      raw.startsWith("new file mode") ||
      raw.startsWith("deleted file mode") ||
      raw.startsWith("Binary files")
    ) {
      lines.push({ type: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("@@")) {
      lines.push({ type: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ type: "add", text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("-")) {
      lines.push({ type: "del", text: raw.slice(1) });
      continue;
    }
    if (raw.startsWith("\\")) {
      lines.push({ type: "meta", text: raw });
      continue;
    }
    lines.push({ type: "context", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  while (lines.length > 0 && lines[lines.length - 1]?.type === "context" && lines[lines.length - 1]?.text === "") {
    lines.pop();
  }
  return lines;
}

async function uploadJsonObject(input: {
  body: string;
  objectKey: string;
  tmpPath: string;
  spaceId: string;
  checkpointId: string;
  kind: string;
  sha256: string;
}) {
  const bytes = Buffer.byteLength(input.body, "utf8");
  await writeFile(input.tmpPath, input.body);
  try {
    await uploadObjectFileIfMissing({
      filePath: input.tmpPath,
      objectKey: input.objectKey,
      size: bytes,
      mimeType: "application/json",
      metadata: {
        spaceId: input.spaceId,
        checkpointId: input.checkpointId,
        kind: input.kind,
        sha256: input.sha256,
      },
    });
  } finally {
    await unlink(input.tmpPath).catch(() => undefined);
  }
  return bytes;
}

/**
 * Precompute a small set of text file patches after commit.
 * Sequential git calls, hard caps — safe on NFS NAS.
 */
export async function materializeFilePatches(input: {
  repoDir: string;
  parentCommitHash: string | null;
  commitHash: string;
  files: PrecomputedDiffFile[];
  spaceId: string;
  checkpointId: string;
  tmpDir: string;
}): Promise<Record<string, CheckpointDiffFilePatchMeta>> {
  const out: Record<string, CheckpointDiffFilePatchMeta> = {};
  let totalBytes = 0;
  let count = 0;

  for (const file of input.files) {
    if (count >= PRECOMPUTE_PATCH_MAX_FILES) break;
    if (totalBytes >= PRECOMPUTE_PATCH_TOTAL_BYTES) break;
    if (file.asset || file.binary) {
      // Store a tiny marker so the API can skip git for these paths.
      out[file.path] = {
        version: 1,
        delivery: "inline",
        patch: {
          path: file.path,
          oldPath: file.oldPath ?? null,
          status: file.status,
          kind: file.asset ? "asset" : "binary",
          binary: true,
          asset: file.asset,
          additions: null,
          deletions: null,
          truncated: false,
          lines: [],
        },
      };
      count += 1;
      continue;
    }

    // Prefer moderate text files only.
    const lineBudget = (file.additions ?? 0) + (file.deletions ?? 0);
    if (lineBudget > 2000) {
      out[file.path] = {
        version: 1,
        delivery: "inline",
        patch: {
          path: file.path,
          oldPath: file.oldPath ?? null,
          status: file.status,
          kind: "too_large",
          binary: false,
          asset: false,
          additions: file.additions,
          deletions: file.deletions,
          truncated: true,
          lines: [],
        },
      };
      count += 1;
      continue;
    }

    try {
      let patchText = "";
      if (!input.parentCommitHash) {
        // Root: show as all additions via git show of the new blob is heavier;
        // use git show --pretty= for content? Prefer unified diff against empty via show.
        const shown = await runGitWithOutput(
          ["show", `${input.commitHash}:${file.path}`],
          input.repoDir,
        ).catch(() => null);
        if (!shown) continue;
        if (shown.stdout.includes("\0")) {
          out[file.path] = {
            version: 1,
            delivery: "inline",
            patch: {
              path: file.path,
              oldPath: null,
              status: file.status,
              kind: "binary",
              binary: true,
              asset: false,
              additions: null,
              deletions: null,
              truncated: false,
              lines: [],
            },
          };
          count += 1;
          continue;
        }
        if (Buffer.byteLength(shown.stdout, "utf8") > PRECOMPUTE_PATCH_MAX_BYTES) {
          out[file.path] = {
            version: 1,
            delivery: "inline",
            patch: {
              path: file.path,
              oldPath: null,
              status: file.status,
              kind: "too_large",
              binary: false,
              asset: false,
              additions: file.additions,
              deletions: file.deletions,
              truncated: true,
              lines: [],
            },
          };
          count += 1;
          continue;
        }
        const newLines = shown.stdout.split("\n");
        if (newLines.length > 0 && newLines[newLines.length - 1] === "") newLines.pop();
        const lines: PrecomputedPatchLine[] = [
          { type: "hunk", text: `@@ -0,0 +1,${newLines.length} @@` },
          ...newLines.map((text) => ({ type: "add" as const, text })),
        ];
        const patch: PrecomputedFilePatch = {
          path: file.path,
          oldPath: null,
          status: file.status,
          kind: "text",
          binary: false,
          asset: false,
          additions: newLines.length,
          deletions: 0,
          truncated: false,
          lines,
        };
        const body = `${JSON.stringify(patch)}\n`;
        const size = Buffer.byteLength(body, "utf8");
        if (size <= INLINE_SUMMARY_MAX_BYTES / 4) {
          out[file.path] = { version: 1, delivery: "inline", patch };
        } else {
          const sha256 = createHash("sha256").update(body).digest("hex");
          const objectKey = buildDiffObjectKey(input.spaceId, input.checkpointId, sha256, "file");
          await uploadJsonObject({
            body,
            objectKey,
            tmpPath: join(input.tmpDir, `diff-file-${sha256.slice(0, 12)}.json`),
            spaceId: input.spaceId,
            checkpointId: input.checkpointId,
            kind: "parent-diff-file",
            sha256,
          });
          out[file.path] = {
            version: 1,
            delivery: "url",
            objectKey,
            size,
            sha256,
            path: file.path,
            oldPath: null,
            kind: "text",
            status: file.status,
            binary: false,
            asset: false,
            additions: newLines.length,
            deletions: 0,
            truncated: false,
          };
          totalBytes += size;
        }
        count += 1;
        continue;
      }

      const paths = file.oldPath && file.oldPath !== file.path
        ? [file.oldPath, file.path]
        : [file.path];
      const diff = await runGitWithOutput(
        [
          "diff",
          "--no-color",
          "--find-renames",
          "--unified=3",
          input.parentCommitHash,
          input.commitHash,
          "--",
          ...paths,
        ],
        input.repoDir,
      );
      patchText = diff.stdout;
      if (patchText.includes("Binary files")) {
        out[file.path] = {
          version: 1,
          delivery: "inline",
          patch: {
            path: file.path,
            oldPath: file.oldPath ?? null,
            status: file.status,
            kind: "binary",
            binary: true,
            asset: false,
            additions: null,
            deletions: null,
            truncated: false,
            lines: [],
          },
        };
        count += 1;
        continue;
      }
      const truncated = Buffer.byteLength(patchText, "utf8") > PRECOMPUTE_PATCH_MAX_BYTES;
      if (truncated) {
        patchText = patchText.slice(0, PRECOMPUTE_PATCH_MAX_BYTES);
      }
      const lines = parseUnifiedDiffLines(patchText);
      let additions = 0;
      let deletions = 0;
      for (const line of lines) {
        if (line.type === "add") additions += 1;
        else if (line.type === "del") deletions += 1;
      }
      const patch: PrecomputedFilePatch = {
        path: file.path,
        oldPath: file.oldPath ?? null,
        status: file.status,
        kind: truncated ? "too_large" : "text",
        binary: false,
        asset: false,
        additions: truncated ? file.additions : additions,
        deletions: truncated ? file.deletions : deletions,
        truncated,
        lines: truncated ? [] : lines,
      };
      const body = `${JSON.stringify(patch)}\n`;
      const size = Buffer.byteLength(body, "utf8");
      if (size <= 16 * 1024) {
        out[file.path] = { version: 1, delivery: "inline", patch };
      } else {
        const sha256 = createHash("sha256").update(body).digest("hex");
        const objectKey = buildDiffObjectKey(input.spaceId, input.checkpointId, sha256, "file");
        await uploadJsonObject({
          body,
          objectKey,
          tmpPath: join(input.tmpDir, `diff-file-${sha256.slice(0, 12)}.json`),
          spaceId: input.spaceId,
          checkpointId: input.checkpointId,
          kind: "parent-diff-file",
          sha256,
        });
        out[file.path] = {
          version: 1,
          delivery: "url",
          objectKey,
          size,
          sha256,
          path: file.path,
          oldPath: file.oldPath ?? null,
          kind: patch.kind,
          status: file.status,
          binary: false,
          asset: false,
          additions: patch.additions,
          deletions: patch.deletions,
          truncated: patch.truncated,
        };
        totalBytes += size;
      }
      count += 1;
    } catch {
      // Skip individual file failures — API can still compute on demand.
    }
  }

  return out;
}

/**
 * Persist summary inline in meta when small; otherwise upload JSON to OSS
 * (immutable Cache-Control) and keep a compact pointer in meta.
 */
export async function materializeDiffMeta(input: {
  summary: PrecomputedDiffSummary;
  commitHash: string;
  spaceId: string;
  checkpointId: string;
  tmpDir: string;
  files?: Record<string, CheckpointDiffFilePatchMeta>;
}): Promise<CheckpointDiffMeta> {
  const summary: PrecomputedDiffSummary = {
    ...input.summary,
    headCommitHash: input.commitHash,
  };
  const body = `${JSON.stringify(summary)}\n`;
  const bytes = Buffer.byteLength(body, "utf8");
  const files = input.files && Object.keys(input.files).length > 0 ? input.files : undefined;

  if (bytes <= INLINE_SUMMARY_MAX_BYTES) {
    return {
      version: 1,
      kind: "parent",
      delivery: "inline",
      summary,
      ...(files ? { files } : {}),
    };
  }

  const sha256 = createHash("sha256").update(body).digest("hex");
  const objectKey = buildDiffObjectKey(input.spaceId, input.checkpointId, sha256, "summary");
  const tmpPath = join(input.tmpDir, `diff-summary-${input.checkpointId}.json`);
  await uploadJsonObject({
    body,
    objectKey,
    tmpPath,
    spaceId: input.spaceId,
    checkpointId: input.checkpointId,
    kind: "parent-diff-summary",
    sha256,
  });

  return {
    version: 1,
    kind: "parent",
    delivery: "url",
    objectKey,
    size: bytes,
    sha256,
    stats: summary.stats,
    truncated: summary.truncated,
    baseCheckpointId: summary.baseCheckpointId,
    baseCommitHash: summary.baseCommitHash,
    fileCount: summary.files.length,
    ...(files ? { files } : {}),
  };
}
