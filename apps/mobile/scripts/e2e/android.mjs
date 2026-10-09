import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveGolden } from "./resolve-golden.mjs";

/**
 * Device E2E for Android: install the newest release binary that shares the
 * target commit's runtime, let production OTA bring it to the current JS, then
 * drive the on-device debug screens with Maestro.
 *
 * Native builds cost ~30 minutes and are only needed when the fingerprint
 * changes; a JS-only change rides an already released APK through OTA.
 */

const PACKAGE_ID = "io.github.markbang.cohubmobile";
const EVIDENCE_ROOT = "dist/e2e";
// Kept outside the evidence path so the released APK never lands in the uploaded artifact.
const APK_CACHE_ROOT = "dist/e2e-cache";
const DEFAULT_FLOWS = ["e2e/flows"];
const LOGIN_FLOW = "e2e/auth/login.yaml";
const DEFAULT_OTA_WAIT_MS = 45_000;

export function parseArgs(argv) {
  const options = {
    abi: "x86_64",
    serial: null,
    repository: "markbang/cohub-mobile",
    flows: [...DEFAULT_FLOWS],
    otaWaitMs: DEFAULT_OTA_WAIT_MS,
    skipInstall: false,
    planOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--abi") options.abi = String(argv[++index] ?? "").trim();
    else if (flag === "--serial") options.serial = String(argv[++index] ?? "").trim();
    else if (flag === "--repository") options.repository = String(argv[++index] ?? "").trim();
    else if (flag === "--flows") options.flows = String(argv[++index] ?? "").trim().split(",").filter(Boolean);
    else if (flag === "--ota-wait") options.otaWaitMs = Number(argv[++index]) * 1000;
    else if (flag === "--skip-install") options.skipInstall = true;
    else if (flag === "--plan-only") options.planOnly = true;
    else throw new Error(`Unknown argument "${flag}".`);
  }
  if (!Number.isFinite(options.otaWaitMs) || options.otaWaitMs < 0) {
    throw new Error("--ota-wait must be a non-negative number of seconds.");
  }
  if (options.flows.length === 0) throw new Error("--flows must name at least one Maestro flow or directory.");
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
  if (result.error) throw result.error;
  return result;
}

function requireCommand(command, hint) {
  const probe = spawnSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!probe.error) return;
  throw new Error(`${command} is required. ${hint}`);
}

function adb(serial, args, options = {}) {
  const result = run("adb", ["-s", serial, ...args], options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").at(-1);
    throw new Error(`adb ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`);
  }
  return result.stdout;
}

function firstDevice() {
  const result = run("adb", ["devices"]);
  const serials = result.stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);
  if (serials.length === 0) {
    throw new Error("No authorized Android device or emulator is connected. Start an emulator or attach a device.");
  }
  return serials[0];
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureApk(options, golden) {
  const directory = join(APK_CACHE_ROOT, golden.tag);
  mkdirSync(directory, { recursive: true });
  const apkPath = join(directory, golden.apkName);
  const expected = golden.apkDigest?.replace(/^sha256:/, "") ?? null;
  if (!expected) throw new Error(`${golden.tag} has no published digest for ${golden.apkName}; refusing to install an unverified APK.`);
  if (!existsSync(apkPath) || sha256(apkPath) !== expected) {
    const download = run("gh", ["release", "download", golden.tag, "--repo", options.repository, "--pattern", golden.apkName, "--dir", directory, "--clobber"]);
    if (download.status !== 0) {
      throw new Error(`Failed to download ${golden.apkName} from ${golden.tag}: ${(download.stderr || "").trim()}`);
    }
    const actual = sha256(apkPath);
    if (actual !== expected) throw new Error(`${golden.apkName} digest mismatch. Expected ${expected}, got ${actual}.`);
  }
  return apkPath;
}

