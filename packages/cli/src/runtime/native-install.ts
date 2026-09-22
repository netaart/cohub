import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { atomicRuntimeJson } from "./archive-store.js";
import { nativeRuntimeRoot, nativeSyncConfigPath, readNativeSyncConfig, type NativeSyncConfig } from "./native-sync.js";
import { withRuntimeSpaceBindingsLock } from "./space-binding.js";

const START = "# BEGIN COHUB NATIVE SYNC";
const END = "# END COHUB NATIVE SYNC";
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export function codexNativeHookBlock(node: string, hook: string) {
  const command = `${shellQuote(node)} ${shellQuote(hook)}`;
  return `${START}\n${["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "Interrupt", "SessionEnd"].map((event) =>
    `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = ${event === "SessionEnd" || event === "Interrupt" ? 3 : 10}\n`).join("\n")}${END}\n`;
}

async function installText(path: string, update: (existing: string | null) => string) {
  await withRuntimeSpaceBindingsLock(async () => {
    const info = await lstat(path).catch((error) => { if (missing(error)) return null; throw error; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Refusing to replace a non-regular file / 不覆盖非普通文件: ${path}`);
    const original = info ? await readFile(path, "utf8") : null;
    const next = update(original);
    if (next === original) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (original !== null) {
      const backup = `${path}.cohub-backup-${createHash("sha256").update(original).digest("hex").slice(0, 16)}`;
      const file = await open(backup, "wx", 0o600).catch((error) => { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; throw error; });
      if (file) { try { await file.writeFile(original); await file.sync(); } finally { await file.close(); } }
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", info?.mode ?? 0o600);
      try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
      const current = await readFile(path, "utf8").catch((error) => { if (missing(error)) return null; throw error; });
      if (current !== original) throw new Error(`Configuration changed during installation / 安装期间配置已变化: ${path}`);
      await rename(temporary, path);
      const directory = await open(dirname(path), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
  }, { lockPath: `${path}.cohub-lock` });
}

export async function verifyNativeSyncSupport(harnesses: ("pi" | "codex")[], cwd: string, executables: { pi?: string; codex?: string } = {}) {
  for (const harness of harnesses) {
    const { stdout } = await promisify(execFile)(executables[harness] || harness, harness === "pi" ? ["--version"] : ["features", "list"], { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
    if (harness === "pi") {
      const version = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(stdout);
      if (!version || Number(version[1]) === 0 && (Number(version[2]) < 85 || Number(version[2]) === 85 && Number(version[3]) < 1)) throw new Error("Native sync requires Pi 0.85.1+ / 原生同步需要 Pi 0.85.1 或更高版本");
    } else if (!/^hooks\s+stable\s+true\s*$/m.test(stdout)) throw new Error("Install a Codex version with stable Hooks and enable hooks first / 请安装支持稳定 Hooks 的 Codex 版本并启用 Hooks");
  }
}

/** Install once in the user's native configuration; data collection remains explicitly project-scoped. */
export async function installNativeSync(input: { root: string; spaceId: string; identity: string; harnesses: ("pi" | "codex")[]; disabled?: boolean; executables?: { pi?: string; codex?: string } }) {
  if (!input.disabled) await verifyNativeSyncSupport(input.harnesses, input.root, input.executables);
  const runtimeRoot = nativeRuntimeRoot(input.spaceId);
  const configPath = nativeSyncConfigPath(runtimeRoot, input.identity);
  const extension = new URL(import.meta.url.endsWith(".ts") ? "./native-pi-extension.ts" : "./native-pi-extension.js", import.meta.url);
  const hook = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./native-codex-hook.ts" : "./native-codex-hook.js", import.meta.url));
  if (!input.disabled) for (const harness of input.harnesses) {
    if (harness === "pi") {
      const content = `// Cohub native Turn sync / Cohub 原生 Turn 同步\nexport { default } from ${JSON.stringify(extension.href)};\n`;
      await installText(join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "extensions", "cohub.ts"), (existing) => {
        if (existing !== null && existing !== content) throw new Error("Pi Cohub extension already exists; preserve it and review manually / Pi Cohub 扩展已存在，请保留并手动核对");
        return content;
      });
    } else {
      const block = codexNativeHookBlock(process.execPath, hook);
      await installText(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), (existing) => {
        if (existing?.includes(block)) return existing;
        if (existing?.includes(START) || existing?.includes(END)) throw new Error("Codex Cohub hook block differs; preserve it and review manually / Codex Cohub Hook 配置不同，请保留并手动核对");
        if (existing && /^\s*hooks\s*=/m.test(existing)) throw new Error("Inline Codex hooks require manual merging / 内联 Codex Hooks 需要手动合并");
        return `${existing ?? ""}${existing?.endsWith("\n") ? "\n" : "\n\n"}${block}`;
      });
    }
  }
  await withRuntimeSpaceBindingsLock(async () => {
    const previous = await readNativeSyncConfig(runtimeRoot, input.identity);
    if (previous && previous.root !== input.root) throw new Error("Space native sync belongs to another directory / 此 Space 原生同步属于其他目录");
    const harnesses = new Set(previous?.harnesses ?? []);
    for (const harness of input.harnesses) { if (input.disabled) harnesses.delete(harness); else harnesses.add(harness); }
    const config: NativeSyncConfig = { version: 1, identity: input.identity, spaceId: input.spaceId, root: input.root, harnesses: [...harnesses] };
    await atomicRuntimeJson(configPath, config);
  }, { path: configPath });
  return { configPath, harnesses: input.harnesses, enabled: !input.disabled };
}
