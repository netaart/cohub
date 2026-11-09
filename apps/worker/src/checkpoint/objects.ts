import { mkdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCheckpointGit } from "@cohub/core/checkpoint/storage";
import { config } from "../config.js";

export type ObjectBuilder = {
  tmpDir: string;
  env: NodeJS.ProcessEnv;
};

export type TreeEntry = { path: string; mode: string; oid: string };

export type BuiltPack = {
  checksum: string;
  packPath: string;
  idxPath: string;
  size: number;
  idxSize: number;
};

/**
 * A throwaway bare repository on worker-local disk. A save writes only the
 * objects it introduces here; everything it reuses is named by id and already
 * lives in the parent's packs in object storage, so no cache is read.
 */
export async function createObjectBuilder(tmpDir: string): Promise<ObjectBuilder> {
  const gitDir = join(tmpDir, "git");
  await runCheckpointGit(["init", "-q", "--bare", gitDir], { cwd: tmpDir });
  return { tmpDir, env: { GIT_DIR: gitDir, GIT_INDEX_FILE: join(tmpDir, "index") } };
}

const git = (builder: ObjectBuilder, args: string[], input?: string) =>
  runCheckpointGit(args, { cwd: builder.tmpDir, env: builder.env, input });

/** hash-object --stdin-paths reads one path per line, drops a CR before LF and unquotes a leading `"`. */
const needsAlias = (path: string) => path.includes("\n") || path.includes("\r") || path.startsWith("\"");

export type BlobSource = { kind: "file"; path: string } | { kind: "symlink"; path: string } | { kind: "content"; content: string | Buffer };

const HASH_BATCH_MIN = 256;
const HASH_PARALLELISM = 8;

/** Write blobs and return their ids in input order. File content is stored as-is, without filters. */
export async function writeBlobs(builder: ObjectBuilder, sources: BlobSource[]): Promise<string[]> {
  if (sources.length === 0) return [];
  if (sources.length >= HASH_BATCH_MIN * 2) {
    const size = Math.ceil(sources.length / HASH_PARALLELISM);
    const batches = Array.from({ length: Math.ceil(sources.length / size) }, (_, index) => sources.slice(index * size, (index + 1) * size));
    return (await Promise.all(batches.map((batch) => writeBlobBatch(builder, batch)))).flat();
  }
  return writeBlobBatch(builder, sources);
}

async function writeBlobBatch(builder: ObjectBuilder, sources: BlobSource[]) {
  const stagingDir = join(builder.tmpDir, `blobs-${crypto.randomUUID()}`);
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    const paths = await Promise.all(sources.map(async (source, index) => {
      if (source.kind === "content") {
        const target = join(stagingDir, String(index));
        await writeFile(target, source.content);
        return target;
      }
      if (source.kind === "symlink") {
        const target = join(stagingDir, String(index));
        await writeFile(target, await readlink(source.path));
        return target;
      }
      if (!needsAlias(source.path)) return source.path;
      const alias = join(stagingDir, String(index));
      await symlink(source.path, alias);
      return alias;
    }));
    // Loose objects are temporary and repacked right away, so skip compressing them.
    const { stdout } = await git(builder, ["-c", "core.loosecompression=0", "hash-object", "-w", "--no-filters", "--stdin-paths"], `${paths.join("\n")}\n`);
    const oids = stdout.split("\n").filter(Boolean);
    if (oids.length !== sources.length) throw new Error(`hash-object returned ${oids.length} ids for ${sources.length} blobs`);
    return oids;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writeTree(builder: ObjectBuilder, entries: TreeEntry[]) {
  await rm(builder.env.GIT_INDEX_FILE as string, { force: true });
  const input = entries.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join("");
  await git(builder, ["update-index", "-z", "--index-info"], input);
  const { stdout } = await git(builder, ["write-tree"]);
  return stdout.trim();
}

/** `commit-tree` insists the parent exists locally; the raw object does not need it. */
export async function writeCommit(builder: ObjectBuilder, input: { tree: string; parent: string | null; message: string; date: Date }) {
  const identity = `Cohub Worker <${config.checkpointGitAuthorEmail}> ${Math.floor(input.date.getTime() / 1000)} +0000`;
  const body = [`tree ${input.tree}`, ...(input.parent ? [`parent ${input.parent}`] : []), `author ${identity}`, `committer ${identity}`, "", input.message, ""].join("\n");
  const { stdout } = await git(builder, ["hash-object", "-t", "commit", "-w", "--stdin"], body);
  return stdout.trim();
}

/**
 * Pack `objects` as listed, or every object reachable from `include` and not
 * from `exclude`. Packs are never thin, so each one is readable on its own.
 */
export async function packObjects(input: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  outDir: string;
  objects?: string[];
  include?: string[];
  exclude?: string[];
  /** Skip delta search; saves use this to stay latency-bound, compaction recompresses later. */
  fast?: boolean;
}): Promise<BuiltPack> {
  await mkdir(input.outDir, { recursive: true, mode: 0o700 });
  const list = input.objects ? [...new Set(input.objects)] : [...(input.include ?? []), ...(input.exclude ?? []).map((oid) => `^${oid}`)];
  const { stdout } = await runCheckpointGit(
    [...(input.fast ? ["-c", "pack.compression=1"] : []), "pack-objects", ...(input.objects ? [] : ["--revs"]), "-q", "--delta-base-offset", ...(input.fast ? ["--window=0"] : []), join(input.outDir, "pack")],
    { cwd: input.cwd, env: input.env, input: `${list.join("\n")}\n` },
  );
  return builtPack(input.outDir, stdout);
}

/** The pack `pack-objects` wrote under `outDir`, from the checksum it printed. */
export async function builtPack(outDir: string, stdout: string): Promise<BuiltPack> {
  const checksum = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(checksum)) throw new Error(`pack-objects returned an invalid checksum: ${checksum}`);
  const packPath = join(outDir, `pack-${checksum}.pack`);
  const idxPath = join(outDir, `pack-${checksum}.idx`);
  const [packStat, idxStat] = await Promise.all([stat(packPath), stat(idxPath)]);
  return { checksum, packPath, idxPath, size: packStat.size, idxSize: idxStat.size };
}

