/**
 * Renders a GitHub Release body for one app tag from the Conventional Commits that touched
 * apps/mobile since the previous app tag. The body also reaches the in-app update sheet
 * through Yaota, so it keeps the section layout Release Please used to produce.
 *
 * Usage: GITHUB_REPOSITORY=owner/repo node scripts/release-notes.mjs cohub-mobile-vX.Y.Z
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

export const TAG_PREFIX = "cohub-mobile-v";
const TAG = /^cohub-mobile-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<subject>.+)$/;
const SECTIONS = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["build", "Build"],
  ["ci", "CI"],
];
// Separators that cannot appear in commit messages.
const FIELD = "\x1f";
const RECORD = "\x1e";

export function parseAppTag(tag) {
  const match = TAG.exec(String(tag ?? "").trim());
  if (!match) throw new Error(`Expected a stable ${TAG_PREFIX}X.Y.Z tag, received: ${tag}`);
  return { tag: match[0], version: match[1] };
}

/** Parses `git log` records; commits that are not Conventional Commits are left out. */
export function parseCommits(log) {
  return log.split(RECORD).map((record) => record.replace(/^\n/, "")).filter(Boolean).flatMap((record) => {
    const [sha, subject, body = ""] = record.split(FIELD);
    const header = HEADER.exec(subject.trim());
    if (!header) return [];
    const { type, scope, breaking, subject: text } = header.groups;
    return [{ sha, type, scope: scope ?? null, subject: text, breaking: Boolean(breaking) || /^BREAKING[ -]CHANGE: /m.test(body) }];
  });
}

export function renderReleaseNotes({ repository, previousTag, tag, date, commits }) {
  const { version } = parseAppTag(tag);
  const base = `https://github.com/${repository}`;
  // Every commit here is an app commit, so the app scope itself adds nothing.
  const scopeOf = (commit) => (commit.scope && commit.scope !== "mobile" ? commit.scope.replace(/^mobile\//, "") : "");
  const line = (commit) => {
    const scope = scopeOf(commit) ? `**${scopeOf(commit)}:** ` : "";
    return `* ${scope}${commit.subject} ([${commit.sha.slice(0, 7)}](${base}/commit/${commit.sha}))`;
  };
  const ordered = (entries) => [...entries].sort((a, b) => scopeOf(a).localeCompare(scopeOf(b)) || a.subject.localeCompare(b.subject));
  const sections = [];
  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length > 0) sections.push(["⚠ BREAKING CHANGES", breaking]);
  for (const [type, title] of SECTIONS) {
    const entries = commits.filter((commit) => commit.type === type);
    if (entries.length > 0) sections.push([title, entries]);
  }
  const body = sections.map(([title, entries]) => `### ${title}\n\n${ordered(entries).map(line).join("\n")}`).join("\n\n\n");
  return `## [${version}](${base}/compare/${previousTag}...${tag}) (${date})\n\n\n${body || "No user-facing changes."}\n`;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { tag } = parseAppTag(process.argv[2]);
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  if (!repository) throw new Error("GITHUB_REPOSITORY is required to link commits.");
  let previousTag;
  try {
    previousTag = git("describe", "--tags", "--abbrev=0", "--match", `${TAG_PREFIX}*`, `${tag}^`);
  } catch {
    throw new Error(`No ${TAG_PREFIX}* tag precedes ${tag}. Fetch tags (fetch-depth: 0) or push the previous app tag first.`);
  }
  const date = git("log", "-1", "--format=%cs", tag);
  // `-- .` keeps the range to apps/mobile when run from the app directory.
  const log = git("log", "--no-merges", `--format=%H${FIELD}%s${FIELD}%b${RECORD}`, `${previousTag}..${tag}`, "--", ".");
  process.stdout.write(renderReleaseNotes({ repository, previousTag, tag, date, commits: parseCommits(log) }));
}
