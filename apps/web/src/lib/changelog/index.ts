import { plainText, truncate } from "#lib/seo.ts";
import rawEntries from "./entries.json";

export interface ChangelogEntry {
	version: string;
	date: string;
	tags: string[];
	highlights: string[];
	fixes?: string[];
}

export const entries: ChangelogEntry[] = rawEntries;

/** Newest entry first; null when the feed is empty. */
export const latestEntry: ChangelogEntry | null = entries[0] ?? null;

/** Short meta description built from the latest release. */
export function changelogDescription(max = 160): string {
	if (!latestEntry) return "What's new in Cohub";
	const lead = latestEntry.highlights[0]
		? plainText(latestEntry.highlights[0])
		: "Release notes and product updates.";
	return truncate(`v${latestEntry.version}: ${lead}`, max);
}
