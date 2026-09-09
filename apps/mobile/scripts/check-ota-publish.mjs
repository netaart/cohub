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
  IOS_NATIVE_FINGERPRINT_ASSET,
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

const fingerprintConfig = createRequire(import.meta.url)("../fingerprint.config.js");
assert.ok(
  fingerprintConfig.sourceSkips.includes("ExpoConfigVersions"),
  "Release version bumps must not change the OTA runtime fingerprint",
);
assert.ok(fingerprintConfig.sourceSkips.includes("PackageJsonAndroidAndIosScriptsIfNotContainRun"));

const parse = (file) => YAML.parse(readFileSync(file, "utf8"), { uniqueKeys: true });
const ota = parse(".github/workflows/publish-ota.yml");
assert.deepEqual(ota.on.push.branches, ["main"]);
assert.ok(Object.hasOwn(ota.on, "workflow_dispatch"));
assert.deepEqual(ota.on.workflow_dispatch.inputs.channel.options, ["staging", "production"]);
assert.equal(ota.on.workflow_dispatch.inputs.channel.default, "production");
assert.equal(ota.concurrency["cancel-in-progress"], false);
assert.equal(ota.concurrency.group, "ota-publish-${{ github.event.inputs.channel || 'production' }}");
assert.equal(ota.env.OTA_CLI_REPOSITORY, OTA_CLI_REPOSITORY);
assert.equal(ota.env.OTA_CLI_REVISION, OTA_CLI_REVISION);
assert.match(ota.jobs.prepare.if, /refs\/heads\/main/);
const publishAndroid = ota.jobs["publish-android"];
const publishIos = ota.jobs["publish-ios"];
assert.deepEqual(publishAndroid.needs, ["prepare", "android"]);
assert.deepEqual(publishIos.needs, ["prepare", "ios"]);
for (const publish of [publishAndroid, publishIos]) {
  assert.equal(Object.hasOwn(publish, "environment"), false);
  assert.match(JSON.stringify(publish.steps), /--skip-build/);
  assert.equal(JSON.stringify(publish.steps).includes("dangerously-ignore-fingerprint-check"), false);
  assert.match(JSON.stringify(publish.steps), /COHUB_OTA_RUNTIME_VERSION/);
  assert.match(JSON.stringify(publish.steps), /cohub-ota-export/);
  assert.match(JSON.stringify(publish.steps), /--export-dir/);
  const publishStep = publish.steps.find((step) => step.name === "Publish exported bundle");
  assert.ok(publishStep, "Each platform must publish through an explicit step");
  assert.match(publishStep.run, /PIPESTATUS/, "The publish step must capture the CLI exit status before deciding");
  assert.match(publishStep.run, /Fingerprint mismatch/, "A fingerprint-mismatch rejection must be reported as an expected skip, not a pipeline failure");
  assert.match(publishStep.run, /GITHUB_STEP_SUMMARY/, "A skipped publish must explain itself in the run summary");
  assert.match(publishStep.run, /::warning/, "A skipped publish must surface a warning annotation");
  assert.match(publishStep.run, /exit "\$status"/, "Any other CLI failure must still fail the job");
}
assert.match(JSON.stringify(publishAndroid.steps), /--platform android/);
assert.match(JSON.stringify(publishIos.steps), /--platform ios/);
assert.equal(JSON.stringify(publishAndroid.steps).includes("dist/android"), false);
assert.equal(JSON.stringify(publishIos.steps).includes("dist/ios"), false);
assert.match(JSON.stringify(ota.jobs.android.steps), /assets\/fingerprint/);
assert.match(JSON.stringify(ota.jobs.android.steps), /arm64-v8a/);
assert.match(JSON.stringify(ota.jobs.android.steps), /--platform android/);
assert.ok(JSON.stringify(ota.jobs.ios.steps).includes(IOS_NATIVE_FINGERPRINT_ASSET));
assert.match(JSON.stringify(ota.jobs.ios.steps), /--platform ios/);
assert.match(JSON.stringify(ota.jobs.android.steps), /cohub-ota-android-/);
assert.match(JSON.stringify(ota.jobs.ios.steps), /cohub-ota-ios-/);

const nativeCi = parse(".github/workflows/native-ci.yml");
assert.equal(Object.hasOwn(nativeCi.on, "push"), false);

const nativeRelease = parse(".github/workflows/native-release.yml");
assert.ok(nativeRelease.on.workflow_dispatch.inputs.platform.options.includes("ios"), "Native Release must allow iOS-only TestFlight builds");
const testFlightUpload = nativeRelease.jobs.ios.steps.find((step) => step.name === "Submit iOS to TestFlight");
assert.equal(testFlightUpload.with["wait-for-processing"], "true", "TestFlight uploads must confirm Apple processed the build");
assert.equal(Object.hasOwn(testFlightUpload.with, "uses-non-exempt-encryption"), false, "TestFlight uploads must not patch build metadata with a limited API key");
const appJson = JSON.parse(readFileSync("app.json", "utf8"));
assert.equal(appJson.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption, false, "iOS builds must declare export compliance in Info.plist");
assert.equal(nativeRelease.jobs.ios.env.EXPO_PUBLIC_UPDATES_URL, "${{ vars.EXPO_PUBLIC_UPDATES_URL }}");
assert.ok(JSON.stringify(nativeRelease.jobs.ios.steps).includes("EXUpdates.bundle"), "iOS builds must record the fingerprint embedded in the IPA");
assert.ok(JSON.stringify(nativeRelease.jobs.ios.steps).includes(IOS_NATIVE_FINGERPRINT_ASSET));
const iosArtifact = nativeRelease.jobs.ios.steps.find((step) => step.uses === "actions/upload-artifact@v7");
assert.ok(iosArtifact.with.path.includes(IOS_NATIVE_FINGERPRINT_ASSET));
const attachIosFingerprint = nativeRelease.jobs["attach-ios-fingerprint"];
assert.equal(attachIosFingerprint.needs, "ios");
assert.match(JSON.stringify(attachIosFingerprint.if), /inputs\.submit == true/);
assert.equal(attachIosFingerprint.permissions.contents, "write");
assert.match(JSON.stringify(attachIosFingerprint.steps), /gh release upload/);
assert.match(JSON.stringify(nativeRelease.jobs.android.steps), /native-fingerprint/);
assert.match(nativeRelease.jobs.android.steps.find((step) => step.uses === "actions/upload-artifact@v7").with.path, /native-fingerprint/);

const releasePlease = parse(".github/workflows/release-please.yml");
assert.match(JSON.stringify(releasePlease.jobs["publish-android"].steps), /cohub-android-native-fingerprint.txt/);
assert.match(JSON.stringify(releasePlease.jobs["native-release-gate"].steps), /NATIVE_RELEASE_ON_VERSION_TAG/);
const publishApkStep = releasePlease.jobs["publish-android"].steps.find((step) => step.name === "Upload formal APKs to GitHub Release");
assert.ok(publishApkStep, "The release workflow must attach formal Android APKs to the GitHub Release");
assert.match(publishApkStep.run, /find build\/release/, "Artifact downloads keep their directory layout, so the publish step must locate APKs recursively");
assert.equal(publishApkStep.run.includes("build/release/*.apk"), false, "A flat glob misses APKs nested under android/app/build/outputs");

assert.equal(OTA_CLI_REVISION.length, 40);

console.log("OTA publish workflow checks passed.");
