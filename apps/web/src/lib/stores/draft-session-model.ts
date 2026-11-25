// Persists the model the user last manually selected for a new (draft) session,
// so subsequent new sessions reuse it instead of always falling back to the
// catalog default. This is only written on explicit manual selection — if the
// user sends a new session without picking a model, nothing is recorded.
//
// Catalog validation (ensuring the model is still online) is performed by the
// caller when reading, since this helper has no knowledge of the catalog.
import { isModelThinkingLevel, type ModelThinkingLevel } from "@cohub/protocol";
import { encodeKeyPart, getCacheUserKey } from "#lib/cache/keys.ts";

const STORAGE_PREFIX = "cohub:draft-session-model:v1";

export type DraftSessionModel = {
	provider: string;
	id: string;
	thinkingLevel?: ModelThinkingLevel;
};

type DraftSessionModelRecord = DraftSessionModel & { updatedAt: number };

function canUseLocalStorage() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function storageKey() {
	return [STORAGE_PREFIX, getCacheUserKey()].map(encodeKeyPart).join(":");
}

function safeRemoveItem(key: string) {
	try {
		localStorage.removeItem(key);
	} catch {
		// ignore
	}
}

export function saveDraftSessionModel(model: DraftSessionModel) {
	if (!canUseLocalStorage()) return;
	try {
		const record: DraftSessionModelRecord = {
			provider: model.provider,
			id: model.id,
			...(model.thinkingLevel ? { thinkingLevel: model.thinkingLevel } : {}),
			updatedAt: Date.now(),
		};
		localStorage.setItem(storageKey(), JSON.stringify(record));
	} catch {
		// localStorage may be unavailable or full; ignore.
	}
}

export function readDraftSessionModel(): DraftSessionModel | null {
	if (!canUseLocalStorage()) return null;
	try {
		const raw = localStorage.getItem(storageKey());
		if (!raw) return null;
		const record = JSON.parse(raw) as Partial<DraftSessionModelRecord>;
		if (
			typeof record.provider !== "string" ||
			!record.provider.trim() ||
			typeof record.id !== "string" ||
			!record.id.trim()
		) {
			safeRemoveItem(storageKey());
			return null;
		}
		return {
			provider: record.provider,
			id: record.id,
			...(isModelThinkingLevel(record.thinkingLevel)
				? { thinkingLevel: record.thinkingLevel }
				: {}),
		};
	} catch {
		safeRemoveItem(storageKey());
		return null;
	}
}
