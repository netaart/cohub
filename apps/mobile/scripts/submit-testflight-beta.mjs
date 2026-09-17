/**
 * Assign the freshly uploaded TestFlight build to the configured external beta group.
 * Assigning the first build of an app version also submits it for Beta App Review;
 * Apple reviews that build asynchronously, and later builds of the same version
 * become available to external testers as soon as processing completes.
 */
import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ASC_ORIGIN = "https://api.appstoreconnect.apple.com";
const BUILD_POLL_INTERVAL_MS = 10_000;
const BUILD_POLL_ATTEMPTS = 12;

function fail(message) {
  console.error(`[submit-testflight-beta] ${message}`);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required to distribute to external TestFlight testers`);
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

// App Store Connect rejects DER-encoded ECDSA signatures; JWT ES256 needs raw 64-byte r||s.
function derSignatureToRaw(der) {
  if (der[0] !== 0x30 || der[2] !== 0x02) throw new Error("Unexpected ECDSA DER signature layout");
  const rLength = der[3];
  const sMarker = 4 + rLength;
  if (der[sMarker] !== 0x02) throw new Error("Unexpected ECDSA DER signature layout");
  // DER pads a positive integer with a leading zero when its high bit is set; strip it before right-aligning.
  let r = der.subarray(4, 4 + rLength);
  while (r.length > 32 && r[0] === 0) r = r.subarray(1);
  if (r.length > 32) throw new Error("ECDSA signature r value does not fit 32 bytes");
  let s = der.subarray(sMarker + 2, sMarker + 2 + der[sMarker + 1]);
  while (s.length > 32 && s[0] === 0) s = s.subarray(1);
  if (s.length > 32) throw new Error("ECDSA signature s value does not fit 32 bytes");
  const raw = Buffer.alloc(64);
  r.copy(raw, 32 - r.length);
  s.copy(raw, 64 - s.length);
  return raw;
}

function appStoreConnectToken({ issuerId, keyId, privateKeyPem }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: issuerId,
    iat: issuedAt,
    exp: issuedAt + 20 * 60,
    aud: "appstoreconnect-v1",
  }));
  const signingInput = `${header}.${payload}`;
  const digest = createHash("sha256").update(signingInput).digest();
  const der = sign(null, digest, createPrivateKey(privateKeyPem));
  return `${signingInput}.${derSignatureToRaw(der).toString("base64url")}`;
}

async function ascRequest(path, { method = "GET", token, body } = {}) {
  let response;
  try {
    response = await fetch(`${ASC_ORIGIN}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`App Store Connect request failed: ${error.cause?.message ?? error.message}`);
  }
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const details = Array.isArray(payload?.errors)
      ? payload.errors.map((item) => `${item.code ?? response.status}: ${item.detail ?? item.title}`).join("; ")
      : `${response.status} ${response.statusText}`;
    const error = new Error(`App Store Connect ${method} ${path} failed: ${details}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

// Mirrors scripts/print-native-identifiers.mjs: read the resolved Expo config the native build used.
async function resolveIosBuildTarget(root = process.cwd()) {
  const { stdout } = await execFileAsync(
    "npx",
    ["expo", "config", "--type", "public", "--json"],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const config = JSON.parse(stdout);
  const bundleId = config.ios?.bundleIdentifier;
  const buildNumber = config.ios?.buildNumber;
  const version = config.version;
  if (typeof bundleId !== "string" || !bundleId.trim()) {
    throw new Error("Expo config does not define ios.bundleIdentifier");
  }
  if (typeof buildNumber !== "string" || !/^\d+$/.test(buildNumber)) {
    throw new Error(`Expo config does not resolve a numeric ios.buildNumber, received: ${buildNumber ?? "<missing>"}`);
  }
  return { bundleId, buildNumber, version };
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function main() {
  const issuerId = requireEnv("APPSTORE_ISSUER_ID");
  const keyId = requireEnv("APPSTORE_API_KEY_ID");
  const privateKeyPem = requireEnv("APPSTORE_API_PRIVATE_KEY");
  const groupName = requireEnv("TESTFLIGHT_EXTERNAL_BETA_GROUP");

  const { bundleId, buildNumber, version } = await resolveIosBuildTarget();
  console.log(`Looking up build ${buildNumber} of ${bundleId} (app version ${version}).`);
  const token = appStoreConnectToken({ issuerId, keyId, privateKeyPem });

  const appsPayload = await ascRequest(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`, { token });
  const apps = appsPayload?.data ?? [];
  if (apps.length !== 1) {
    fail(`Expected one App Store Connect app for bundle id ${bundleId}, found ${apps.length}.`);
  }
  const appId = apps[0].id;

  let build = null;
  for (let attempt = 1; attempt <= BUILD_POLL_ATTEMPTS; attempt += 1) {
    const buildsPayload = await ascRequest(
      `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}&sort=-uploadedDate&page[limit]=10`,
      { token },
    );
    const candidates = buildsPayload?.data ?? [];
    build = candidates[0] ?? null;
    if (build) {
      const state = build.attributes?.processingState;
      if (state === "VALID") break;
      if (state === "FAILED") fail(`Build ${buildNumber} failed App Store Connect processing and cannot be distributed.`);
      console.log(`Build ${buildNumber} is ${state}; waiting ${BUILD_POLL_INTERVAL_MS / 1000}s (${attempt}/${BUILD_POLL_ATTEMPTS}).`);
    } else {
      console.log(`Build ${buildNumber} is not visible yet; waiting ${BUILD_POLL_INTERVAL_MS / 1000}s (${attempt}/${BUILD_POLL_ATTEMPTS}).`);
    }
    await sleep(BUILD_POLL_INTERVAL_MS);
  }
  if (!build) {
    fail(`Build ${buildNumber} did not finish processing within the wait window. Confirm the TestFlight upload step succeeded and check App Store Connect.`);
  }
  const buildId = build.id;

  const groupsPayload = await ascRequest(`/v1/betaGroups?filter[app]=${appId}&page[limit]=200`, { token });
  const groups = groupsPayload?.data ?? [];
  const group = groups.find((candidate) => candidate.attributes?.name === groupName);
  if (!group) {
    const names = groups.map((candidate) => candidate.attributes?.name).join(", ");
    fail(`No TestFlight group named "${groupName}" exists for this app. Existing groups: ${names || "<none>"}.`);
  }
  if (group.attributes?.isInternalGroup !== false) {
    fail(`Group "${groupName}" is an internal group; internal testers receive builds automatically and are not distributed through this step.`);
  }

  const memberships = await ascRequest(`/v1/builds/${buildId}/betaGroups?page[limit]=200`, { token });
  if ((memberships?.data ?? []).some((candidate) => candidate.id === group.id)) {
    console.log(`Build ${buildNumber} is already assigned to external group "${groupName}".`);
  } else {
    await ascRequest(`/v1/builds/${buildId}/relationships/betaGroups`, {
      method: "POST",
      token,
      body: { data: [{ type: "betaGroups", id: group.id }] },
    }).catch((error) => {
      // Reruns and race with the web UI surface as a conflict; membership already means done.
      if (error.status === 409) {
        console.log(`App Store Connect reports build ${buildNumber} is already in the group.`);
        return null;
      }
      throw error;
    });
    console.log(`Build ${buildNumber} is assigned to external group "${groupName}".`);
  }

  const betaDetail = await ascRequest(`/v1/builds/${buildId}/buildBetaDetail`, { token });
  const externalState = betaDetail?.data?.attributes?.externalBuildState ?? "unknown";
  console.log(`External distribution state: ${externalState}.`);
  if (externalState !== "READY_FOR_BETA_TESTING") {
    console.log("The first build of each app version waits for Beta App Review before external testers are notified; later builds of the same version are available immediately.");
  }
}

try {
  await main();
} catch (error) {
  fail(error.message);
}
