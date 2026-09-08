import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  OTA_CLI_REPOSITORY,
  OTA_CLI_REVISION,
  parseCommitSha,
  parseChannel,
  parseHttpsOrigin,
  parseFingerprintHash,
  fingerprintFromCliJson,
  fingerprintAssetName,
  NATIVE_FINGERPRINT_ASSET,
  assertFingerprintsMatch,
} from "./ota-publish.mjs";

const YAML = createRequire(import.meta.url)("yaml");

assert.equal(parseCommitSha("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
assert.throws(() => parseCommitSha("abc"), /40-character/);
assert.equal(parseChannel("staging"), "staging");
assert.equal(parseChannel("production"), "production");
assert.throws(() => parseChannel("dev"), /staging/);
assert.equal(parseHttpsOrigin("https://expo-ota.talesofai.com", "OTA_SERVER"), "https://expo-ota.talesofai.com");
assert.throws(() => parseHttpsOrigin("https://expo-ota.talesofai.com/manifest", "OTA_SERVER"), /origin/);
assert.equal(fingerprintFromCliJson(JSON.stringify({ hash: "A".repeat(40) }), "test"), "a".repeat(40));
assert.equal(fingerprintAssetName("1.6.0"), NATIVE_FINGERPRINT_ASSET);
assert.doesNotThrow(() => assertFingerprintsMatch("b".repeat(40), "B".repeat(40)));
assert.throws(() => assertFingerprintsMatch("a".repeat(40), "b".repeat(40)), /mismatch/);
assert.throws(() => parseFingerprintHash("nope", "test"), /Invalid native fingerprint/);

const parse = (file) => YAML.parse(readFileSync(file, "utf8"), { uniqueKeys: true });
const ota = parse(".github/workflows/publish-ota.yml");
assert.equal(Object.hasOwn(ota.on, "push"), false);
assert.ok(Object.hasOwn(ota.on, "workflow_dispatch"));
assert.deepEqual(ota.on.workflow_dispatch.inputs.channel.options, ["staging", "production"]);
assert.equal(ota.on.workflow_dispatch.inputs.channel.default, "staging");
assert.equal(ota.concurrency["cancel-in-progress"], false);
assert.equal(ota.concurrency.group, "ota-publish-${{ inputs.channel }}");
assert.equal(ota.env.OTA_CLI_REPOSITORY, OTA_CLI_REPOSITORY);
assert.equal(ota.env.OTA_CLI_REVISION, OTA_CLI_REVISION);
assert.match(ota.jobs.prepare.if, /refs\/heads\/main/);
assert.equal(ota.jobs.publish.environment.name, "ota-${{ inputs.channel }}");
assert.match(JSON.stringify(ota.jobs.publish.steps), /--skip-build/);
assert.equal(JSON.stringify(ota.jobs.publish.steps).includes("dangerously-ignore-fingerprint-check"), false);
assert.match(JSON.stringify(ota.jobs.publish.steps), /--platform android/);
assert.match(JSON.stringify(ota.jobs.publish.steps), /COHUB_OTA_RUNTIME_VERSION/);
assert.match(JSON.stringify(ota.jobs.publish.steps), /cohub-ota-export/);
assert.match(JSON.stringify(ota.jobs.publish.steps), /--export-dir/);
assert.equal(JSON.stringify(ota.jobs.publish.steps).includes("dist/android"), false);
assert.match(JSON.stringify(ota.jobs.prepare.steps), /assets\/fingerprint/);
assert.match(JSON.stringify(ota.jobs.prepare.steps), /arm64-v8a/);
assert.match(JSON.stringify(ota.jobs.prepare.steps), /--platform android/);

const nativeCi = parse(".github/workflows/native-ci.yml");
assert.equal(Object.hasOwn(nativeCi.on, "push"), false);

const nativeRelease = parse(".github/workflows/native-release.yml");
assert.match(JSON.stringify(nativeRelease.jobs.android.steps), /native-fingerprint/);
assert.match(nativeRelease.jobs.android.steps.find((step) => step.uses === "actions/upload-artifact@v7").with.path, /native-fingerprint/);

const releasePlease = parse(".github/workflows/release-please.yml");
assert.match(JSON.stringify(releasePlease.jobs["publish-android"].steps), /cohub-android-native-fingerprint.txt/);
assert.match(JSON.stringify(releasePlease.jobs["native-release-gate"].steps), /NATIVE_RELEASE_ON_VERSION_TAG/);

assert.equal(OTA_CLI_REVISION.length, 40);

console.log("OTA publish workflow checks passed.");
