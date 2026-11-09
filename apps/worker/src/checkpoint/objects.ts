import { copyFile, mkdir, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkpointGitDir,
  checkpointPackDir,
  installPackFiles,
  isPackInstalled,
  runCheckpointGit,
} from "@cohub/core/checkpoint/storage";
import { config } from "../config.js";

/**
 * Builds checkpoint commits without a working tree: new objects go to a local
 * object directory, existing ones are read from the cache repository through
 * alternates, and everything the commit adds is written out as one pack.
 */
export type ObjectBuilder = {
  repoDir: string;
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

export async function createObjectBuilder(repoDir: string, tmpDir: string): Promise<ObjectBuilder> {
  const objectDir = join(tmpDir, "objects");
  await mkdir(objectDir, { recursive: true, mode: 0o700 });
  return {
    repoDir,
    tmpDir,
    env: {
      GIT_DIR: checkpointGitDir(repoDir),
      GIT_OBJECT_DIRECTORY: objectDir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(checkpointGitDir(repoDir), "objects"),
      GIT_INDEX_FILE: join(tmpDir, "index"),
    },
  };
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

export async function commitTree(builder: ObjectBuilder, input: { tree: string; parent: string | null; message: string; date: Date }) {
  const date = `${Math.floor(input.date.getTime() / 1000)} +0000`;
  const { stdout } = await runCheckpointGit(
    ["commit-tree", input.tree, ...(input.parent ? ["-p", input.parent] : []), "-m", input.message],
    {
      cwd: builder.tmpDir,
      env: {
        ...builder.env,
        GIT_AUTHOR_NAME: "Cohub Worker",
        GIT_AUTHOR_EMAIL: config.checkpointGitAuthorEmail,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "Cohub Worker",
        GIT_COMMITTER_EMAIL: config.checkpointGitAuthorEmail,
        GIT_COMMITTER_DATE: date,
      },
    },
  );
  return stdout.trim();
}

/**
 * Pack every object reachable from `include` and not from `exclude`. Packs
 * are never thin, so each one is readable on its own.
 */
export async function packObjects(input: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  outDir: string;
  include: string[];
  exclude: string[];
  /** Skip delta search; saves use this to stay latency-bound, compaction recompresses later. */
  fast?: boolean;
}): Promise<BuiltPack> {
  await mkdir(input.outDir, { recursive: true, mode: 0o700 });
  const revs = [...input.include, ...input.exclude.map((oid) => `^${oid}`)].join("\n");
  const { stdout } = await runCheckpointGit(
    [...(input.fast ? ["-c", "pack.compression=1"] : []), "pack-objects", "--revs", "-q", "--delta-base-offset", ...(input.fast ? ["--window=0"] : []), join(input.outDir, "pack")],
    { cwd: input.cwd, env: input.env, input: `${revs}\n` },
  );
  const checksum = stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(checksum)) throw new Error(`pack-objects returned an invalid checksum: ${checksum}`);
  const packPath = join(input.outDir, `pack-${checksum}.pack`);
  const idxPath = join(input.outDir, `pack-${checksum}.idx`);
  const [packStat, idxStat] = await Promise.all([stat(packPath), stat(idxPath)]);
  return { checksum, packPath, idxPath, size: packStat.size, idxSize: idxStat.size };
}

/** Copy a locally built pack into the cache repository. */
export async function installLocalPack(repoDir: string, pack: BuiltPack) {
  if (await isPackInstalled(repoDir, pack.checksum)) return;
  const packDir = checkpointPackDir(repoDir);
  await mkdir(packDir, { recursive: true, mode: 0o775 });
  const token = crypto.randomUUID();
  const packPath = join(packDir, `tmp_cohub_${token}.pack`);
  const idxPath = join(packDir, `tmp_cohub_${token}.idx`);
  try {
    await copyFile(pack.packPath, packPath);
    await copyFile(pack.idxPath, idxPath);
    await installPackFiles(repoDir, pack.checksum, { packPath, idxPath });
  } finally {
    await Promise.all([rm(packPath, { force: true }), rm(idxPath, { force: true })]);
  }
}

/** Above this many packs, every git process in the cache (saves, API reads) pays noticeably for scanning them. */
const CACHE_PACK_LIMIT = 16;

/**
 * Keep the cache repository's pack count logarithmic. A geometric repack only
 * merges whole packs (`pack-objects --stdin-packs`) and never prunes by
 * reachability, so every object and completion marker stays valid.
 */
export async function compactCachePacks(repoDir: string) {
  const packs = (await readdir(checkpointPackDir(repoDir)).catch(() => [])).filter((name) => name.endsWith(".pack")).length;
  if (packs <= CACHE_PACK_LIMIT) return { packs, repacked: false };
  await runCheckpointGit(["repack", "--geometric=2", "-d", "-q"], { cwd: repoDir, env: { GIT_DIR: checkpointGitDir(repoDir) } });
  return { packs, repacked: true };
}
