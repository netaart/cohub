import {
	isHttpErrorCode,
	type SpaceFsEntry,
	type SpaceFsTreePage,
} from "@neta-art/cohub";

export type DirectoryListing = { entries: SpaceFsEntry[]; truncated: boolean };

const DIRECTORY_RETRY_DELAYS = [100, 250] as const;

export async function readDirectoryPages(
	readPage: (cursor?: string) => Promise<SpaceFsTreePage>,
	onFirstPage?: (entries: SpaceFsEntry[]) => void,
): Promise<DirectoryListing> {
	let shown = false;
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await readDirectoryAttempt(readPage, (entries) => {
				if (shown) return;
				shown = true;
				onFirstPage?.(entries);
			});
		} catch (error) {
			const delay = DIRECTORY_RETRY_DELAYS[attempt];
			if (!isHttpErrorCode(error, "directory_changed") || delay === undefined)
				throw error;
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
