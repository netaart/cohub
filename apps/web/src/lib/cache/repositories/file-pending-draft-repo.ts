import {
	type FilePendingDraftCacheRecord,
	idbDelete,
	idbGet,
	idbPut,
} from "#lib/cache/db.ts";
import { filePendingDraftKey, getCacheUserKey } from "#lib/cache/keys.ts";

export type FilePendingDraft = {
	spaceId: string;
	path: string;
	draft: string;
	baseContent: string;
	baseMtimeMs: number;
	baseSize: number;
	mutationId: string;
};

export async function writeFilePendingDraft(input: FilePendingDraft) {
	const userKey = getCacheUserKey();
	const key = filePendingDraftKey(userKey, input.spaceId, input.path);
	const existing = await idbGet<FilePendingDraftCacheRecord>(
		"file_pending_drafts",
		key,
	);
	const now = Date.now();
	const record: FilePendingDraftCacheRecord = {
		key,
		userKey,
		spaceId: input.spaceId,
		path: input.path,
		draft: input.draft,
		baseContent: input.baseContent,
		baseMtimeMs: input.baseMtimeMs,
		baseSize: input.baseSize,
		mutationId: input.mutationId,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	};
	await idbPut("file_pending_drafts", record);
	return record;
}

export function readFilePendingDraft(spaceId: string, path: string) {
	return idbGet<FilePendingDraftCacheRecord>(
		"file_pending_drafts",
		filePendingDraftKey(getCacheUserKey(), spaceId, path),
	);
}

export function deleteFilePendingDraft(spaceId: string, path: string) {
	return idbDelete(
		"file_pending_drafts",
		filePendingDraftKey(getCacheUserKey(), spaceId, path),
	);
}
