// Opens or updates a PR that pins the CLI to a binary release just published to the CDN.
// Usage: node packages/cli/scripts/pin-binary.mjs <sandboxd|rtc> <vX.Y.Z>
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const PINS_FILE = "packages/cli/src/binary-pins.ts";
const PINS = {
  sandboxd: {
    label: "sandboxd",
    file: PINS_FILE,
    constant: "SANDBOXD_VERSION",
    // Every tag republishes sandboxd; skip releases that did not change it.
    watch: ["apps/sandbox"],
  },
  rtc: {
    label: "the RTC helper",
    file: PINS_FILE,
    constant: "RTC_HELPER_VERSION",
    // The RTC workflow only publishes when the helper changed.
    watch: [],
  },
};

const [name, tag] = process.argv.slice(2);
const pin = PINS[name];
if (!pin || !/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Usage: pin-binary.mjs <sandboxd|rtc> <vX.Y.Z>");

const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const parts = (version) => version.slice(1).split(".").map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  const index = x.findIndex((value, i) => value !== y[i]);
  return index >= 0 && x[index] > y[index];
};

const pattern = new RegExp(`(export const ${pin.constant}(?:: string)? = ")(v\\d+\\.\\d+\\.\\d+)(")`);
const source = readFileSync(pin.file, "utf8");
const current = pattern.exec(source)?.[2];
if (!current) throw new Error(`${pin.constant} not found in ${pin.file}`);
if (!newer(tag, current)) {
  console.log(`${pin.constant} is already ${current}; nothing to pin for ${tag}`);
  process.exit(0);
}
if (pin.watch.length > 0) {
  const diff = spawnSync("git", ["diff", "--quiet", current, tag, "--", ...pin.watch], { stdio: "inherit" });
  if (diff.status === 0) {
    console.log(`No changes in ${pin.watch.join(", ")} between ${current} and ${tag}`);
    process.exit(0);
  }
  if (diff.status !== 1) throw new Error(`git diff ${current} ${tag} failed`);
}

const changeset = `.changeset/pin-${name}.md`;
const title = `fix(cli): pin ${name} to ${tag}`;
writeFileSync(pin.file, source.replace(pattern, `$1${tag}$3`));
writeFileSync(changeset, `---\n"@neta-art/cohub-cli": patch\n---\n\nDownload ${pin.label} ${tag}.\n`);

const branch = `chore/pin-${name}`;
run("git", ["switch", "-C", branch]);
run("git", ["add", pin.file, changeset]);
run("git", ["-c", "user.name=github-actions[bot]", "-c", "user.email=41898283+github-actions[bot]@users.noreply.github.com", "commit", "-m", title]);
run("git", ["push", "--force", "origin", branch]);

const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = process.env;
const runLink = server && repository && runId ? ` by [this run](${server}/${repository}/actions/runs/${runId})` : "";
const body = `Published ${pin.label} ${tag} to the CDN${runLink}. Merging ships it with the next CLI release; \`prepublishOnly\` verifies the artifacts again before publishing.`;
const open = run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number", "--jq", ".[0].number"]);
if (open) run("gh", ["pr", "edit", open, "--title", title, "--body", body]);
else run("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body]);
console.log(`${open ? "Updated" : "Opened"} PR pinning ${pin.constant} to ${tag}`);
