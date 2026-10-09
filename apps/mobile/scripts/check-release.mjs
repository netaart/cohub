import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import process from "node:process";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const packageJson = await readJson(new URL("../package.json", import.meta.url));
const appJson = await readJson(new URL("../app.json", import.meta.url));
const version = String(packageJson.version ?? "").trim();
const appVersion = String(appJson.expo?.version ?? "").trim();
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const stableSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const failures = [];
// The monorepo's vX.Y.Z tags belong to the Cohub services; app releases use their own prefix.
const TAG_PREFIX = "cohub-mobile-v";

if (!semver.test(version)) failures.push(`package.json has invalid SemVer: ${version || "<empty>"}`);
if (version !== appVersion) failures.push(`Version mismatch: package.json=${version}, app.json=${appVersion}`);

const expectedTag = process.env.RELEASE_TAG?.trim() ||
  (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME?.trim() : "");
if (expectedTag && expectedTag !== `${TAG_PREFIX}${version}`) {
  failures.push(`Tag mismatch: expected ${TAG_PREFIX}${version}, received ${expectedTag}`);
}

if (process.argv.includes("--require-native-tag")) {
  if (!expectedTag) failures.push("A release tag is required for a native production build");
  if (!stableSemver.test(version)) failures.push(`Native production builds require a stable package version: ${version}`);
  if (expectedTag && !/^cohub-mobile-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(expectedTag)) {
    failures.push(`Native production builds require a stable ${TAG_PREFIX}X.Y.Z tag: ${expectedTag}`);
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { stdio: "ignore" });
  } catch {
    failures.push("The checked out native release commit must be reachable from origin/main");
  }
}

if (failures.length > 0) {
  console.error("Release validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release metadata is valid for ${TAG_PREFIX}${version}.`);
