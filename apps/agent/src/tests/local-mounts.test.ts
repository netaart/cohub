import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "cohub-local-mounts-"));
process.env.PLATFORM_CONFIG_ROOT = join(root, "configs");
process.env.CHECKPOINT_CACHE_ROOT = join(root, "checkpoints");

const modSpaceId = "22222222-2222-4222-8222-222222222222";
const modDir = join(root, "checkpoints", modSpaceId, "latest");
await mkdir(join(modDir, ".agents", "skills", "demo"), { recursive: true });
await writeFile(join(modDir, ".agents", "skills", "demo", "SKILL.md"), "Demo skill.");
await writeFile(join(modDir, "run.sh"), "echo hi", { mode: 0o755 });
await symlink("/etc/passwd", join(modDir, "leak"));

const { localMountSources, syncLocalMounts } = await import("../sandbox/local-mounts.js");

const held = new Map<string, string>();
const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
const rpc = async (method: string, params: Record<string, unknown>) => {
  calls.push({ method, params });
  if (method === "mounts.sync") {
    return { mounts: (params.mounts as Array<{ path: string }>).map(({ path }) => ({ path, hostPath: `/host${path}`, revision: held.get(path) })) };
  }
  if (params.final) held.set(params.path as string, params.revision as string);
  return { path: params.path, written: 0 };
};
const sources = localMountSources({ ownerUserId: null, mods: [{ modSpaceId, mountPath: "/mods/demo" }] as never });
const sync = (capabilities: Record<string, boolean> = { mounts: true }) => syncLocalMounts({ rpc: rpc as never, capabilities: capabilities as never, spaceId: "s", sources });

const mounts = await sync();
assert.deepEqual(mounts, { "/configs/platform/.agents": "/host/configs/platform/.agents", "/mods/demo": "/host/mods/demo" });
const modWrite = calls.find((call) => call.method === "mounts.write" && call.params.path === "/mods/demo");
const files = modWrite?.params.files as Array<{ path: string; executable?: boolean }>;
assert.deepEqual(files.map((file) => file.path).sort(), [".agents/skills/demo/SKILL.md", "run.sh"], "symlinks are not mirrored");
assert.equal(files.find((file) => file.path === "run.sh")?.executable, true);

calls.length = 0;
await sync();
assert.deepEqual(calls.map((call) => call.method), ["mounts.sync"], "an up-to-date Runtime needs no uploads");

assert.equal(await sync({}), null, "an older Runtime holds no mounts");
