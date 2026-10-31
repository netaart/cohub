import { encodeKeyPart, getCacheUserKey } from "$lib/cache/keys";

const STORAGE_PREFIX = "cohub:session-composer-draft:v1";
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type ComposerDraftRecord = {
	text: string;
	updatedAt: number;
};

type ComposerDraftScope =
	| { kind: "new" }
	| { kind: "session"; sessionId: string };

function canUseLocalStorage() {
	return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function safeRemoveItem(key: string) {
	try {
		localStorage.removeItem(key);
	} catch {
		// ignore
	}
}

function isExpired(updatedAt: unknown) {
	return (
		typeof updatedAt !== "number" ||
		!Number.isFinite(updatedAt) ||
		Date.now() - updatedAt > DRAFT_TTL_MS
	);
}

export function sessionComposerDraftKey(
	spaceId: string,
	scope: ComposerDraftScope,
) {
	const scopeKey = scope.kind === "new" ? "new" : `session:${scope.sessionId}`;
	return [STORAGE_PREFIX, getCacheUserKey(), spaceId, scopeKey]
		.map(encodeKeyPart)
		.join(":");
}

export function readSessionComposerDraftText(key: string) {
	if (!canUseLocalStorage()) return "";
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return "";
		const record = JSON.parse(raw) as Partial<ComposerDraftRecord>;
		if (isExpired(record.updatedAt)) {
			safeRemoveItem(key);
			return "";
		}
		return typeof record.text === "string" ? record.text : "";
	} catch {
		safeRemoveItem(key);
		return "";
	}
}

export function writeSessionComposerDraftText(key: string, text: string) {
	if (!canUseLocalStorage()) return;
	try {
		if (!text.trim()) {
			safeRemoveItem(key);
			return;
		}
		const record: ComposerDraftRecord = {
			text,
			updatedAt: Date.now(),
		};
		localStorage.setItem(key, JSON.stringify(record));
	} catch {
		// localStorage may be unavailable or full; runtime state remains authoritative.
	}
}

export function removeSessionComposerDraftText(key: string | null) {
	if (!key || !canUseLocalStorage()) return;
	safeRemoveItem(key);
}

type CreateRoleDraft = {
	texts: Record<string, string>;
	parameters: Record<string, unknown>;
};

type CreateRoleDraftRecord = CreateRoleDraft & { updatedAt: number };

function createRoleDraftKey(spaceId: string, model: string) {
	return ["cohub:create-role-draft:v1", getCacheUserKey(), spaceId, model]
		.map(encodeKeyPart)
		.join(":");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Role boxes of a structured-input model, kept per space and model rather than
 * per session: they are filled before any session exists.
 */
export function readCreateRoleDraft(
	spaceId: string,
	model: string,
): CreateRoleDraft {
	const empty: CreateRoleDraft = { texts: {}, parameters: {} };
	if (!canUseLocalStorage()) return empty;
	const key = createRoleDraftKey(spaceId, model);
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return empty;
		const record = JSON.parse(raw) as Partial<CreateRoleDraftRecord>;
		if (isExpired(record.updatedAt)) {
			safeRemoveItem(key);
			return empty;
		}
		const texts = isPlainRecord(record.texts)
			? Object.fromEntries(
					Object.entries(record.texts).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: {};
		return {
			texts,
			parameters: isPlainRecord(record.parameters) ? record.parameters : {},
		};
	} catch {
		safeRemoveItem(key);
		return empty;
	}
}

export function writeCreateRoleDraft(
	spaceId: string,
	model: string,
	draft: CreateRoleDraft,
) {
	if (!canUseLocalStorage()) return;
	const key = createRoleDraftKey(spaceId, model);
	try {
		const hasContent =
			Object.values(draft.texts).some((text) => text.trim()) ||
			Object.keys(draft.parameters).length > 0;
		if (!hasContent) {
			safeRemoveItem(key);
			return;
		}
		const record: CreateRoleDraftRecord = { ...draft, updatedAt: Date.now() };
		localStorage.setItem(key, JSON.stringify(record));
	} catch {
		// localStorage may be unavailable or full; runtime state remains authoritative.
	}
}
