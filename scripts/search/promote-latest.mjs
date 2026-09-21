import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} / 缺少 ${name}`);
  return value;
}

function versionParts(version) {
  if (typeof version !== "string" || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(`Invalid search release version / 搜索版本无效: ${JSON.stringify(version)}`);
  }
  return version.slice(1).split(".").map(BigInt);
}

// The workflow serializes this read/compare/write across all release tags.
function promoteLatest() {
  const version = requiredEnv("VERSION");
  const incoming = versionParts(version);
  const bucket = requiredEnv("OSS_BUCKET");
  const endpoint = requiredEnv("OSS_ENDPOINT");
  const directory = mkdtempSync(join(tmpdir(), "cohub-search-release-"));
  try {
    const pointer = join(directory, "latest.json");
    const result = spawnSync("aws", [
      "s3api", "get-object", "--bucket", bucket, "--key", "search/latest.json",
      "--endpoint-url", endpoint, pointer,
    ], { encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status === 0) {
      const currentVersion = JSON.parse(readFileSync(pointer, "utf8"))?.version;
      const current = versionParts(currentVersion);
      const difference = incoming.findIndex((part, index) => part !== current[index]);
      if (difference === -1 || incoming[difference] < current[difference]) {
        console.log(`Keep latest ${currentVersion}; skip ${version} / 保留当前版本，跳过本次更新`);
        return;
      }
    } else if (!result.stderr.includes("(NoSuchKey)")) {
      throw new Error(`Read latest release failed / 读取当前版本失败: ${result.stderr.trim()}`);
    }

    writeFileSync(pointer, `${JSON.stringify({ version })}\n`);
    execFileSync("aws", [
      "s3", "cp", pointer, `s3://${bucket}/search/latest.json`,
      "--endpoint-url", endpoint,
      "--content-type", "application/json",
      "--cache-control", "no-cache, max-age=0",
    ], { stdio: "inherit" });
    console.log(`Promoted search ${version} / 搜索版本已更新`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

promoteLatest();
