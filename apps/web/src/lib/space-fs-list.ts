import {
	isHttpErrorCode,
	type SpaceFsEntry,
	type SpaceFsTreePage,
} from "@neta-art/cohub";

export type DirectoryListing = { entries: SpaceFsEntry[]; truncated: boolean };

const DIRECTORY_RETRY_DELAYS = [100, 250] as const;
// A cold local sandbox connect can outlast one request; ride it out silently.
const SANDBOX_OFFLINE_GRACE_MS = 15_000;

export async function readDirectoryPages(
	readPage: (cursor?: string) => Promise<SpaceFsTreePage>,
	onFirstPage?: (entries: SpaceFsEntry[]) => void,
): Promise<DirectoryListing> {
	let shown = false;
	let conflicts = 0;
	let offlineRetries = 0;
	const startedAt = Date.now();
	for (;;) {
		try {
			return await readDirectoryAttempt(readPage, (entries) => {
				if (shown) return;
				shown = true;
				onFirstPage?.(entries);
			});
		} catch (error) {
			let delay: number | undefined;
			if (isHttpErrorCode(error, "directory_changed"))
				delay = DIRECTORY_RETRY_DELAYS[conflicts++];
			else if (isHttpErrorCode(error, "sandbox_offline")) {
				const next = Math.min(500 * 2 ** offlineRetries++, 4_000);
				if (Date.now() + next - startedAt <= SANDBOX_OFFLINE_GRACE_MS)
					delay = next;
			}
			if (delay === undefined) throw error;
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

async function readDirectoryAttempt(
	readPage: (cursor?: string) => Promise<SpaceFsTreePage>,
	onFirstPage: (entries: SpaceFsEntry[]) => void,
): Promise<DirectoryListing> {
	const entries = new Map<string, SpaceFsEntry>();
	const seen = new Set<string>();
	let cursor: string | undefined;
	let truncated = false;
	do {
		const page = await readPage(cursor);
		for (const entry of page.entries) entries.set(entry.path, entry);
		truncated ||= page.truncated;
		if (page.entries.length > 0 && page.nextCursor) onFirstPage(page.entries);
		if (page.nextCursor && seen.has(page.nextCursor))
			throw new Error("Server returned a repeated directory cursor.");
		if (page.nextCursor) seen.add(page.nextCursor);
		cursor = page.nextCursor ?? undefined;
	} while (cursor);
	const rank = { dir: 0, symlink: 1, file: 2 };
	return {
		entries: [...entries.values()].sort(
			(a, b) => rank[a.type] - rank[b.type] || a.name.localeCompare(b.name),
		),
		truncated,
	};
}
