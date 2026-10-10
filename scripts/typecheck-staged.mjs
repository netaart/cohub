#!/usr/bin/env node
// Pre-commit typecheck scoped to staged changes.
//
// Semantics (matches lint-staged: only staged files are considered):
// - Files staged under apps/* or packages/* (with a package.json) map to that workspace.
//   The typecheck runs for the affected workspaces AND their transitive dependents
//   (via pnpm's "...{dir}" filter), so a public-package change still checks all consumers.
// - Changes to root-level code/config that affect every workspace
//   (tsconfig.base.json, package.json, pnpm-workspace.yaml, pnpm-lock.yaml, scripts/, .husky/)
//   fall back to a full `pnpm -r typecheck`.
// - A removed workspace (delete of a dir that no longer has a package.json) also falls back
//   to a full typecheck: its consumers can no longer be resolved via the workspace graph.
// - Staged changes outside all of the above (docs, assets, workflows, ...) skip typecheck.
//
// Usage: node scripts/typecheck-staged.mjs [--dry-run]

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");

const FORCE_FULL_PREFIXES = [
  "tsconfig.base.json",
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "scripts/",
  ".husky/",
];

const dryRun = process.argv.includes("--dry-run");

function stagedFiles() {
  try {
    // --no-renames: a rename is reported as delete + add, so the old workspace is not lost.
    const out = execFileSync(
      "git",
      ["diff", "--cached", "--name-status", "-z", "--no-renames", "--diff-filter=ACMRD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const entries = [];
    const parts = out.split("\0");
    for (let i = 0; i < parts.length; i += 2) {
      const status = parts[i]?.[0];
      const file = parts[i + 1];
      if (status && file) entries.push({ status, file });
    }
    return entries;
  } catch {
    return null; // git unavailable -> fall back to full typecheck
  }
}

async function main() {
  const files = stagedFiles();
  if (files === null) {
    console.log("typecheck: git unavailable, running full typecheck");
    return run(["-r", "typecheck"]);
  }
  if (files.length === 0) {
    console.log("typecheck: no staged changes, skipping");
    return 0;
  }

  const affected = new Set();
  let forceFull = false;
  for (const { status, file } of files) {
    if (FORCE_FULL_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix))) {
      forceFull = true;
      continue;
    }
    const match = file.match(/^(apps|packages)\/([^/]+)(?:\/|$)/);
    if (!match) continue;
    const dir = `${match[1]}/${match[2]}`;
    if (fs.existsSync(path.join(repoRoot, dir, "package.json"))) {
      affected.add(dir);
    } else if (status === "D") {
      // Workspace removed: consumers can no longer be scoped via the workspace graph.
      forceFull = true;
    }
  }

  if (forceFull) {
    console.log("typecheck: root config or workspace removed, running full typecheck");
    return run(["-r", "typecheck"]);
  }
  if (affected.size === 0) {
    console.log("typecheck: no code changes in workspaces, skipping");
    return 0;
  }

  const dirs = [...affected].sort();
  console.log(`typecheck: ${dirs.join(", ")} (+ dependents)`);
  const args = [];
  for (const dir of dirs) args.push("--filter", `...{${dir}}`);
  args.push("run", "typecheck");
  return run(args);
}

async function run(pnpmArgs) {
  const fullArgs = ["--reporter=append-only", ...pnpmArgs];
  if (dryRun) {
    console.log(`typecheck: [dry-run] pnpm ${fullArgs.join(" ")}`);
    return 0;
  }
  // pnpm 12 ships a native executable, so `npm_execpath` can no longer be run
  // through `node`; spawn the `pnpm` on PATH instead (works on pnpm 10–12).
  return new Promise((resolve) => {
    const child = spawn("pnpm", fullArgs, { stdio: "inherit" });
    child.once("error", (error) => {
      console.error(`typecheck: failed to spawn pnpm: ${error.message}`);
      resolve(1);
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
}

main().then((code) => process.exit(code));