function coldLaunch(serial) {
  adb(serial, ["shell", "am", "force-stop", PACKAGE_ID]);
  const start = adb(serial, ["shell", "monkey", "-p", PACKAGE_ID, "-c", "android.intent.category.LAUNCHER", "1"]);
  if (!/Events injected/.test(start)) throw new Error(`Could not launch ${PACKAGE_ID}. Is it installed?`);
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** The accessibility tree is exactly what a selector has to match; the PNG is for the human. */
function captureWindow(serial, directory) {
  run("adb", ["-s", serial, "shell", "uiautomator", "dump", "/sdcard/e2e-window.xml"]);
  run("adb", ["-s", serial, "pull", "/sdcard/e2e-window.xml", join(directory, "window.xml")]);
  const fd = openSync(join(directory, "screen.png"), "w");
  try {
    spawnSync("adb", ["-s", serial, "exec-out", "screencap", "-p"], { stdio: ["ignore", fd, "inherit"] });
  } finally {
    closeSync(fd);
  }
}

function hitDeviceServerFailure(resultPath) {
  try {
    return /DeviceServerDied|Unknown error/i.test(readFileSync(resultPath, "utf8"));
  } catch {
    return false;
  }
}

export async function runAndroid(options) {
  requireCommand("gh", "Install the GitHub CLI and authenticate with `gh auth login`.");

  const plan = await resolveGolden({ abi: options.abi, repository: options.repository });
  const { golden } = plan;
  if (options.planOnly) return { plan, evidence: null };

  requireCommand("adb", "Install Android platform-tools and add them to PATH.");
  requireCommand("maestro", "Install Maestro: https://maestro.mobile.dev");

  if (golden.aheadBy === 0) {
    throw new Error(
      `Golden ${golden.tag} is the target commit, so no newer OTA bundle is pending. Wait for the next main push or pass an older --commit.`,
    );
  }

  const serial = options.serial || firstDevice();
  const apkPath = ensureApk(options, golden);
  const evidence = resolve(join(EVIDENCE_ROOT, golden.tag, new Date().toISOString().replace(/[:.]/g, "-")));
  mkdirSync(evidence, { recursive: true });

  if (!options.skipInstall) {
    adb(serial, ["install", "-r", "-d", apkPath]);
  }
  // Motion makes selector waits and screenshots flaky; this does not change app behavior.
  for (const scale of ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]) {
    adb(serial, ["shell", "settings", "put", "global", scale, "0"]);
  }
  // Maestro logs an accessibility dump per lookup, which evicts older lines fast; a bigger
  // buffer keeps the run's own output when the logcat is collected afterwards.
  adb(serial, ["shell", "logcat", "-G", "16M"]);
  adb(serial, ["logcat", "-c"]);

  // The first cold launch downloads the OTA bundle in the background; the second
  // one boots it. Both are required before the debug screen can report
  // `embedded=false`.
  coldLaunch(serial);
  wait(options.otaWaitMs);
  coldLaunch(serial);
  wait(10_000);

  const email = process.env.E2E_ACCOUNT_EMAIL?.trim();
  const password = process.env.E2E_ACCOUNT_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error("E2E_ACCOUNT_EMAIL and E2E_ACCOUNT_PASSWORD are required: every screen renders AuthScreen until a Logto session exists.");
  }
  const flowsIncludeLogin = options.flows.includes(LOGIN_FLOW);
  // Run the suite in one Maestro session. Invoking Maestro per flow left later deep links
  // unhandled and the app on the wrong screen, so the run stayed a single batch and the
  // per-flow JUnit report is what pinpoints a failure.
  const maestroArgs = [
    "test", "--device", serial,
    "--format", "junit",
    "--output", join(evidence, "maestro-junit.xml"),
    "-e", `E2E_ACCOUNT_EMAIL=${email}`,
    "-e", `E2E_ACCOUNT_PASSWORD=${password}`,
  ];
  if (!flowsIncludeLogin) maestroArgs.push(LOGIN_FLOW);
  maestroArgs.push(...options.flows);
  let maestro = run("maestro", maestroArgs, { stdio: "inherit" });
  // Maestro's Android device server dies mid-run often enough that one retry is worth it; the
  // failure shows up as an instrumentation crash and a flow reported as "Unknown error".
  if (maestro.status !== 0 && hitDeviceServerFailure(join(evidence, "maestro-junit.xml"))) {
    process.stdout.write("The device server died mid-run; retrying the suite once.\n");
    wait(10000);
    maestro = run("maestro", maestroArgs, { stdio: "inherit" });
    writeFileSync(join(evidence, "retried"), "true\n");
  }
  // The device stays on the screen where the run stopped; the tree is what a selector matched.
  captureWindow(serial, evidence);

  // A full logcat dump can exceed the default pipe buffer, so stream it straight to disk.
  const logcatPath = join(evidence, "logcat.txt");
  const logcatFd = openSync(logcatPath, "w");
  try {
    spawnSync("adb", ["-s", serial, "logcat", "-d"], { stdio: ["ignore", logcatFd, "inherit"] });
  } finally {
    closeSync(logcatFd);
  }
  writeFileSync(join(evidence, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);

  if (maestro.status !== 0) {
    throw new Error(`Maestro reported failures. Evidence: ${evidence}`);
  }
  return { plan, evidence };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runAndroid(options);
    if (options.planOnly) {
      process.stdout.write(`${JSON.stringify(result.plan.golden, null, 2)}\n`);
    } else {
      process.stdout.write(`Android E2E passed. Evidence: ${result.evidence}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    // 3 tells CI to skip: no released native binary is compatible with this commit.
    process.exit(error?.code === "NO_GOLDEN" ? 3 : 1);
  }
}
