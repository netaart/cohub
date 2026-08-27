import { readFile, appendFile } from "node:fs/promises";
import process from "node:process";

const path = process.argv[2];
if (!path) throw new Error("Usage: node scripts/summarize-eas-build.mjs <eas-build.json>");
const builds = JSON.parse(await readFile(path, "utf8"));
const rows = (Array.isArray(builds) ? builds : [builds]).map((build) => ({
  platform: build.platform ?? "unknown",
  id: build.id ?? "unknown",
  status: build.status ?? "queued",
  url: build.buildDetailsPageUrl ?? (build.id ? `https://expo.dev/accounts/-/projects/-/builds/${build.id}` : ""),
}));
const lines = [
  "## EAS builds queued",
  "",
  "| Platform | Build | Status |",
  "| --- | --- | --- |",
  ...rows.map((row) => `| ${row.platform} | ${row.url ? `[${row.id}](${row.url})` : row.id} | ${row.status} |`),
  "",
];
const summary = lines.join("\n");
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
