import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getNativeIdentifiers(root = process.cwd()) {
  const { stdout } = await execFileAsync(
    "npx",
    ["expo", "config", "--type", "public", "--json"],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  const config = JSON.parse(stdout);
  const iosBundleId = config.ios?.bundleIdentifier;
  const androidPackage = config.android?.package;
  if (typeof iosBundleId !== "string" || !iosBundleId.trim()) {
    throw new Error("Expo config does not define ios.bundleIdentifier");
  }
  if (typeof androidPackage !== "string" || !androidPackage.trim()) {
    throw new Error("Expo config does not define android.package");
  }
  return { iosBundleId, androidPackage };
}

export async function configureAndroidAbiSplits(root = process.cwd(), architectures) {
  const supportedArchitectures = new Set(["armeabi-v7a", "arm64-v8a", "x86", "x86_64"]);
  const requestedArchitectures = typeof architectures === "string"
    ? architectures.split(",").map((architecture) => architecture.trim())
    : [];
  if (
    requestedArchitectures.length === 0 ||
    requestedArchitectures.some((architecture) => !supportedArchitectures.has(architecture)) ||
    new Set(requestedArchitectures).size !== requestedArchitectures.length
  ) {
    throw new Error(`Invalid Android ABI list: ${architectures ?? "<empty>"}`);
  }

  const normalizedArchitectures = requestedArchitectures.join(",");
  const gradlePath = join(root, "android", "app", "build.gradle");
  const source = await readFile(gradlePath, "utf8");
  const marker = "// COHUB_ABI_SPLITS";
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const includes = requestedArchitectures.map((architecture) => `"${architecture}"`).join(", ");

  if (source.includes(marker)) {
    const markerIndex = source.indexOf(marker);
    const afterMarker = source.slice(markerIndex);
    const includePattern = /^([ \t]*)include[ \t]+[^\r\n]*$/m;
    const includeMatch = includePattern.exec(afterMarker);
    if (!includeMatch) {
      throw new Error(`Could not find the Android ABI include line in ${gradlePath}`);
    }
    const updatedAfterMarker = afterMarker.replace(
      includePattern,
      `${includeMatch[1]}include ${includes}`,
    );
    const updatedSource = source.slice(0, markerIndex) + updatedAfterMarker;
    if (updatedSource !== source) await writeFile(gradlePath, updatedSource);
    console.log(`Configured Android ABI splits (${normalizedArchitectures}) in ${gradlePath}.`);
    return normalizedArchitectures;
  }

  const buildTypesMatches = [...source.matchAll(/^([ \t]*)buildTypes[ \t]*\{\r?\n/gm)];
  if (buildTypesMatches.length !== 1) {
    throw new Error(`Expected one Android buildTypes block in ${gradlePath}, found ${buildTypesMatches.length}`);
  }
  const baseIndent = buildTypesMatches[0][1];
  const childIndent = `${baseIndent}    `;
  const splitsBlock = [
    `${baseIndent}splits {`,
    `${childIndent}abi {`,
    `${childIndent}    ${marker}`,
    `${childIndent}    enable true`,
    `${childIndent}    reset()`,
    `${childIndent}    include ${includes}`,
    `${childIndent}    universalApk false`,
    `${childIndent}}`,
    `${baseIndent}}`,
    "",
  ].join(newline);
  const insertionIndex = buildTypesMatches[0].index;
  const updatedSource = source.slice(0, insertionIndex) + splitsBlock + source.slice(insertionIndex);
  await writeFile(gradlePath, updatedSource);
  console.log(`Configured Android ABI splits (${normalizedArchitectures}) in ${gradlePath}.`);
  return normalizedArchitectures;
}

export async function run(command, args, options = {}) {
  const { cwd = process.cwd(), env = process.env } = options;
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`));
    });
  });
}

export async function findIosWorkspace(root = process.cwd()) {
  const iosDir = join(root, "ios");
  const entries = await readdir(iosDir, { withFileTypes: true });
  const workspaces = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".xcworkspace") && entry.name !== "Pods.xcworkspace")
    .map((entry) => join(iosDir, entry.name));
  if (workspaces.length !== 1) {
    throw new Error(`Expected one application Xcode workspace in ${iosDir}, found ${workspaces.length}`);
  }
  return resolve(workspaces[0]);
}

export async function findIosScheme(workspace) {
  const { stdout, stderr } = await execFileAsync("xcodebuild", ["-list", "-workspace", workspace], { encoding: "utf8" });
  const output = `${stdout}\n${stderr}`;
  const lines = output.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === "Schemes:");
  if (headerIndex < 0) throw new Error(`Could not find schemes in ${workspace}`);
  for (const line of lines.slice(headerIndex + 1)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (candidate.endsWith("Tests") || candidate === "Pods") continue;
    return candidate;
  }
  throw new Error(`Could not resolve an application scheme in ${workspace}`);
}

async function findFiles(root, predicate, output = []) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (predicate(path, entry)) output.push(path);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      await findFiles(path, predicate, output);
    }
  }
  return output;
}

export async function findBuiltIosApp(root, scheme) {
  const products = join(root, "build", "ios", "Build", "Products");
  const apps = await findFiles(products, (path, entry) => entry.isDirectory() && path.endsWith(`${scheme}.app`));
  if (apps.length !== 1) throw new Error(`Expected one built ${scheme}.app in ${products}, found ${apps.length}`);
  return apps[0];
}

export async function findBuiltIpa(root) {
  const exportDir = join(root, "build", "export");
  const files = await findFiles(exportDir, (path, entry) => entry.isFile() && path.endsWith(".ipa"));
  if (files.length !== 1) throw new Error(`Expected one IPA in ${exportDir}, found ${files.length}`);
  return files[0];
}

export async function ensureDirectory(path) {
  await stat(path).catch(async (error) => {
    if (error.code !== "ENOENT") throw error;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path, { recursive: true });
  });
}
