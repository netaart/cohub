import { readFile } from "node:fs/promises";
import process from "node:process";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const packageJson = await readJson(new URL("../package.json", import.meta.url));
const appJson = await readJson(new URL("../app.json", import.meta.url));
const version = String(packageJson.version ?? "").trim();
const appVersion = String(appJson.expo?.version ?? "").trim();
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const failures = [];

if (!semver.test(version)) failures.push(`package.json has invalid SemVer: ${version || "<empty>"}`);
if (version !== appVersion) failures.push(`Version mismatch: package.json=${version}, app.json=${appVersion}`);

const expectedTag = process.env.RELEASE_TAG?.trim() ||
  (process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME?.trim() : "");
if (expectedTag && expectedTag !== `v${version}`) {
  failures.push(`Tag mismatch: expected v${version}, received ${expectedTag}`);
}

if (process.argv.includes("--require-eas")) {
  const projectId = process.env.EXPO_PROJECT_ID?.trim();
  const owner = process.env.EXPO_OWNER?.trim();
  const token = process.env.EXPO_TOKEN?.trim();
  if (!projectId) failures.push("EXPO_PROJECT_ID is required for an EAS release");
  if (!owner) failures.push("EXPO_OWNER is required for an EAS release");
  if (!token) failures.push("EXPO_TOKEN is required for an EAS release");
}

if (failures.length > 0) {
  console.error("Release validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release metadata is valid for v${version}.`);
