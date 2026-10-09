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
import { newestAppTags } from "./e2e/resolve-golden.mjs";

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
// The app's workflows live in the monorepo root and run every step from apps/mobile.
const workflow = (name) => {
  const parsed = parse(fileURLToPath(new URL(`../../../.github/workflows/${name}`, import.meta.url)));
  assert.equal(parsed.defaults?.run?.["working-directory"], "apps/mobile", `${name} must run its steps from apps/mobile`);
  assert.match(parsed.name, /^Mobile /, `${name} must be named apart from the monorepo's workflows`);
  return parsed;
};
const ota = workflow("mobile-publish-ota.yml");
assert.deepEqual(ota.on.push.branches, ["main"]);
assert.deepEqual(ota.on.push.paths, ["apps/mobile/**"], "Only app changes publish OTA");
assert.ok(Object.hasOwn(ota.on, "workflow_dispatch"));
assert.deepEqual(ota.on.workflow_dispatch.inputs.channel.options, ["staging", "production"]);
assert.equal(ota.on.workflow_dispatch.inputs.channel.default, "production");
assert.equal(ota.concurrency["cancel-in-progress"], false);
assert.equal(ota.concurrency.group, "mobile-ota-publish-${{ github.event.inputs.channel || 'production' }}");
assert.equal(ota.env.OTA_CLI_REPOSITORY, OTA_CLI_REPOSITORY);
assert.equal(ota.env.OTA_CLI_REVISION, OTA_CLI_REVISION);
assert.match(ota.jobs.prepare.if, /refs\/heads\/main/);
const publishAndroid = ota.jobs["publish-android"];
const publishIos = ota.jobs["publish-ios"];
assert.deepEqual(publishAndroid.needs, ["prepare", "android"]);
assert.deepEqual(publishIos.needs, ["prepare", "ios"]);
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
      return { status: result.status, calls: Number(read("calls")), sleeps: read("sleeps").trim().split("\n").filter(Boolean), output: result.stdout + result.stderr };
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

const nativeCi = workflow("mobile-native-ci.yml");
assert.equal(Object.hasOwn(nativeCi.on, "push"), false);
assert.equal(Object.hasOwn(nativeCi.on, "pull_request"), false, "PR workflow must not compile native debug builds");
assert.ok(Object.hasOwn(nativeCi.on, "workflow_dispatch"), "Native CI remains available as a manual run");

const nativeRelease = workflow("mobile-native-release.yml");
assert.ok(nativeRelease.on.workflow_dispatch.inputs.platform.options.includes("ios"), "Native Release must allow iOS-only TestFlight builds");

// Gradle caches must key on the committed dependency set. setup-java hashes the
// prebuild-generated android/*.gradle files and offers no older-entry fallback, so its
// cache goes cold on every app version or config bump (~4 minutes of re-downloads).
for (const [file, parsed] of [["mobile-native-ci.yml", nativeCi], ["mobile-native-release.yml", nativeRelease]]) {
  const javaStep = parsed.jobs.android.steps.find((step) => step.uses === "actions/setup-java@v6");
  assert.ok(javaStep, `${file} must set up Java for the Android build`);
  assert.equal(javaStep.with.cache, undefined, `${file} must cache Gradle explicitly instead of through setup-java`);
  const gradleCache = parsed.jobs.android.steps.find((step) => String(step.uses).startsWith("actions/cache@"));
  assert.ok(gradleCache, `${file} must restore the Gradle caches`);
  assert.match(gradleCache.with.path, /~\/\.gradle\/caches/, `${file} must cache the Gradle dependency caches`);
  assert.match(gradleCache.with.path, /~\/\.gradle\/wrapper/, `${file} must cache the Gradle wrapper distributions`);
  assert.match(gradleCache.with.key, /hashFiles\('apps\/mobile\/package-lock\.json'\)/, `${file} must key the Gradle cache on the committed dependency set`);
  assert.match(gradleCache.with["restore-keys"], /gradle-\$\{\{ runner\.os \}\}-/, `${file} must fall back to the previous Gradle cache so dependency updates stay warm`);
}

const ci = workflow("mobile-ci.yml");
for (const event of ["push", "pull_request"]) {
  assert.deepEqual(ci.on[event].paths, ["apps/mobile/**", ".github/workflows/mobile-*.yml"], `Mobile CI must ${event} only for app changes`);
}
const e2e = workflow("mobile-e2e-android.yml");
assert.deepEqual(e2e.on.workflow_run.workflows, [ota.name], "E2E must chain off the OTA workflow by its current name");
workflow("mobile-security.yml");
assert.deepEqual(ci.jobs.bundle.strategy.matrix.platform, ["android", "ios"], "CI must still export both platform bundles");
assert.equal(Object.hasOwn(ci.jobs.bundle, "needs"), false, "CI exports must not serialize behind Quality: they are independent and serializing them doubled every run's wall clock");

const testFlightUpload = nativeRelease.jobs.ios.steps.find((step) => step.name === "Submit iOS to TestFlight");
assert.equal(testFlightUpload.with["wait-for-processing"], "true", "TestFlight uploads must confirm Apple processed the build");
assert.equal(Object.hasOwn(testFlightUpload.with, "uses-non-exempt-encryption"), false, "TestFlight uploads must not patch build metadata with a limited API key");
const appJson = JSON.parse(readFileSync("app.json", "utf8"));
assert.equal(appJson.expo.ios.infoPlist.ITSAppUsesNonExemptEncryption, false, "iOS builds must declare export compliance in Info.plist");
assert.equal(nativeRelease.jobs.ios.env.EXPO_PUBLIC_UPDATES_URL, "${{ vars.MOBILE_EXPO_PUBLIC_UPDATES_URL }}");
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

