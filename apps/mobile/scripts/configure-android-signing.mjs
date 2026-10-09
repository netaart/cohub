import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const gradlePath = process.argv[2] || "android/app/build.gradle";
const required = [
  "COHUB_ANDROID_KEYSTORE_PATH",
  "COHUB_ANDROID_KEYSTORE_PASSWORD",
  "COHUB_ANDROID_KEY_ALIAS",
  "COHUB_ANDROID_KEY_PASSWORD",
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Missing Android signing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

let source = await readFile(gradlePath, "utf8");
const marker = "// COHUB_NATIVE_SIGNING";
const signingBlock = `        ${marker}\n        release {\n            storeFile file(System.getenv("COHUB_ANDROID_KEYSTORE_PATH"))\n            storePassword System.getenv("COHUB_ANDROID_KEYSTORE_PASSWORD")\n            keyAlias System.getenv("COHUB_ANDROID_KEY_ALIAS")\n            keyPassword System.getenv("COHUB_ANDROID_KEY_PASSWORD")\n        }\n`;

if (!source.includes(marker)) {
  const signingConfigs = "    signingConfigs {\n";
  if (!source.includes(signingConfigs)) {
    throw new Error(`Could not find signingConfigs block in ${gradlePath}`);
  }
  source = source.replace(signingConfigs, `${signingConfigs}${signingBlock}`);
}

const configuredReleaseTarget = "            signingConfig signingConfigs.release\n            def enableShrinkResources";
if (source.includes(configuredReleaseTarget)) {
  console.log(`Native Android release signing is already configured in ${gradlePath}.`);
  process.exit(0);
}
const debugReleaseTarget = "            signingConfig signingConfigs.debug\n            def enableShrinkResources";
const matchCount = source.split(debugReleaseTarget).length - 1;
if (matchCount !== 1) {
  throw new Error(`Expected one generated release signing target in ${gradlePath}, found ${matchCount}`);
}
source = source.replace(debugReleaseTarget, configuredReleaseTarget);
await writeFile(gradlePath, source);
console.log(`Configured native Android release signing in ${gradlePath}.`);
