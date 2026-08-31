import { readFile } from "node:fs/promises";

const startupModules = [
  "src/platform/NavigationBridge.tsx",
  "src/platform/notifications.ts",
];
const staticImportPattern = /(?:^|\n)\s*import\s+(?!\s*type\b)(?:(?:(?!;)[\s\S])*?\s+from\s+)?["']expo-notifications["'];/;
const failures = [];

for (const path of startupModules) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  if (staticImportPattern.test(source)) {
    failures.push(`${path} must not statically import expo-notifications`);
  }
}

const notificationsSource = await readFile(
  new URL("../src/platform/notifications.ts", import.meta.url),
  "utf8",
);
const dynamicImport = notificationsSource.indexOf('notificationsModulePromise = import("expo-notifications")');
const expoGoGuard = notificationsSource.indexOf("isRunningInExpoGo()");
if (dynamicImport < 0) {
  failures.push("src/platform/notifications.ts must dynamically load expo-notifications");
} else if (expoGoGuard < 0 || expoGoGuard > dynamicImport) {
  failures.push("src/platform/notifications.ts must check Expo Go before loading notifications");
}

if (failures.length > 0) {
  console.error("Expo Go notification import validation failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Expo Go notification import validation passed.");
