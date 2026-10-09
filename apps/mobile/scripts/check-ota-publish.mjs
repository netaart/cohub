import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
  isTransientOtaFailure,
  OTA_PUBLISH_ATTEMPTS,
} from "./ota-publish.mjs";
import { parseAppTag, parseCommits, renderReleaseNotes } from "./release-notes.mjs";

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

// The 2026-09-30 Android publish failed on this response timeout and succeeded on a manual rerun.
const headersTimeoutLog = "node:internal/modules/run_main:107\n[TypeError: fetch failed] {\n  [cause]: HeadersTimeoutError: Headers Timeout Error\n    code: 'UND_ERR_HEADERS_TIMEOUT'\n  }\n}";
assert.equal(isTransientOtaFailure(headersTimeoutLog), true);
assert.equal(isTransientOtaFailure("Error: read ECONNRESET"), true);
assert.equal(isTransientOtaFailure("Error: OTA 502: Bad Gateway"), true);
assert.equal(isTransientOtaFailure("Error: OTA 429: slow down"), true);
assert.equal(isTransientOtaFailure("Error: OTA 401: invalid api key"), false, "credential failures do not retry");
assert.equal(isTransientOtaFailure("Error: OTA 409: Fingerprint mismatch"), false);
assert.equal(isTransientOtaFailure("Error: Export metadata is missing the selected platform"), false, "local input errors do not retry");
assert.equal(isTransientOtaFailure(""), false);

const fingerprintConfig = createRequire(import.meta.url)("../fingerprint.config.js");
assert.ok(
  fingerprintConfig.sourceSkips.includes("ExpoConfigVersions"),
  "Release version bumps must not change the OTA runtime fingerprint",
);
assert.ok(fingerprintConfig.sourceSkips.includes("PackageJsonAndroidAndIosScriptsIfNotContainRun"));

