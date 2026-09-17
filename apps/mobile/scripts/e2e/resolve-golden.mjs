import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Picks the released Android binary a device E2E run installs before OTA.
 *
 * The golden binary must embed the same runtime (native fingerprint) as the
 * target commit, otherwise the OTA server refuses the update and the run tests
 * nothing. It must also predate the target commit, because expo-updates only
 * downloads an update newer than the embedded bundle; a golden built from the
 * target itself has nothing to fetch.
 */

const DEFAULT_REPOSITORY = "markbang/cohub-mobile";
const FINGERPRINT_ASSET = "cohub-android-native-fingerprint.txt";
const CANDIDATE_LIMIT = 12;
const ABIS = ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"];
const HASH = /^[a-f0-9]{40,64}$/;

export function parseAbi(value) {
  const abi = String(value ?? "").trim();
  if (!ABIS.includes(abi)) {
    throw new Error(`Unsupported ABI "${abi}". Use one of: ${ABIS.join(", ")}.`);
  }
  return abi;
}

export function parseFingerprint(value, source) {
  const hash = String(value ?? "").trim().toLowerCase();
  if (!HASH.test(hash)) {
    throw new Error(`${source} is not a fingerprint hash. Rebuild the matching native distribution.`);
  }
  return hash;
}

/**
 * `fingerprint.config.js` skips version fields, so the hash only changes with
 * native code. `app.config.ts` folds EXPO_PUBLIC_UPDATES_URL into the public
 * config, so the build-time value must be set here too or the hash differs from
 * the one embedded in the released APK.
 */
export function selectGolden(releases) {
  const eligible = releases.filter((release) => release.fingerprintMatches && release.apkName);
  if (eligible.length === 0) return null;
  const withUpdate = eligible.find((release) => release.aheadBy > 0);
  return withUpdate ?? eligible[0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").at(-1);
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return result.stdout;
}

function computeFingerprint() {
  const updatesUrl = process.env.EXPO_PUBLIC_UPDATES_URL?.trim();
  if (!updatesUrl) {
    throw new Error(
      "EXPO_PUBLIC_UPDATES_URL must match the value native builds were built with, or the fingerprint will not match the released APK. See .env.example.",
    );
  }
  const env = { ...process.env };
  delete env.COHUB_OTA_RUNTIME_VERSION;
  const raw = run("npx", ["--no-install", "@expo/fingerprint", "fingerprint:generate", "--platform", "android"], { env });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The fingerprint CLI did not return JSON. Run it directly to inspect the output.");
  }
  return parseFingerprint(parsed.hash, "The current commit's Android fingerprint");
}

function listReleases(repository) {
  const raw = run("gh", [
    "release", "list", "--repo", repository,
    "--exclude-drafts", "--exclude-pre-releases",
    "--limit", String(CANDIDATE_LIMIT),
    "--json", "tagName,publishedAt",
  ]);
  return JSON.parse(raw).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

function releaseAssets(repository, tag) {
  const raw = run("gh", ["release", "view", tag, "--repo", repository, "--json", "assets"]);
  return JSON.parse(raw).assets;
}

function releasedFingerprint(repository, tag) {
  const directory = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    run("gh", ["release", "download", tag, "--repo", repository, "--pattern", FINGERPRINT_ASSET, "--dir", directory]);
    return readFileSync(join(directory, FINGERPRINT_ASSET), "utf8").trim().toLowerCase();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function commitsAhead(repository, from, to) {
  const raw = run("gh", ["api", `repos/${repository}/compare/${from}...${to}`, "--jq", ".ahead_by"]);
  const ahead = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(ahead) || ahead < 0) throw new Error(`Cannot compare ${from}...${to}.`);
  return ahead;
}

function describe(release, targetCommit) {
  const status = release.aheadBy > 0
    ? `${release.aheadBy} commits ahead of the golden tag, so an OTA update exists`
    : "golden is the target commit; no newer OTA bundle is pending";
  return [
    `Golden: ${release.tag}`,
    `  apk        ${release.apkName} (${release.apkDigest ?? "no digest"})`,
    `  runtime    ${release.fingerprint}`,
    `  tag commit ${release.commit}`,
    `  target     ${targetCommit}`,
    `  ota        ${status}`,
  ].join("\n");
}

function parseArgs(argv) {
  const options = { repository: DEFAULT_REPOSITORY, abi: "x86_64", commit: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") options.json = true;
    else if (flag === "--abi") options.abi = parseAbi(argv[++index]);
    else if (flag === "--commit") options.commit = String(argv[++index] ?? "").trim();
    else if (flag === "--repository") options.repository = String(argv[++index] ?? "").trim();
    else throw new Error(`Unknown argument "${flag}".`);
  }
  return options;
}

export async function resolveGolden(options) {
  const fingerprint = computeFingerprint();
  const targetCommit = options.commit || run("gh", ["api", `repos/${options.repository}/commits/main`, "--jq", ".sha"]).trim();
  if (!/^[0-9a-f]{7,40}$/.test(targetCommit)) throw new Error(`Invalid target commit "${targetCommit}".`);

  const releases = listReleases(options.repository).flatMap(({ tagName, publishedAt }) => {
    const assets = releaseAssets(options.repository, tagName);
    const apk = assets.find((asset) => asset.name.endsWith(`-android-${options.abi}.apk`));
    // Distributions older than the OTA fingerprint work never recorded one.
    if (!apk || !assets.some((asset) => asset.name === FINGERPRINT_ASSET)) return [];
    return [{
      tag: tagName,
      publishedAt,
      commit: run("gh", ["api", `repos/${options.repository}/commits/${tagName}`, "--jq", ".sha"]).trim(),
      fingerprint: releasedFingerprint(options.repository, tagName),
      apkName: apk.name,
      apkDigest: apk.digest ?? null,
      targetCommit,
    }];
  });

  const candidates = releases.map((release) => ({
    ...release,
    fingerprintMatches: release.fingerprint === fingerprint,
    aheadBy: commitsAhead(options.repository, release.commit, targetCommit),
  }));

  const golden = selectGolden(candidates);
  if (!golden) {
    throw new Error(
      `No released Android APK embeds runtime ${fingerprint}. Ship a native distribution for this commit first; JS-only changes can ride an existing one.`,
    );
  }
  return { fingerprint, targetCommit, golden, candidates };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const plan = await resolveGolden(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      process.stdout.write(`${describe(plan.golden, plan.targetCommit)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
