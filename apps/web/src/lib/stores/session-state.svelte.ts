import type { SessionRecord } from "@neta-art/cohub";

const STORAGE_KEY = "cohub:session_viewed";

/**
 * Track which turn the user has seen per session.
 * Persisted in localStorage so unread state survives page reloads.
 */
class UnreadTracker {
	private viewed = $state(new Map<string, string>());

	constructor() {
		this.restore();
	}

	private restore() {
		try {
			const raw = localStorage.getItem(STORAGE_KEY);
			if (raw) {
				const data = JSON.parse(raw) as Record<string, string>;
				this.viewed = new Map(Object.entries(data));
			}
		} catch {
			// ignore
		}
	}

	private persist() {
		try {
			const data: Record<string, string> = {};
			for (const [sessionId, itemId] of this.viewed) {
				data[sessionId] = itemId;
			}
			localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
		} catch {
			// ignore
		}
	}

	isUnread(
		session: SessionRecord,
		latestItemId: string | null | undefined,
	): boolean {
		if (!latestItemId) return false;
		const seen = this.viewed.get(session.id);
		return seen !== latestItemId;
	}

	markViewed(sessionId: string, latestItemId: string | null | undefined) {
		if (!latestItemId) return;
		// Called from every bottom-follow while streaming; avoid a reactive Map
		// swap + localStorage write when nothing changed.
		if (this.viewed.get(sessionId) === latestItemId) return;
		this.viewed = new Map(this.viewed).set(sessionId, latestItemId);
		this.persist();
	}

	/**
	 * Clear tracked state for a session (e.g. session deleted).
	 */
	clear(sessionId: string) {
		const viewed = new Map(this.viewed);
		viewed.delete(sessionId);
		this.viewed = viewed;
		this.persist();
	}
}

export const unreadTracker = new UnreadTracker();