const parse = (file) => YAML.parse(readFileSync(file, "utf8"), { uniqueKeys: true });
// The app has one workflow in the monorepo root, and every step runs from apps/mobile.
const mobile = parse(fileURLToPath(new URL("../../../.github/workflows/mobile-ci.yml", import.meta.url)));
assert.equal(mobile.name, "Mobile CI");
assert.equal(mobile.defaults?.run?.["working-directory"], "apps/mobile", "Mobile CI must run its steps from apps/mobile");
const appPaths = ["apps/mobile/**", ".github/workflows/mobile-ci.yml"];
assert.deepEqual(mobile.on.pull_request.paths, appPaths, "Pull requests run Mobile CI only for app changes");
assert.deepEqual(mobile.on.push.paths, appPaths, "Main pushes run Mobile CI only for app changes");
assert.deepEqual(mobile.on.push.branches, ["main"]);
assert.deepEqual(mobile.on.push.tags, ["cohub-mobile-v*"], "The monorepo's vX.Y.Z tags release the services, not the app");
assert.equal(Object.hasOwn(mobile.on, "release"), false, "Only a tag push starts automatic native release; release events must not duplicate it");
const inputs = mobile.on.workflow_dispatch.inputs;
assert.deepEqual(inputs.task.options, ["ci", "native-debug", "native-release", "ota"]);
assert.ok(Object.keys(inputs).length <= 10, "workflow_dispatch accepts at most 10 inputs");
assert.deepEqual(inputs.channel.options, ["staging", "production"]);
assert.equal(inputs.channel.default, "production");
assert.ok(inputs.platform.options.includes("ios"), "Manual native releases must allow iOS-only TestFlight builds");
assert.equal(mobile.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}", "Only pull requests cancel superseded runs");
assert.match(mobile.concurrency.group, /format\('ota-\{0\}', inputs\.channel \|\| 'production'\)/, "Main pushes and OTA runs queue per channel so an older OTA never overtakes a newer one");
assert.equal(mobile.env.OTA_CLI_REPOSITORY, OTA_CLI_REPOSITORY);
assert.equal(mobile.env.OTA_CLI_REVISION, OTA_CLI_REVISION);
const jobs = mobile.jobs;
for (const [id, job] of Object.entries(jobs)) {
  assert.equal(Object.hasOwn(job, "uses"), false, `${id} must not hand the monorepo's secrets to a reusable workflow`);
  for (const step of job.steps ?? []) {
    if (step.run) execFileSync("bash", ["-n"], { input: step.run });
  }
}
for (const id of ["quality", "bundle"]) {
  assert.match(jobs[id].if, /github\.event_name == 'pull_request'/, `${id} runs for pull requests`);
  assert.match(jobs[id].if, /github\.ref_type == 'branch'/, `${id} does not run for release tags`);
}
assert.match(jobs["ota-prepare"].if, /refs\/heads\/main/);
assert.equal(Object.hasOwn(jobs["ota-prepare"], "needs"), false, "OTA runs its own checks on the published commit");
const publishAndroid = jobs["ota-publish-android"];
const publishIos = jobs["ota-publish-ios"];
assert.deepEqual(publishAndroid.needs, ["ota-prepare", "ota-android"]);
assert.deepEqual(publishIos.needs, ["ota-prepare", "ota-ios"]);
for (const publish of [publishAndroid, publishIos]) {
  assert.equal(Object.hasOwn(publish, "environment"), false);
  assert.equal(JSON.stringify(publish.steps).includes("apps/easc/bin/easc.js"), false);
  assert.match(JSON.stringify(publish.steps), /scripts\/publish\.ts/);
  assert.equal(publish.steps.find((step) => step.name === "Set up Node").with["node-version"], 24);
  assert.equal(JSON.stringify(publish.steps).includes("dangerously-ignore-fingerprint-check"), false);
  assert.match(JSON.stringify(publish.steps), /COHUB_OTA_RUNTIME_VERSION/);
  assert.match(JSON.stringify(publish.steps), /cohub-ota-export/);
  assert.match(JSON.stringify(publish.steps), /--export-dir/);
  const publishStep = publish.steps.find((step) => step.name === "Publish exported bundle");
  assert.ok(publishStep, "Each platform must publish through an explicit step");
  assert.match(publishStep.run, /--delta-bases 3/);
  assert.match(publishStep.run, /--fingerprint "\$SOURCE_FINGERPRINT"/);
  assert.match(publishStep.run, /env -u COHUB_OTA_RUNTIME_VERSION npx @expo\/fingerprint/);
  assert.match(publishStep.run, /--runtime "\$runtime"/);
  assert.match(publishStep.run, /--commit "\$SOURCE_COMMIT"/);
  assert.match(publishStep.run, /expo config --type public --json/);
  assert.match(publishStep.run, /PIPESTATUS/, "The publish step must capture the CLI exit status before deciding");
  assert.match(publishStep.run, /Fingerprint mismatch/, "A fingerprint-mismatch rejection must be reported as an expected skip, not a pipeline failure");
  assert.match(publishStep.run, /GITHUB_STEP_SUMMARY/, "A skipped publish must explain itself in the run summary");
  assert.match(publishStep.run, /::warning/, "A skipped publish must surface a warning annotation");
  assert.match(publishStep.run, /exit "\$status"/, "Any other CLI failure must still fail the job");
  assert.match(publishStep.run, /isTransientOtaFailure/, "Only transient failures may retry");
  assert.ok(publish["timeout-minutes"] >= OTA_PUBLISH_ATTEMPTS * 5 + 5, "The job must outlast every attempt's 5-minute response timeout");
  execFileSync("bash", ["-n"], { input: publishStep.run });
}

