import { type ApprovalMode, isApprovalMode } from "@cohub/protocol";
import { encodeKeyPart, getCacheUserKey } from "$lib/cache/keys";

const STORAGE_PREFIX = "cohub:approval-choice:v1";
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** An approval mode chosen but not yet sent outlives a reload, like the draft it goes with. */
export function approvalChoiceKey(
	spaceId: string,
	sessionId: string | null,
	harness: string,
) {
	return [
		STORAGE_PREFIX,
		getCacheUserKey(),
		spaceId,
		sessionId ? `session:${sessionId}` : "new",
		harness,
	]
		.map(encodeKeyPart)
		.join(":");
}

export function readApprovalChoice(key: string): ApprovalMode | null {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		const record = JSON.parse(raw) as { mode?: unknown; updatedAt?: unknown };
		if (
			isApprovalMode(record.mode) &&
			typeof record.updatedAt === "number" &&
			Date.now() - record.updatedAt < TTL_MS
		)
			return record.mode;
		localStorage.removeItem(key);
	} catch {
		// Storage may be unavailable; the Session's recorded mode applies.
	}
	return null;
}

export function writeApprovalChoice(key: string, mode: ApprovalMode | null) {
	try {
		if (mode) {
			localStorage.setItem(
				key,
				JSON.stringify({ mode, updatedAt: Date.now() }),
			);
		} else localStorage.removeItem(key);
	} catch {
		// Storage may be unavailable; the choice stays for this page.
	}
}