const taggedRelease = workflow("mobile-native-tag.yml");
assert.match(JSON.stringify(taggedRelease.jobs["publish-android"].steps), /gh release upload/, "GitHub Release must still attach APKs");
assert.match(JSON.stringify(taggedRelease.jobs["publish-android"].steps), /publish-yaota-apks/, "Native Tag Release must publish the same APKs to Yaota");
assert.match(JSON.stringify(taggedRelease.jobs["publish-android"].steps), /OTA_SERVER/);
assert.deepEqual(taggedRelease.on.push.tags, ["cohub-mobile-v*"], "The monorepo's vX.Y.Z tags release the services, not the app");
assert.deepEqual(Object.keys(taggedRelease.on), ["push"], "Only a tag push starts automatic native release; release events must not duplicate it");
assert.equal(taggedRelease.concurrency["cancel-in-progress"], false);
assert.match(taggedRelease.concurrency.group, /github.ref/);
assert.match(taggedRelease.jobs.prepare.if, /!github.event.deleted/);
const prepareSteps = JSON.stringify(taggedRelease.jobs.prepare.steps);
assert.match(prepareSteps, /--is-ancestor/);
assert.match(prepareSteps, /--require-native-tag/);
assert.match(prepareSteps, /--verify-tag/);
assert.match(prepareSteps, /--latest=false/, "An app release must not become the repository's Latest release");
assert.match(prepareSteps, /scripts\/release-notes\.mjs/);
assert.equal(prepareSteps.includes("--generate-notes"), false, "Generated notes would list every monorepo PR");
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
  git("tag", "-a", "cohub-mobile-v1.2.3", "-m", "test release");
  git("tag", "cohub-mobile-v1.2.4");
  git("push", "origin", "main", "--tags");
  const runTag = (tag, sha = releaseSha) => spawnSync("bash", ["-e", "-c", validateTag.run], {
    cwd: checkout, encoding: "utf8", env: { ...process.env, RELEASE_TAG: tag, GITHUB_SHA: sha, GITHUB_OUTPUT: join(tagFixture, "output") },
  });
  let result = runTag("cohub-mobile-v1.2.3");
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(tagFixture, "output"), "utf8"), /tag=cohub-mobile-v1.2.3/);
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
  git("checkout", "main");
  git("commit", "--allow-empty", "-m", "test: newer main");
  const newerSha = git("rev-parse", "HEAD");
  git("push", "origin", "main");
  result = runTag("cohub-mobile-v1.2.3", newerSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Tag moved/);
  git("checkout", "-b", "unmerged");
  git("commit", "--allow-empty", "-m", "test: unmerged release");
  const unmergedSha = git("rev-parse", "HEAD");
  git("tag", "cohub-mobile-v1.2.6");
  git("push", "origin", "cohub-mobile-v1.2.6");
  result = runTag("cohub-mobile-v1.2.6", unmergedSha);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /reachable from origin\/main/);
} finally {
  rmSync(tagFixture, { recursive: true, force: true });
}
for (const platform of ["android", "ios"]) {
  const job = taggedRelease.jobs[platform];
  assert.equal(job.needs, "prepare");
  assert.equal(job.uses, "./.github/workflows/mobile-native-release.yml");
  assert.equal(job.with.platform, platform);
  assert.equal(job.with.release_tag, "${{ needs.prepare.outputs.tag }}");
  // inherit would hand every monorepo secret to the native build.
  assert.equal(typeof job.secrets, "object", `${platform} must pass its secrets explicitly`);
  for (const [name, value] of Object.entries(job.secrets)) {
    assert.ok(Object.hasOwn(nativeRelease.on.workflow_call.secrets, name), `${name} must be declared by the reusable workflow`);
    assert.equal(value, `\${{ secrets.${name} }}`);
  }
}
assert.equal(taggedRelease.jobs.android.with.profile, "distribution");
assert.equal(taggedRelease.jobs.android.with.submit, false);
assert.equal(taggedRelease.jobs.ios.with.profile, "production");
assert.equal(taggedRelease.jobs.ios.with.submit, true);
assert.equal(taggedRelease.jobs.ios.permissions.contents, "write");
assert.deepEqual(taggedRelease.jobs["publish-android"].needs, ["prepare", "android"]);
assert.match(JSON.stringify(taggedRelease.jobs["publish-android"].steps), /cohub-android-native-fingerprint.txt/);
const publishApkStep = taggedRelease.jobs["publish-android"].steps.find((step) => step.name === "Upload formal APKs to GitHub Release");
assert.ok(publishApkStep, "The release workflow must attach formal Android APKs to the GitHub Release");
assert.match(publishApkStep.run, /find build\/release/, "Artifact downloads keep their directory layout, so the publish step must locate APKs recursively");
assert.equal(publishApkStep.run.includes("build/release/*.apk"), false, "A flat glob misses APKs nested under android/app/build/outputs");
assert.match(publishApkStep.run, /cohub-\$\{RELEASE_TAG#cohub-mobile-\}-android-/, "APK names stay cohub-vX.Y.Z for Yaota and the landing page");
for (const platform of ["android", "ios"]) {
  assert.match(JSON.stringify(ota.jobs[platform].steps), /matching-refs\/tags\/cohub-mobile-v/, `${platform} OTA must resolve its runtime from app releases only`);
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

// E2E picks its golden APK among app tags, ignoring the services' vX.Y.Z tags.
assert.deepEqual(
  newestAppTags(["refs/tags/cohub-mobile-v2.2.9", "refs/tags/cohub-mobile-v2.10.0", "refs/tags/cohub-mobile-v2.2.14", "refs/tags/cohub-mobile-v2.3.0-rc.1"], 2),
  ["cohub-mobile-v2.10.0", "cohub-mobile-v2.2.14"],
);

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
