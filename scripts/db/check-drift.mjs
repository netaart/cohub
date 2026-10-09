#!/usr/bin/env node
/**
 * Keep `schema-v2.ts` and the Drizzle snapshots in step.
 *
 * Board v3 ships its DDL as handwritten SQL (0067_board_v3.sql) next to the
 * `drizzle-kit` snapshots, which is deliberate — and also how the two drift: a
 * column added to the schema with no migration leaves every snapshot stale, and
 * nothing notices until someone happens to run the generator.
 *
 * So run it here. `drizzle-kit generate` writes nothing when the schema already
 * matches, so the check is: snapshot the directory, generate, compare.
 *
 *   node scripts/db/check-drift.mjs
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../apps/api");
/** The generator's output, relative to `apps/api`. */
const OUTPUT = "drizzle/v2";

/** Every file under the output, as a path → contents map. */
function snapshot() {
	const files = new Map();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else files.set(relative(apiDir, path), readFileSync(path, "utf8"));
		}
	};
	walk(join(apiDir, OUTPUT));
	return files;
}

const before = snapshot();
const run = spawnSync("npx", ["drizzle-kit", "generate", "--name", "drift-check"], {
	cwd: apiDir,
	encoding: "utf8",
	env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/cohub" },
});
const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
if (run.status !== 0) {
	process.stderr.write(output);
	console.error("\ndrizzle-kit generate failed; the schema is not readable.");
	process.exit(1);
}

const after = snapshot();
const changes = [];
for (const [path, contents] of after) {
	if (!before.has(path)) changes.push(`  + ${path}`);
	else if (before.get(path) !== contents) changes.push(`  ~ ${path}`);
}
for (const path of before.keys()) if (!after.has(path)) changes.push(`  - ${path}`);

if (changes.length === 0) {
	console.log("Drizzle snapshots match the schema.");
	process.exit(0);
}
console.error("The schema and the Drizzle snapshots disagree:\n");
console.error(changes.join("\n"));
console.error("\nRun `pnpm --filter @cohub/api db:generate` and commit the result.");
process.exit(1);
