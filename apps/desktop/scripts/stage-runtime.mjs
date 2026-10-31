#!/usr/bin/env node
// Usage: node apps/desktop/scripts/stage-runtime.mjs --platform darwin|win32 --arch arm64|x64 --out <dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const NODE_VERSION = "26.13.0";
const PLATFORMS = { darwin: "darwin", win32: "win" };
const GOOS = { darwin: "darwin", win32: "windows" };
const GOARCH = { arm64: "arm64", x64: "amd64" };
const ARCHS = ["arm64", "x64"];

const { values } = parseArgs({
  options: {
    platform: { type: "string", default: process.platform },
    arch: { type: "string", default: process.arch },
    out: { type: "string" },
  },
});
const { platform, arch } = values;
if (!PLATFORMS[platform] || !ARCHS.includes(arch) || !values.out) {
  console.error("Usage: stage-runtime.mjs --platform darwin|win32 --arch arm64|x64 --out <dir>");
  process.exit(1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const out = resolve(values.out);
const work = await mkdtemp(join(tmpdir(), "cohub-runtime-"));
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });

async function download(url, path) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}

async function stageNode() {
  const name = `node-v${NODE_VERSION}-${PLATFORMS[platform]}-${arch}`;
  const archive = `${name}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  await download(`${base}/${archive}`, join(work, archive));
  await download(`${base}/SHASUMS256.txt`, join(work, "SHASUMS256.txt"));
  const expected = (await readFile(join(work, "SHASUMS256.txt"), "utf8"))
    .split("\n").find((line) => line.endsWith(`  ${archive}`))?.split(" ")[0];
  const actual = createHash("sha256").update(await readFile(join(work, archive))).digest("hex");
  if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${archive}`);

  const member = platform === "win32" ? `${name}/node.exe` : `${name}/bin/node`;
  try { run("tar", ["-xf", join(work, archive), "-C", work, member]); }
  catch { run("unzip", ["-q", join(work, archive), member, "-d", work]); }
  const binary = join(out, platform === "win32" ? "node.exe" : "node");
  await copyFile(join(work, member), binary);
  await chmod(binary, 0o755);
}

async function stageCli() {
  const packs = join(work, "packs");
  await mkdir(packs);
  for (const name of ["@neta-art/cohub", "@neta-art/cohub-cli"]) {
    run("pnpm", ["--filter", name, "pack", "--pack-destination", packs], { cwd: root, shell: process.platform === "win32" });
  }
  const tarballs = (await readdir(packs)).filter((file) => file.endsWith(".tgz")).map((file) => join(packs, file));
  const cli = join(out, "cli");
  await mkdir(cli, { recursive: true });
  run("npm", [
    "install", "--prefix", cli, "--omit=dev", "--install-links", "--no-audit", "--no-fund", "--no-package-lock",
    `--os=${platform}`, `--cpu=${arch}`, ...tarballs,
  ], { shell: process.platform === "win32" });
  await rm(join(cli, "package.json"), { force: true });
  return JSON.parse(await readFile(join(cli, "node_modules/@neta-art/cohub-cli/package.json"), "utf8")).version;
}

async function stageSandboxd(cli) {
  const directory = join(out, "sandboxd");
  await mkdir(directory, { recursive: true });
  const module = join(root, "apps/sandbox");
  const clang = platform === "darwin" ? { CGO_ENABLED: "1", CC: `clang -arch ${arch === "x64" ? "x86_64" : "arm64"}` } : { CGO_ENABLED: "0" };
  run("go", [
    "build", "-trimpath", "-ldflags", `-s -w -X main.buildVersion=desktop-${cli}`,
    "-o", join(directory, platform === "win32" ? "cohub-sandboxd.exe" : "cohub-sandboxd"), ".",
  ], { cwd: module, env: { ...process.env, GOOS: GOOS[platform], GOARCH: GOARCH[arch], ...clang } });
  for (const notice of ["LICENSE", "NOTICE"]) await copyFile(join(module, notice), join(directory, notice));
}

try {
  if (!existsSync(join(root, "packages/cli/dist/index.js"))) {
    throw new Error("Build the CLI first: pnpm --filter @neta-art/cohub-cli... build");
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await stageNode();
  const cli = await stageCli();
  await stageSandboxd(cli);
  await writeFile(join(out, "versions.json"), `${JSON.stringify({ node: NODE_VERSION, cli }, null, 2)}\n`);
  if (platform === process.platform && arch === process.arch) {
    const version = run(join(out, platform === "win32" ? "node.exe" : "node"), [join(out, "cli/node_modules/@neta-art/cohub-cli/bin/cohub.js"), "--version"], {
      env: { ...process.env, COHUB_CLI_AUTO_UPDATE: "0" },
    }).trim();
    console.log(`Staged Node ${NODE_VERSION} and Cohub CLI ${version} for ${platform}-${arch}`);
  } else {
    console.log(`Staged Node ${NODE_VERSION} and Cohub CLI ${cli} for ${platform}-${arch}`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
