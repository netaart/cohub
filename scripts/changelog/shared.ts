import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as z from "zod";

export const ENTRIES_PATH = join(
	process.cwd(),
	"apps/web/src/lib/changelog/entries.json",
);

export const AgentResponseSchema = z.object({
	highlights: z.array(z.string().min(1)).min(1).max(6),
	fixes: z.array(z.string().min(1)).optional(),
});

export const ChangelogEntrySchema = z.object({
	version: z.string(),
	date: z.string(),
	tags: z.array(z.string()),
	highlights: z.array(z.string()),
	fixes: z.array(z.string()).optional(),
});

export type ChangelogEntry = z.infer<typeof ChangelogEntrySchema>;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export function readEntries(): ChangelogEntry[] {
	if (!existsSync(ENTRIES_PATH)) {
		mkdirSync(dirname(ENTRIES_PATH), { recursive: true });
		return [];
	}
	const raw = readFileSync(ENTRIES_PATH, "utf-8");
	return z.array(ChangelogEntrySchema).parse(JSON.parse(raw));
}

export function writeEntries(entries: ChangelogEntry[]): void {
	mkdirSync(dirname(ENTRIES_PATH), { recursive: true });
	writeFileSync(ENTRIES_PATH, `${JSON.stringify(entries, null, "\t")}\n`, "utf-8");
	canonicalize();
}

/** Apply the same biome pass the pre-commit hook uses, so output matches the committed format. */
function canonicalize(): void {
	try {
		execFileSync(join(process.cwd(), "node_modules/.bin/biome"), ["check", "--write", ENTRIES_PATH], {
			stdio: "pipe",
		});
	} catch {
		// File is valid JSON either way; the pre-commit hook normalizes as a fallback.
	}
}
