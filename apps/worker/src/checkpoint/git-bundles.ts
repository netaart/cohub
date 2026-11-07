import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHECKPOINT_COVER_FANOUT, CHECKPOINT_COVER_MAX_LEVEL } from "@cohub/core/checkpoint/storage";
import { uploadObjectFileIfMissing } from "./assets.js";
import { runGitWithOutput } from "./git.js";
import { ensureWorkerLocalTmpDir, getWorkerLocalTmpDir, removeWorkerLocalTmpDir } from "../local-tmp.js";

export type UserGitRemote = {
  name: string;
  url: string;
  credentialSanitized: boolean;
};

/**
 * One link of a repository's bundle chain. Restoring unbundles the chain in
 * order: each bundle holds what its repository gained after `base`, whose
 * objects the earlier links already hold. A level-k bundle merges
 * FANOUT^k level-0 links; the first full bundle is at the top level.
 */
export type UserGitRepoBundle = {
  sha256: string;
  size: number;
  objectKey: string;
  level: number;
  base: string[];
};

export type UserGitRepoRecord = {
  path: string;
  head: string | null;
  branch: string | null;
  fingerprint: string | null;
  refs: Record<string, string>;
  bundles: UserGitRepoBundle[];
  remotes: UserGitRemote[];
};

type BundleCache = {
  version: 2;
  repos: Record<string, {
    fingerprint: string;
    refs: Record<string, string>;
    bundles: UserGitRepoBundle[];
  }>;
};

const cacheFileName = "git-bundle-cache.v2.json";

const sha256File = (path: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(hash.digest("hex")));
});

const sha256Text = (value: string) => createHash("sha256").update(value).digest("hex");

const buildGitBundleObjectKey = (sha256: string) =>
  `checkpoint-assets/git-bundles/sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}.bundle`;

async function loadCache(systemDir: string): Promise<BundleCache> {
  const raw = await readFile(join(systemDir, cacheFileName), "utf8").catch(() => null);
  if (!raw) return { version: 2, repos: {} };
  try {
    const parsed = JSON.parse(raw) as BundleCache;
    return parsed?.version === 2 && parsed.repos ? parsed : { version: 2, repos: {} };
  } catch {
    return { version: 2, repos: {} };
  }
}

