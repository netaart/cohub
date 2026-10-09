/**
 * Publish one version's ABI APKs to Yaota's app-scoped catalog.
 * GitHub Release remains the archival copy; Yaota serves in-app updates.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { isAndroidUpdateAbi } from "../src/data/update-assets.ts";

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
const origin = originFromEnv();
const appId = process.env.YAOTA_APP_ID?.trim();
if (!appId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(appId)) fail("YAOTA_APP_ID is required");
const releaseTitle = process.env.RELEASE_TITLE?.trim() || "";
const releaseNotes = process.env.RELEASE_NOTES ?? "";
const releaseUrl = process.env.RELEASE_URL?.trim() || "";
const files = process.argv.slice(2);
if (files.length === 0) fail("Pass one or more cohub-vX.Y.Z-android-<abi>.apk paths");

for (const file of files) {
  const name = basename(file);
  const match = NAME.exec(name);
  if (!match || !isAndroidUpdateAbi(match[2])) fail(`Unexpected APK name: ${name}`);
  const version = match[1];
  const arch = match[2];
  const bytes = readFileSync(file);
  const size = statSync(file).size;
  if (size !== bytes.length || size <= 0) fail(`${name} has an invalid size`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const form = new FormData();
  form.set("app_id", appId);
  form.set("version", version);
  form.set("arch", arch);
  form.set("sha256", sha256);
  form.set("title", releaseTitle);
  form.set("notes", releaseNotes);
  form.set("release_url", releaseUrl);
  form.set("file", new Blob([bytes], { type: "application/vnd.android.package-archive" }), name);
  const response = await fetch(`${origin}/ota-publish/apks`, {
    method: "POST",
    headers: { "x-ota-api-key": apiKey },
    body: form,
  });
  if (!response.ok) fail(`upload failed for ${name}: HTTP ${response.status} ${await response.text()}`);
  const payload = await response.json();
  if (!payload?.apk?.downloadUrl) fail(`Yaota returned no download URL for ${name}`);
  console.log(`[publish-yaota-apks] ${name} -> ${payload.apk.downloadUrl}`);
}
