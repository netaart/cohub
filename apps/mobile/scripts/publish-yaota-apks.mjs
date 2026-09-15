/**
 * Upload signed ABI APKs to Yaota after they are attached to the GitHub Release.
 * In-app Android updates download from this origin so devices that cannot reach
 * GitHub still receive the package. GitHub remains the archival copy.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { androidUpdateApkName, androidUpdateApkUrl, isAndroidUpdateAbi } from "../src/data/update-assets.ts";

const NAME = /^cohub-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-android-(arm64-v8a|armeabi-v7a|x86|x86_64)\.apk$/;

function fail(message) {
  console.error(`[publish-yaota-apks] ${message}`);
  process.exit(1);
}

function originFromEnv() {
  const value = process.env.OTA_SERVER?.trim();
  if (!value) fail("OTA_SERVER must be the Yaota HTTPS origin, without /manifest");
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("OTA_SERVER must be an absolute HTTPS origin");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) fail("OTA_SERVER must be HTTPS without credentials");
  if (url.pathname !== "/" && url.pathname !== "") fail("OTA_SERVER must be an origin without a path");
  return url.origin;
}

const apiKey = process.env.OTA_API_KEY?.trim();
if (!apiKey) fail("OTA_API_KEY is required to publish APKs");
const releaseTitle = process.env.RELEASE_TITLE?.trim() || null;
const releaseNotes = process.env.RELEASE_NOTES ?? null;
const releaseUrl = process.env.RELEASE_URL?.trim() || null;
const origin = originFromEnv();
const files = process.argv.slice(2);
if (files.length === 0) fail("Pass one or more cohub-vX.Y.Z-android-<abi>.apk paths");

for (const file of files) {
  const name = basename(file);
  const match = NAME.exec(name);
  if (!match || !isAndroidUpdateAbi(match[2])) fail(`Unexpected APK name: ${name}`);
  const version = match[1];
  const arch = match[2];
  const expectedName = androidUpdateApkName(version, arch);
  if (name !== expectedName) fail(`APK name ${name} does not match ${expectedName}`);
  const bytes = readFileSync(file);
  const size = statSync(file).size;
  if (size !== bytes.length || size <= 0) fail(`${name} has an invalid size`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const presign = await fetch(`${origin}/api/apks/presign`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ota-api-key": apiKey },
    body: JSON.stringify({ version, arch, size, sha256, title: releaseTitle, notes: releaseNotes, releaseUrl }),
  });
  if (!presign.ok) fail(`presign failed for ${name}: HTTP ${presign.status} ${await presign.text()}`);
  const payload = await presign.json();
  const publicUrl = androidUpdateApkUrl(origin, version, arch);
  if (payload?.publicUrl !== publicUrl) fail(`Yaota returned ${payload?.publicUrl}, expected ${publicUrl}`);
  const uploadUrl = typeof payload.uploadUrl === "string" ? payload.uploadUrl : "";
  if (!uploadUrl.startsWith(`${origin}/api/apks/upload/`)) fail(`Unexpected upload URL for ${name}`);
  const uploaded = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "application/vnd.android.package-archive", "x-ota-api-key": apiKey },
    body: bytes,
  });
  if (!uploaded.ok) fail(`upload failed for ${name}: HTTP ${uploaded.status} ${await uploaded.text()}`);
  console.log(`[publish-yaota-apks] ${name} -> ${publicUrl}`);
}