async function saveCache(systemDir: string, cache: BundleCache) {
  const path = join(systemDir, cacheFileName);
  const tmp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(cache)}\n`);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

const sanitizeRemoteUrl = (value: string): { url: string; credentialSanitized: boolean } => {
  const trimmed = value.trim();
  if (!trimmed) return { url: "", credentialSanitized: false };

  try {
    const url = new URL(trimmed);
    const hadCredentials = Boolean(url.username || url.password);
    url.username = "";
    url.password = "";
    return { url: url.toString(), credentialSanitized: hadCredentials };
  } catch {
    // Conservative fallback for non-URL remotes. Handles:
    //   https://token@host/org/repo.git
    //   custom-scheme://user:token@host/org/repo.git
    //   token@host:org/repo.git (scp-like)
    let sanitized = trimmed.replace(/([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, "$1");
    sanitized = sanitized.replace(/^([^@\s]+)@([^:\s]+):(.*)$/u, "$2:$3");
    return { url: sanitized, credentialSanitized: sanitized !== trimmed };
  }
};

async function getRemotes(repoDir: string): Promise<UserGitRemote[]> {
  const names = await runGitWithOutput(["remote"], repoDir).then((result) => result.stdout.split("\n").map((line) => line.trim()).filter(Boolean), () => []);
  const remotes = await Promise.all(names.map(async (name) => {
    const url = await runGitWithOutput(["remote", "get-url", name], repoDir).then((result) => result.stdout.trim(), () => "");
    const sanitized = sanitizeRemoteUrl(url);
    return { name, url: sanitized.url, credentialSanitized: sanitized.credentialSanitized };
  }));
  return remotes;
}

async function getRepoState(repoDir: string) {
  const head = await runGitWithOutput(["rev-parse", "HEAD"], repoDir).then((result) => result.stdout.trim(), () => null);
  if (!head) return { head: null, branch: null, fingerprint: null, refs: {} };
  const branchResult = await runGitWithOutput(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).then((result) => result.stdout.trim(), () => null);
  const branch = branchResult && branchResult !== "HEAD" ? branchResult : null;
  const refLines = await runGitWithOutput(["for-each-ref", "--format=%(refname) %(objectname)"], repoDir).then((result) => result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort(), () => []);
  const refs: Record<string, string> = {};
  for (const line of refLines) {
    const space = line.lastIndexOf(" ");
    if (space > 0) refs[line.slice(0, space)] = line.slice(space + 1);
  }
  return { head, branch, fingerprint: sha256Text(`${head}\n${refLines.join("\n")}\n`), refs };
}

async function existingObjects(repoDir: string, oids: string[]) {
  const unique = [...new Set(oids)];
  const present = await Promise.all(unique.map((oid) => runGitWithOutput(["cat-file", "-e", oid], repoDir).then(() => true, () => false)));
  return unique.filter((_, index) => present[index]);
}

/** Bundle everything reachable from the repository's refs but not from `base`; null when that is nothing. */
async function createBundle(input: { repoDir: string; tmpDir: string; base: string[]; level: number }): Promise<UserGitRepoBundle | null> {
  await mkdir(input.tmpDir, { recursive: true, mode: 0o775 });
  const bundlePath = join(input.tmpDir, `${crypto.randomUUID()}.bundle`);
  try {
    const base = await existingObjects(input.repoDir, input.base);
    const args = ["bundle", "create", bundlePath, "--all", ...(base.length > 0 ? ["--not", ...base] : [])];
    const created = await runGitWithOutput(args, input.repoDir).then(() => true, (error: Error) => {
      if (/empty bundle/i.test(error.message)) return false;
      throw error;
    });
    if (!created) return null;
    const [sha256, st] = await Promise.all([sha256File(bundlePath), stat(bundlePath)]);
    const objectKey = buildGitBundleObjectKey(sha256);
    await uploadObjectFileIfMissing({ filePath: bundlePath, objectKey, size: st.size, mimeType: "application/octet-stream" });
    return { sha256, size: st.size, objectKey, level: input.level, base };
  } finally {
    await rm(bundlePath, { force: true }).catch(() => undefined);
  }
}

/** Merge the newest FANOUT links of one level into one link of the next level. */
async function compactChain(input: { repoDir: string; tmpDir: string; bundles: UserGitRepoBundle[] }) {
  const bundles = [...input.bundles];
  for (;;) {
    const tail = bundles.slice(-CHECKPOINT_COVER_FANOUT);
    const [first] = tail;
    if (!first || tail.length < CHECKPOINT_COVER_FANOUT || first.level >= CHECKPOINT_COVER_MAX_LEVEL || tail.some((bundle) => bundle.level !== first.level)) return bundles;
    const merged = await createBundle({ repoDir: input.repoDir, tmpDir: input.tmpDir, base: first.base, level: first.level + 1 });
    if (!merged) return bundles;
    bundles.splice(bundles.length - CHECKPOINT_COVER_FANOUT, CHECKPOINT_COVER_FANOUT, merged);
  }
}

export async function collectUserGitRepos(input: {
  workspaceDir: string;
  systemDir: string;
  repoPaths: string[];
}): Promise<UserGitRepoRecord[]> {
  const cache = await loadCache(input.systemDir);
  const bundleTmpDir = getWorkerLocalTmpDir("git-bundles", crypto.randomUUID());
  const records: UserGitRepoRecord[] = [];
  const nextRepos: BundleCache["repos"] = {};

  try {
    await ensureWorkerLocalTmpDir(bundleTmpDir);
    for (const repoPath of [...new Set(input.repoPaths)].sort()) {
      const repoDir = repoPath === "." ? input.workspaceDir : join(input.workspaceDir, repoPath);
      const [state, remotes] = await Promise.all([getRepoState(repoDir), getRemotes(repoDir)]);
      let bundles: UserGitRepoBundle[] = [];

      if (state.fingerprint) {
        const cached = cache.repos[repoPath];
        if (cached?.fingerprint === state.fingerprint) {
          bundles = cached.bundles;
        } else {
          const previous = cached?.bundles ?? [];
          const added = await createBundle({
            repoDir,
            tmpDir: bundleTmpDir,
            base: previous.length > 0 ? Object.values(cached?.refs ?? {}) : [],
            level: previous.length > 0 ? 0 : CHECKPOINT_COVER_MAX_LEVEL,
          });
          bundles = added ? await compactChain({ repoDir, tmpDir: bundleTmpDir, bundles: [...previous, added] }) : previous;
        }
        nextRepos[repoPath] = { fingerprint: state.fingerprint, refs: state.refs, bundles };
      }

      records.push({
        path: repoPath,
        head: state.head,
        branch: state.branch,
        fingerprint: state.fingerprint,
        refs: state.refs,
        bundles,
        remotes,
      });
    }

    await saveCache(input.systemDir, { version: 2, repos: nextRepos });
    return records;
  } finally {
    await removeWorkerLocalTmpDir(bundleTmpDir).catch(() => undefined);
  }
}
