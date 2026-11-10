import { runCheckpointGit } from "@cohub/core/checkpoint/storage";

export type TreeLeaf = { mode: string; oid: string };

const parentDir = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
};
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const depth = (dir: string) => (dir === "" ? 0 : dir.split("/").length);

/**
 * Write the trees of a snapshot, rebuilding only directories that contain a
 * changed or deleted path, or that `previous` does not know. Every other
 * directory reuses its tree id, so the cost follows the change, not the
 * workspace. Referenced objects need not exist locally (`mktree --missing`).
 */
export async function writeTrees(input: {
  env: NodeJS.ProcessEnv;
  cwd: string;
  leaves: Map<string, TreeLeaf>;
  dirty: Iterable<string>;
  previous: Map<string, string>;
}) {
  const children = new Map<string, Set<string>>();
  for (const path of input.leaves.keys()) {
    let child = path;
    for (let dir = parentDir(path); ; dir = parentDir(dir)) {
      let set = children.get(dir);
      if (!set) {
        set = new Set();
        children.set(dir, set);
      }
      if (set.has(child)) break;
      set.add(child);
      if (dir === "") break;
      child = dir;
    }
  }
  if (!children.has("")) children.set("", new Set());

  const rebuild = new Set<string>();
  const markWithParents = (dir: string) => {
    for (let current = dir; !rebuild.has(current); current = parentDir(current)) {
      rebuild.add(current);
      if (current === "") break;
    }
  };
  for (const path of input.dirty) markWithParents(parentDir(path));
  for (const dir of children.keys()) if (!input.previous.has(dir)) markWithParents(dir);

  const trees = new Map<string, string>();
  for (const [dir, oid] of input.previous) if (children.has(dir) && !rebuild.has(dir)) trees.set(dir, oid);
  const levels = new Map<number, string[]>();
  for (const dir of rebuild) {
    if (!children.has(dir)) continue;
    const level = levels.get(depth(dir)) ?? [];
    level.push(dir);
    levels.set(depth(dir), level);
  }

  const written: string[] = [];
  for (const level of [...levels.keys()].sort((a, b) => b - a)) {
    const dirs = levels.get(level) as string[];
    const body = dirs.map((dir) => {
      let tree = "";
      for (const child of children.get(dir) as Set<string>) {
        const leaf = input.leaves.get(child);
        tree += leaf
          ? `${leaf.mode} ${leaf.mode === "040000" ? "tree" : "blob"} ${leaf.oid}\t${baseName(child)}\x00`
          : `040000 tree ${trees.get(child)}\t${baseName(child)}\x00`;
      }
      return `${tree}\x00`;
    }).join("");
    const { stdout } = await runCheckpointGit(["mktree", "-z", "--missing", "--batch"], { cwd: input.cwd, env: input.env, input: body });
    const oids = stdout.split("\n").filter(Boolean);
    if (oids.length !== dirs.length) throw new Error(`mktree returned ${oids.length} trees for ${dirs.length} directories`);
    for (const [index, dir] of dirs.entries()) trees.set(dir, oids[index] as string);
    written.push(...oids);
  }
  return { root: trees.get("") as string, trees, written };
}
