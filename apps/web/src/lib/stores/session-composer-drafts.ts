import { encodeKeyPart, getCacheUserKey } from "#lib/cache/keys.ts";

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
