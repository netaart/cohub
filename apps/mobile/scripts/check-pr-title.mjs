import process from "node:process";

const title = process.argv.slice(2).join(" ").trim();
const conventional = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9][a-z0-9._/-]*\))?(!)?: .+/;

if (!title) {
  console.error("PR title is required.");
  process.exit(1);
}
if (!conventional.test(title)) {
  console.error(`PR title must follow Conventional Commits: ${title}`);
  console.error("Example: feat(chat): add turn retry");
  process.exit(1);
}
console.log(`Valid Conventional Commit title: ${title}`);
