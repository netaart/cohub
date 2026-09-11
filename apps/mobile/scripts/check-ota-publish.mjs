import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const taggedRelease = parse(".github/workflows/native-tag.yml");
assert.deepEqual(taggedRelease.on.push.tags, ["v*"]);
assert.deepEqual(Object.keys(taggedRelease.on), ["push"], "Only a tag push starts automatic native release; release events must not duplicate it");
assert.equal(taggedRelease.concurrency["cancel-in-progress"], false);
assert.match(taggedRelease.concurrency.group, /github.ref/);
assert.match(taggedRelease.jobs.prepare.if, /!github.event.deleted/);
const prepareSteps = JSON.stringify(taggedRelease.jobs.prepare.steps);
assert.match(prepareSteps, /--is-ancestor/);
assert.match(prepareSteps, /--require-native-tag/);
assert.match(prepareSteps, /--verify-tag/);
assert.match(prepareSteps, /GITHUB_SHA/);
assert.equal(taggedRelease.jobs.prepare.permissions.contents, "write");
const validateTag = taggedRelease.jobs.prepare.steps.find((step) => step.id === "target");
for (const job of Object.values(taggedRelease.jobs)) {
  for (const step of job.steps ?? []) {
    if (step.run) execFileSync("bash", ["-n"], { input: step.run });
  }
}
// Execute the actual tag validation shell against a local Git remote, without signing or publishing.
const tagFixture = mkdtempSync(join(tmpdir(), "cohub-native-tag-"));
try {
  const remote = join(tagFixture, "remote.git");
  const checkout = join(tagFixture, "checkout");
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["clone", remote, checkout], { stdio: "ignore" });
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release-test@example.invalid");
  git("checkout", "-b", "main");
  mkdirSync(join(checkout, "scripts"));
  copyFileSync("scripts/check-release.mjs", join(checkout, "scripts/check-release.mjs"));
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ version: "1.2.3" }));
  writeFileSync(join(checkout, "app.json"), JSON.stringify({ expo: { version: "1.2.3" } }));
  git("add", ".");
  git("commit", "-m", "test: release fixture");
  const releaseSha = git("rev-parse", "HEAD");
  git("tag", "-a", "v1.2.3", "-m", "test release");
  git("tag", "v1.2.4");
  git("push", "origin", "main", "--tags");
  const runTag = (tag, sha = releaseSha) => spawnSync("bash", ["-e", "-c", validateTag.run], {
    cwd: checkout, encoding: "utf8", env: { ...process.env, RELEASE_TAG: tag, GITHUB_SHA: sha, GITHUB_OUTPUT: join(tagFixture, "output") },
  });
  let result = runTag("v1.2.3");
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(tagFixture, "output"), "utf8"), /tag=v1.2.3/);
  result = runTag("v1.2.3", git("rev-parse", "v1.2.3"));
  assert.equal(result.status, 0, result.stderr);
  for (const tag of ["v01.2.3", "v1.2.3-beta.1", "v1.2", "v1.2.3;echo unsafe"]) {
    result = runTag(tag);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /stable vX.Y.Z/);
  }
  result = runTag("v1.2.4");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Tag mismatch/);
  git("checkout", "main");
  git("commit", "--allow-empty", "-m", "test: newer main");
  const newerSha = git("rev-parse", "HEAD");
  git("push", "origin", "main");
  result = runTag("v1.2.3", newerSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Tag moved/);
  git("checkout", "-b", "unmerged");
  git("commit", "--allow-empty", "-m", "test: unmerged release");
  const unmergedSha = git("rev-parse", "HEAD");
  git("tag", "v1.2.6");
  git("push", "origin", "v1.2.6");
  result = runTag("v1.2.6", unmergedSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /reachable from origin\/main/);
} finally {
  rmSync(tagFixture, { recursive: true, force: true });
}
for (const platform of ["android", "ios"]) {
  const job = taggedRelease.jobs[platform];
  assert.equal(job.needs, "prepare");
  assert.equal(job.uses, "./.github/workflows/native-release.yml");
  assert.equal(job.with.platform, platform);
  assert.equal(job.with.release_tag, "${{ needs.prepare.outputs.tag }}");
  assert.equal(job.secrets, "inherit");
}
assert.equal(taggedRelease.jobs.android.with.profile, "distribution");
assert.equal(taggedRelease.jobs.android.with.submit, false);
assert.equal(taggedRelease.jobs.ios.with.profile, "production");
assert.equal(taggedRelease.jobs.ios.with.submit, true);
assert.equal(taggedRelease.jobs.ios.permissions.contents, "write");
assert.deepEqual(taggedRelease.jobs["publish-android"].needs, ["prepare", "android"]);
assert.match(JSON.stringify(taggedRelease.jobs["publish-android"].steps), /cohub-android-native-fingerprint.txt/);
const releasePlease = parse(".github/workflows/release-please.yml");
assert.deepEqual(Object.keys(releasePlease.jobs), ["release"], "Release Please owns metadata, not a second native build path");
const releaseStep = releasePlease.jobs.release.steps.find((step) => step.id === "release");
assert.equal(releaseStep.with.token, "${{ secrets.RELEASE_PLEASE_TOKEN }}", "GITHUB_TOKEN-created tags do not trigger downstream push workflows");
assert.match(releasePlease.jobs.release.steps[0].run, /RELEASE_PLEASE_TOKEN is required/);
const publishApkStep = taggedRelease.jobs["publish-android"].steps.find((step) => step.name === "Upload formal APKs to GitHub Release");
assert.ok(publishApkStep, "The release workflow must attach formal Android APKs to the GitHub Release");
assert.match(publishApkStep.run, /find build\/release/, "Artifact downloads keep their directory layout, so the publish step must locate APKs recursively");
assert.equal(publishApkStep.run.includes("build/release/*.apk"), false, "A flat glob misses APKs nested under android/app/build/outputs");

assert.equal(OTA_CLI_REVISION.length, 40);

console.log("OTA publish workflow checks passed.");
