import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SDK = {
  name: "@talesofai-billing/sdk",
  version: "1.31.0",
  integrity: "sha512-aXm+Kcz2G8A7XrpoTIhvmLlvvW7MgmDeUV2HoL6DJEr1YF+XqlkSQqrLhcUyA9f7XblJxZGTc1aRdfAn45vUOg==",
};
const REGISTRY = "//git.talesofai.com/api/packages/talesofai/npm/";
const TARBALL = `https:${REGISTRY}%40talesofai-billing%2Fsdk/-/${SDK.version}/sdk-${SDK.version}.tgz`;

const billingDir = realpathSync(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
// Sit beside @cohub/billing's own dependencies so the SDK resolves them (zod).
const modulesDir = basename(dirname(dirname(billingDir))) === "node_modules"
  ? dirname(dirname(billingDir))
  : join(billingDir, "node_modules");
const target = join(modulesDir, SDK.name);

function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

function readToken() {
  if (process.env.GITEA_NPM_TOKEN) return process.env.GITEA_NPM_TOKEN;
  try {
    return execFileSync("pnpm", ["config", "get", `${REGISTRY}:_authToken`], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

if (installedVersion() === SDK.version) process.exit(0);

const token = readToken();
if (!token || token === "undefined") {
  if (process.env.COHUB_REQUIRE_BILLING_SDK === "1") {
    console.error(`${SDK.name}: no registry token (GITEA_NPM_TOKEN), but COHUB_REQUIRE_BILLING_SDK=1`);
    process.exit(1);
  }
  console.log(`${SDK.name}: skipped, no registry token (hosted billing stays disabled)`);
  process.exit(0);
}

const response = await fetch(TARBALL, { headers: { authorization: `Bearer ${token}` } });
if (!response.ok) throw new Error(`${SDK.name}: download failed with HTTP ${response.status}`);
const tarball = Buffer.from(await response.arrayBuffer());
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
if (integrity !== SDK.integrity) throw new Error(`${SDK.name}: integrity mismatch (${integrity})`);

const staging = `${target}.${process.pid}.tmp`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const tar = spawnSync("tar", ["-xzf", "-", "--strip-components=1", "-C", staging], { input: tarball, stdio: ["pipe", "inherit", "inherit"] });
if (tar.error || tar.status !== 0) {
  rmSync(staging, { recursive: true, force: true });
  throw tar.error ?? new Error(`${SDK.name}: tar exited with ${tar.status}`);
}

const { dependencies = {} } = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
const missing = Object.keys(dependencies).filter((name) => !existsSync(join(modulesDir, name)));
if (missing.length > 0) {
  rmSync(staging, { recursive: true, force: true });
  throw new Error(`${SDK.name}: add ${missing.join(", ")} to @cohub/billing dependencies`);
}

rmSync(target, { recursive: true, force: true });
renameSync(staging, target);
console.log(`${SDK.name}@${SDK.version} installed in ${modulesDir}`);