// Run the real publish step against a stub CLI to check the retry decisions.
for (const [platform, publish] of [["android", publishAndroid], ["ios", publishIos]]) {
  const script = publish.steps.find((step) => step.name === "Publish exported bundle").run;
  const runPublish = (outcomes) => {
    const temp = mkdtempSync(join(tmpdir(), "cohub-ota-retry-"));
    try {
      mkdirSync(join(temp, "bin"));
      mkdirSync(join(temp, "ota-cli/scripts"), { recursive: true });
      mkdirSync(join(temp, "export"));
      writeFileSync(join(temp, "bin/npx"), `#!/usr/bin/env bash\ncase "$*" in *fingerprint*) echo '{"hash":"${"a".repeat(40)}"}' ;; *) echo '{}' ;; esac\n`, { mode: 0o755 });
      writeFileSync(join(temp, "bin/sleep"), "#!/usr/bin/env bash\necho \"slept $1\" >> \"$RUNNER_TEMP/sleeps\"\n", { mode: 0o755 });
      // Each call consumes the next scripted outcome: "ok" or a log line to fail with.
      writeFileSync(join(temp, "ota-cli/scripts/publish.ts"), `
        const fs = process.getBuiltinModule("node:fs");
        const counter = process.env.RUNNER_TEMP + "/calls";
        const call = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
        fs.writeFileSync(counter, String(call + 1));
        const outcome = ${JSON.stringify(outcomes)}[call];
        if (outcome === "ok") { console.log('{"status":"Live"}'); process.exit(0); }
        console.error(outcome); process.exit(1);
      `);
      const result = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(temp, "bin")}:${process.env.PATH}`,
          RUNNER_TEMP: temp,
          GITHUB_STEP_SUMMARY: join(temp, "summary"),
          OTA_SERVER: "https://ota.example.com",
          OTA_API_KEY: "test-key",
          CHANNEL: "production",
          OTA_PLATFORM: platform,
          SOURCE_COMMIT: "c".repeat(40),
          COHUB_OTA_RUNTIME_VERSION: "b".repeat(40),
          OTA_EXPORT_DIR: join(temp, "export"),
        },
      });
      const read = (name) => { try { return readFileSync(join(temp, name), "utf8"); } catch { return ""; } };
      return { status: result.status, calls: Number(read("calls")), sleeps: read("sleeps").trim().split("\n").filter(Boolean), summary: read("summary"), output: result.stdout + result.stderr };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  };
  const recovered = runPublish([headersTimeoutLog, "Error: OTA 503: unavailable", "ok"]);
  assert.equal(recovered.status, 0, recovered.output);
  assert.equal(recovered.calls, 3, `${platform}: transient failures retry until success`);
  assert.deepEqual(recovered.sleeps, ["slept 30", "slept 60"], `${platform}: retries back off`);
  const exhausted = runPublish([headersTimeoutLog, headersTimeoutLog, headersTimeoutLog, "ok"]);
  assert.notEqual(exhausted.status, 0, `${platform}: the job fails once attempts run out`);
  assert.equal(exhausted.calls, OTA_PUBLISH_ATTEMPTS);
  const rejected = runPublish(["Error: OTA 401: invalid api key", "ok"]);
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.calls, 1, `${platform}: permanent failures do not retry`);
  const mismatch = runPublish(["Error: OTA 409: Fingerprint mismatch", "ok"]);
  assert.equal(mismatch.status, 0, `${platform}: a fingerprint mismatch stays an explained skip`);
  assert.equal(mismatch.calls, 1);
  assert.match(mismatch.summary, /Run \*\*Mobile CI\*\* with `task=native-release`/, `${platform}: the skip summary names the release task literally`);
}
assert.match(JSON.stringify(publishAndroid.steps), /--platform android/);
assert.match(JSON.stringify(publishIos.steps), /--platform ios/);
assert.equal(JSON.stringify(publishAndroid.steps).includes("dist/android"), false);
assert.equal(JSON.stringify(publishIos.steps).includes("dist/ios"), false);
assert.match(JSON.stringify(jobs["ota-android"].steps), /assets\/fingerprint/);
assert.match(JSON.stringify(jobs["ota-android"].steps), /arm64-v8a/);
assert.match(JSON.stringify(jobs["ota-android"].steps), /--platform android/);
assert.ok(JSON.stringify(jobs["ota-ios"].steps).includes(IOS_NATIVE_FINGERPRINT_ASSET));
assert.match(JSON.stringify(jobs["ota-ios"].steps), /--platform ios/);
assert.match(JSON.stringify(jobs["ota-android"].steps), /cohub-ota-android-/);
assert.match(JSON.stringify(jobs["ota-ios"].steps), /cohub-ota-ios-/);

for (const id of ["debug-android", "debug-ios"]) {
  assert.equal(jobs[id].if, "inputs.task == 'native-debug'", "Native debug builds run only on request, never for pull requests");
}

// Gradle caches must key on the committed dependency set. setup-java hashes the
// prebuild-generated android/*.gradle files and offers no older-entry fallback, so its
// cache goes cold on every app version or config bump (~4 minutes of re-downloads).
for (const id of ["debug-android", "release-android"]) {
  const javaStep = jobs[id].steps.find((step) => step.uses === "actions/setup-java@v6");
  assert.ok(javaStep, `${id} must set up Java for the Android build`);
  assert.equal(javaStep.with.cache, undefined, `${id} must cache Gradle explicitly instead of through setup-java`);
  const gradleCache = jobs[id].steps.find((step) => String(step.uses).startsWith("actions/cache@"));
  assert.ok(gradleCache, `${id} must restore the Gradle caches`);
  assert.match(gradleCache.with.path, /~\/\.gradle\/caches/, `${id} must cache the Gradle dependency caches`);
  assert.match(gradleCache.with.path, /~\/\.gradle\/wrapper/, `${id} must cache the Gradle wrapper distributions`);
  assert.match(gradleCache.with.key, /hashFiles\('apps\/mobile\/package-lock\.json'\)/, `${id} must key the Gradle cache on the committed dependency set`);
  assert.match(gradleCache.with["restore-keys"], /gradle-\$\{\{ runner\.os \}\}-/, `${id} must fall back to the previous Gradle cache so dependency updates stay warm`);
}

assert.deepEqual(jobs.bundle.strategy.matrix.platform, ["android", "ios"], "CI must still export both platform bundles");
assert.equal(Object.hasOwn(jobs.bundle, "needs"), false, "CI exports must not serialize behind Quality: they are independent and serializing them doubled every run's wall clock");

const releaseIos = jobs["release-ios"];
const testFlightUpload = releaseIos.steps.find((step) => step.name === "Submit iOS to TestFlight");
assert.equal(testFlightUpload.with["wait-for-processing"], "true", "TestFlight uploads must confirm Apple processed the build");
assert.equal(Object.hasOwn(testFlightUpload.with, "uses-non-exempt-encryption"), false, "TestFlight uploads must not patch build metadata with a limited API key");
const appJson = JSON.parse(readFileSync("app.json", "utf8"));
assert.equal(appJson.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption, false, "iOS builds must declare export compliance in Info.plist");
assert.equal(releaseIos.env.EXPO_PUBLIC_UPDATES_URL, "${{ vars.MOBILE_EXPO_PUBLIC_UPDATES_URL }}");
assert.ok(JSON.stringify(releaseIos.steps).includes("EXUpdates.bundle"), "iOS builds must record the fingerprint embedded in the IPA");
assert.ok(JSON.stringify(releaseIos.steps).includes(IOS_NATIVE_FINGERPRINT_ASSET));
const iosArtifact = releaseIos.steps.find((step) => step.uses === "actions/upload-artifact@v7");
assert.ok(iosArtifact.with.path.includes(IOS_NATIVE_FINGERPRINT_ASSET));
const attachIosFingerprint = jobs["release-attach-ios"];
assert.deepEqual(attachIosFingerprint.needs, ["release-plan", "release-ios"]);
assert.match(attachIosFingerprint.if, /ios_submit == 'true'/, "Only a submitted TestFlight build may claim the release's iOS runtime");
assert.equal(attachIosFingerprint.permissions.contents, "write");
assert.match(JSON.stringify(attachIosFingerprint.steps), /gh release upload/);
assert.match(JSON.stringify(jobs["release-android"].steps), /native-fingerprint/);
assert.match(jobs["release-android"].steps.find((step) => step.uses === "actions/upload-artifact@v7").with.path, /native-fingerprint/);

const publishRelease = jobs["release-publish-android"];
assert.match(JSON.stringify(publishRelease.steps), /gh release upload/, "GitHub Release must still attach APKs");
assert.match(JSON.stringify(publishRelease.steps), /publish-yaota-apks/, "A tag release must publish the same APKs to Yaota");
assert.match(JSON.stringify(publishRelease.steps), /OTA_SERVER/);
assert.deepEqual(publishRelease.needs, ["release-plan", "release-android"]);
assert.match(publishRelease.if, /outputs\.publish == 'true'/, "Only a tag push attaches APKs and publishes them to Yaota");
assert.match(JSON.stringify(publishRelease.steps), /cohub-android-native-fingerprint.txt/);

const plan = jobs["release-plan"];
assert.match(plan.if, /!github\.event\.deleted/);
assert.match(plan.if, /inputs\.task == 'native-release'/);
const prepareSteps = JSON.stringify(plan.steps);
assert.match(prepareSteps, /--is-ancestor/);
assert.match(prepareSteps, /--require-native-tag/);
assert.match(prepareSteps, /--verify-tag/);
assert.match(prepareSteps, /--latest=false/, "An app release must not become the repository's Latest release");
assert.match(prepareSteps, /scripts\/release-notes\.mjs/);
assert.equal(prepareSteps.includes("--generate-notes"), false, "Generated notes would list every monorepo PR");
assert.match(prepareSteps, /GITHUB_SHA/);
assert.equal(plan.permissions.contents, "write");
assert.match(plan.steps.find((step) => step.name === "Ensure GitHub Release exists").if, /publish == 'true'/, "A manual native release must not create a GitHub Release");
for (const platform of ["android", "ios"]) {
  assert.equal(jobs[`release-${platform}`].needs, "release-plan");
  assert.equal(jobs[`release-${platform}`].if, `needs.release-plan.outputs.${platform} == 'true'`);
}
const validateTag = plan.steps.find((step) => step.id === "target");
// Execute the actual release plan shell against a local Git remote, without signing or publishing.
const tagFixture = mkdtempSync(join(tmpdir(), "cohub-native-tag-"));
try {
  const remote = join(tagFixture, "remote.git");
  const checkout = join(tagFixture, "checkout");
  const output = join(tagFixture, "output");
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
  git("tag", "-a", "cohub-mobile-v1.2.3", "-m", "test release");
  git("tag", "cohub-mobile-v1.2.4");
  git("push", "origin", "main", "--tags");
  const runPlan = (env) => {
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-e", "-c", validateTag.run], {
      cwd: checkout, encoding: "utf8", env: { ...process.env, MODE: "tag", GITHUB_SHA: releaseSha, GITHUB_OUTPUT: output, ...env },
    });
    const outputs = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("=")));
    return { ...result, outputs };
  };
  const runTag = (tag, sha = releaseSha) => runPlan({ RELEASE_TAG: tag, GITHUB_SHA: sha });
  let result = runTag("cohub-mobile-v1.2.3");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.outputs, {
    tag: "cohub-mobile-v1.2.3", sha: releaseSha, publish: "true",
    android: "true", android_profile: "distribution", android_submit: "false", android_track: "internal",
    ios: "true", ios_submit: "true",
  }, "A tag push publishes signed APKs and submits iOS to TestFlight");
  result = runTag("cohub-mobile-v1.2.3", git("rev-parse", "cohub-mobile-v1.2.3"));
  assert.equal(result.status, 0, result.stderr);
  for (const tag of ["v1.2.3", "cohub-mobile-v01.2.3", "cohub-mobile-v1.2.3-beta.1", "cohub-mobile-v1.2", "cohub-mobile-v1.2.3;echo unsafe"]) {
    result = runTag(tag);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /stable cohub-mobile-vX.Y.Z/);
  }
  result = runTag("cohub-mobile-v1.2.4");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Tag mismatch/);

  const manual = (env) => runPlan({ MODE: "manual", RELEASE_TAG: "cohub-mobile-v1.2.3", PLATFORM: "android", PROFILE: "distribution", SUBMIT: "false", ANDROID_TRACK: "internal", ...env });
  result = manual({});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.outputs.publish, "false", "A manual run never publishes to the GitHub Release or Yaota");
  assert.equal(result.outputs.android, "true");
  assert.equal(result.outputs.ios, "false");
  result = manual({ PLATFORM: "all", PROFILE: "production", SUBMIT: "true", ANDROID_TRACK: "production" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [result.outputs.android, result.outputs.android_profile, result.outputs.android_submit, result.outputs.android_track, result.outputs.ios, result.outputs.ios_submit],
    ["true", "production", "true", "production", "true", "true"],
  );
  result = manual({ PLATFORM: "ios" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /only supports platform=android/);
  result = manual({ SUBMIT: "true" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /cannot submit to a store/);
  result = manual({ PLATFORM: "desktop" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Unsupported platform/);
  result = manual({ RELEASE_TAG: "" });
  assert.notEqual(result.status, 0, "A manual native release requires a release tag");
  assert.match(result.stdout, /stable cohub-mobile-vX.Y.Z/);

  git("checkout", "main");
  git("commit", "--allow-empty", "-m", "test: newer main");
  const newerSha = git("rev-parse", "HEAD");
  git("push", "origin", "main");
  result = runTag("cohub-mobile-v1.2.3", newerSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Tag moved/);
  result = manual({ GITHUB_SHA: newerSha });
  assert.equal(result.status, 0, "A manual run on main builds an existing tag");
  git("checkout", "-b", "unmerged");
  git("commit", "--allow-empty", "-m", "test: unmerged release");
  const unmergedSha = git("rev-parse", "HEAD");
  git("tag", "cohub-mobile-v1.2.6");
  git("push", "origin", "cohub-mobile-v1.2.6");
  result = runTag("cohub-mobile-v1.2.6", unmergedSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /reachable from origin\/main/);
  result = manual({ RELEASE_TAG: "cohub-mobile-v1.2.6" });
  assert.notEqual(result.status, 0, "Signing credentials are used only for tags on main");
  assert.match(result.stdout, /reachable from origin\/main/);
} finally {
  rmSync(tagFixture, { recursive: true, force: true });
}
const publishApkStep = publishRelease.steps.find((step) => step.name === "Upload formal APKs to GitHub Release");
assert.ok(publishApkStep, "The release workflow must attach formal Android APKs to the GitHub Release");
assert.match(publishApkStep.run, /find build\/release/, "Artifact downloads keep their directory layout, so the publish step must locate APKs recursively");
assert.equal(publishApkStep.run.includes("build/release/*.apk"), false, "A flat glob misses APKs nested under android/app/build/outputs");
assert.match(publishApkStep.run, /cohub-\$\{RELEASE_TAG#cohub-mobile-\}-android-/, "APK names stay cohub-vX.Y.Z for Yaota and the landing page");
for (const platform of ["android", "ios"]) {
  assert.match(JSON.stringify(jobs[`ota-${platform}`].steps), /matching-refs\/tags\/cohub-mobile-v/, `${platform} OTA must resolve its runtime from app releases only`);
}

// Release notes replace Release Please and cover app commits only.
assert.deepEqual(parseAppTag("cohub-mobile-v2.3.0"), { tag: "cohub-mobile-v2.3.0", version: "2.3.0" });
for (const tag of ["v2.3.0", "cohub-mobile-v2.3", "cohub-mobile-v02.3.0"]) assert.throws(() => parseAppTag(tag), /cohub-mobile-vX\.Y\.Z/);
const record = (sha, subject, body = "") => `${sha}\x1f${subject}\x1f${body}\x1e\n`;
const notesCommits = parseCommits([
  record("a".repeat(40), "fix(composer): keep the caret in view"),
  record("b".repeat(40), "feat(mobile): add the Spaces tab"),
  record("c".repeat(40), "Merge branch 'main'"),
  record("d".repeat(40), "chore(mobile): bump expo"),
  record("e".repeat(40), "feat(chat)!: change the turn layout"),
  record("f".repeat(40), "fix(auth): rotate tokens", "BREAKING CHANGE: sign in again."),
].join(""));
assert.equal(notesCommits.length, 5, "Non-conventional subjects are left out");
const notes = renderReleaseNotes({ repository: "netaart/cohub", previousTag: "cohub-mobile-v2.2.14", tag: "cohub-mobile-v2.2.15", date: "2026-10-09", commits: notesCommits });
assert.ok(notes.startsWith("## [2.2.15](https://github.com/netaart/cohub/compare/cohub-mobile-v2.2.14...cohub-mobile-v2.2.15) (2026-10-09)\n"));
assert.ok(notes.indexOf("### ⚠ BREAKING CHANGES") < notes.indexOf("### Features"));
assert.ok(notes.indexOf("### Features") < notes.indexOf("### Fixes"));
assert.match(notes, /\* add the Spaces tab \(\[bbbbbbb\]\(https:\/\/github\.com\/netaart\/cohub\/commit\/b{40}\)\)/, "The app scope adds nothing inside app notes");
const features = notes.slice(notes.indexOf("### Features"), notes.indexOf("### Fixes"));
assert.ok(features.indexOf("* add the Spaces tab") < features.indexOf("* **chat:** change the turn layout"), "Entries sort by scope like Release Please");
assert.match(notes.slice(0, notes.indexOf("### Features")), /\*\*auth:\*\* rotate tokens/, "A BREAKING CHANGE footer marks the commit as breaking");
assert.equal(notes.includes("bump expo"), false, "chore commits stay out of user-facing notes");
assert.equal(notes.includes("Merge branch"), false);
// Run the CLI on a repository where service commits and tags interleave with app ones.
const notesFixture = mkdtempSync(join(tmpdir(), "cohub-release-notes-"));
try {
  const git = (...args) => execFileSync("git", args, { cwd: notesFixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (path, subject) => {
    mkdirSync(join(notesFixture, path, ".."), { recursive: true });
    writeFileSync(join(notesFixture, path), subject);
    git("add", ".");
    git("commit", "-m", subject);
  };
  git("init", "-b", "main");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release-test@example.invalid");
  commit("apps/mobile/app.txt", "feat(chat): first release");
  git("tag", "cohub-mobile-v1.0.0");
  commit("apps/web/page.txt", "feat(web): a service change");
  git("tag", "v9.0.0");
  commit("apps/mobile/app.txt", "fix(composer): an app fix");
  commit("apps/mobile/app.txt", "chore(mobile): release 1.0.1");
  git("tag", "cohub-mobile-v1.0.1");
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./release-notes.mjs", import.meta.url)), "cohub-mobile-v1.0.1"], {
    cwd: join(notesFixture, "apps/mobile"), encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: "netaart/cohub" },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /compare\/cohub-mobile-v1\.0\.0\.\.\.cohub-mobile-v1\.0\.1\)/, "The range starts at the previous app tag, not a service tag");
  assert.match(cli.stdout, /\*\*composer:\*\* an app fix/);
  assert.equal(cli.stdout.includes("a service change"), false, "Commits outside apps/mobile stay out");
  const first = spawnSync(process.execPath, [fileURLToPath(new URL("./release-notes.mjs", import.meta.url)), "cohub-mobile-v1.0.0"], {
    cwd: join(notesFixture, "apps/mobile"), encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY: "netaart/cohub" },
  });
  assert.notEqual(first.status, 0);
  assert.match(first.stderr, /No cohub-mobile-v\* tag precedes cohub-mobile-v1\.0\.0/);
} finally {
  rmSync(notesFixture, { recursive: true, force: true });
}


assert.equal(OTA_CLI_REVISION.length, 40);

// Run the actual Doctor wrapper with local CLI fixtures, without contacting Expo.
const doctorFixture = mkdtempSync(join(tmpdir(), "cohub-doctor-"));
try {
  mkdirSync(join(doctorFixture, "scripts"));
  mkdirSync(join(doctorFixture, "node_modules/expo/bin"), { recursive: true });
  mkdirSync(join(doctorFixture, "node_modules/expo-doctor/build"), { recursive: true });
  copyFileSync("scripts/check-expo-baseline.mjs", join(doctorFixture, "scripts/check-expo-baseline.mjs"));
  writeFileSync(join(doctorFixture, "node_modules/expo/bin/cli.js"), `
    const assert = require('node:assert/strict');
    assert.deepEqual(process.argv.slice(2), ['install', '--check']);
    assert.equal(process.env.EXPO_OFFLINE, '1');
    assert.equal(process.env.CI, '1');
    console.log('baseline checked');
    process.exit(Number(process.env.BASELINE_EXIT || 0));
  `);
  writeFileSync(join(doctorFixture, "node_modules/expo-doctor/build/index.js"), `
    const assert = require('node:assert/strict');
    assert.equal(process.env.EXPO_OFFLINE, undefined);
    assert.equal(process.env.EXPO_DOCTOR_SKIP_DEPENDENCY_VERSION_CHECK, '1');
    console.log('remaining doctor checks');
    process.exit(Number(process.env.DOCTOR_EXIT || 0));
  `);
  for (const [baselineExit, doctorExit, expected] of [[0, 0, 0], [7, 0, 7], [0, 9, 9]]) {
    const env = { ...process.env, BASELINE_EXIT: String(baselineExit), DOCTOR_EXIT: String(doctorExit) };
    delete env.EXPO_OFFLINE;
    const result = spawnSync(process.execPath, [join(doctorFixture, "scripts/check-expo-baseline.mjs")], { env, encoding: "utf8" });
    assert.equal(result.status, expected, result.stderr);
    assert.equal(result.stdout.includes('remaining doctor checks'), baselineExit === 0);
  }
} finally {
  rmSync(doctorFixture, { recursive: true, force: true });
}
const appPackage = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(appPackage.scripts.doctor, "node scripts/check-expo-baseline.mjs");
assert.equal(appPackage.scripts["doctor:upstream"], "expo-doctor");

console.log("OTA publish workflow checks passed.");
