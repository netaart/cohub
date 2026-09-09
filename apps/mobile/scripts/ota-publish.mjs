import { spawnSync } from "node:child_process";

export const OTA_CLI_REPOSITORY = "https://github.com/markbang/cloudflare-expo-ota-updates.git";
export const OTA_CLI_REVISION = "fab754606dfe747abee8faef24d84981789f8064";
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const FINGERPRINT_HASH = /^[a-f0-9]{40,64}$/;
const CHANNELS = new Set(["staging", "production"]);

export function parseCommitSha(value) {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!COMMIT_SHA.test(sha)) {
    throw new Error("Publish OTA requires the full 40-character commit SHA from origin/main.");
  }
  return sha;
}

export function parseChannel(value) {
  const channel = String(value ?? "").trim();
  if (!CHANNELS.has(channel)) throw new Error('OTA channel must be "staging" or "production".');
  return channel;
}

export function parseHttpsOrigin(value, name) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new Error(`${name} must be an absolute HTTPS origin.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error(`${name} must use HTTPS without credentials, query, or fragment.`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(`${name} must be an origin without a path. Use OTA_SERVER, not the /manifest URL.`);
  }
  return url.origin;
}

export function parseFingerprintHash(value, source) {
  const hash = String(value ?? "").trim().toLowerCase();
  if (!FINGERPRINT_HASH.test(hash)) {
    throw new Error(`Invalid native fingerprint in ${source}. Rebuild the matching native distribution.`);
  }
  return hash;
}

export function fingerprintFromCliJson(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Native fingerprint CLI returned invalid JSON from ${source}.`);
  }
  return parseFingerprintHash(parsed?.hash, source);
}

export const NATIVE_FINGERPRINT_ASSET = "cohub-android-native-fingerprint.txt";
export const IOS_NATIVE_FINGERPRINT_ASSET = "cohub-ios-native-fingerprint.txt";

export function fingerprintAssetName(releaseTag) {
  const version = String(releaseTag ?? "").trim().replace(/^v/, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`Native fingerprint files require a stable vX.Y.Z tag, received: ${releaseTag || "<empty>"}`);
  }
  return NATIVE_FINGERPRINT_ASSET;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").at(-1);
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return result.stdout;
}

export function assertReachableFromMain(sha) {
  run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
}

export function assertFingerprintsMatch(expected, actual) {
  const native = parseFingerprintHash(expected, "the latest native distribution");
  const current = parseFingerprintHash(actual, "the selected commit");
  if (native !== current) {
    throw new Error(
      `Native fingerprint mismatch. This commit changed native/SDK code and cannot ride the installed binary. Ship a new native distribution; JS-only work can OTA. expected=${native} actual=${current}`,
    );
  }
}
