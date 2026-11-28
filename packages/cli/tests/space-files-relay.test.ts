import assert from "node:assert/strict";
import { test } from "node:test";
import { relayToSpace } from "../src/space-files/transfer.js";
import type { SpaceFiles } from "../src/space-files/upload.js";

const fakeSpace = (initial: Record<string, string>) => {
  const store = new Map(Object.entries(initial));
  const isDir = (path: string) => [...store.keys()].some((file) => !path || file.startsWith(`${path}/`));
  const files = {
    async list(path: string) {
      if (store.has(path)) throw Object.assign(new Error("not a directory"), { status: 400, code: "not_a_directory" });
      if (!isDir(path)) throw Object.assign(new Error("not found"), { status: 404 });
      const names = new Set([...store.keys()].filter((file) => !path || file.startsWith(`${path}/`))
        .map((file) => file.slice(path ? path.length + 1 : 0).split("/")[0] as string).filter(Boolean));
      const entries = [...names].map((name) => {
        const child = path ? `${path}/${name}` : name;
        return { name, path: child, type: store.has(child) ? "file" : "dir", size: store.get(child)?.length ?? 0, mimeType: null, mtimeMs: 1 };
      });
      return { path, entries };
    },
    async createDir(path: string) {
      store.set(`${path}/`, "");
      return { created: true };
    },
    async open(path: string) {
      return { response: new Response(store.get(path) ?? "") };
    },
    async workspace() {
      return {
        fs: {
          statVersion: async (path: string) =>
            store.has(path) ? { exists: true, size: store.get(path)?.length ?? 0, mtimeMs: 1 } : { exists: false },
        },
        put: async (path: string, body: Blob) => {
          store.set(path, await body.text());
          return { bytesWritten: body.size, mtimeMs: 1, created: true };
        },
      };
    },
  } as unknown as SpaceFiles;
  return { files, store };
};

test("relays a directory between Spaces through this machine", async () => {
  const source = fakeSpace({ "app/a.txt": "a", "app/sub/b.txt": "bb", "app/empty/": "" });
  const target = fakeSpace({ "dest/keep.txt": "k" });
  const result = await relayToSpace({
    files: target.files,
    sources: [{ files: source.files, path: "app" }],
    destination: "dest",
    intoDirectory: true,
    options: { recursive: true, noClobber: false, preserveTimestamps: false },
    onProgress: () => undefined,
  });
  assert.deepEqual(Object.fromEntries([...target.store].sort()), { "dest/app/a.txt": "a", "dest/app/empty/": "", "dest/app/sub/b.txt": "bb", "dest/keep.txt": "k" });
  assert.deepEqual([result.files, result.dirs, result.bytes, result.errors], [2, 1, 3, []]);
  assert.deepEqual(result.paths, ["dest/app"]);
});
