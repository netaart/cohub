import type { SpaceAccessPolicy } from "@neta-art/cohub";
import { copyTextToClipboard } from "#lib/clipboard.ts";
import { sdk } from "#lib/sdk.ts";
import { buildSpaceSessionRoute } from "#lib/space-routes.ts";

function sessionShareUrl(spaceId: string, targetSessionId: string): string {
	return `${window.location.origin}${buildSpaceSessionRoute(spaceId, targetSessionId)}`;
}

const PUBLIC_POLICY: SpaceAccessPolicy = {
	signed_in_user: null,
	anonymous_user: "guest",
};

export function createSessionShareController(options: {
	getSpaceId: () => string;
	canManageAccess: () => boolean;
}) {
	let open = $state(false);
	let sessionId = $state<string | null>(null);
	let copied = $state(false);
	let error = $state("");
	let saving = $state(false);
	let loadingAccess = $state(false);
	let accessById = $state<Record<string, SpaceAccessPolicy | null>>({});
	let copiedTimer: ReturnType<typeof setTimeout> | null = null;
	let accessLoadToken = 0;

	function clearCopiedTimer() {
		if (!copiedTimer) return;
		clearTimeout(copiedTimer);
		copiedTimer = null;
	}

	function markCopied() {
		copied = true;
		clearCopiedTimer();
		copiedTimer = setTimeout(() => {
			copied = false;
			copiedTimer = null;
		}, 2000);
	}

	function hasPermission(targetSessionId: string): boolean {
		const access = accessById[targetSessionId];
		return Boolean(access?.signed_in_user || access?.anonymous_user);
	}

	async function loadAccess(targetSessionId: string) {
		const token = ++accessLoadToken;
		loadingAccess = true;
		try {
			const policy = await sdk.sessionAccess.get(targetSessionId);
			if (token !== accessLoadToken) return;
			const isPublic = Boolean(policy.signed_in_user || policy.anonymous_user);
			accessById = {
				...accessById,
				[targetSessionId]: isPublic ? policy : null,
			};
		} catch (err) {
			console.error("Failed to load session access:", err);
			if (token === accessLoadToken) {
				error =
					err instanceof Error ? err.message : "Failed to load share status";
			}
		} finally {
			if (token === accessLoadToken) loadingAccess = false;
		}
	}

	async function removeAccess(targetSessionId: string) {
		if (!options.canManageAccess()) return;
		try {
			await sdk.sessionAccess.remove(targetSessionId);
			accessById = { ...accessById, [targetSessionId]: null };
		} catch (err) {
			console.error("Failed to remove session access:", err);
			throw err;
		}
	}

	function openFor(targetSessionId: string) {
		if (!options.canManageAccess()) return;
		sessionId = targetSessionId;
		open = true;
		copied = false;
		error = "";
		void loadAccess(targetSessionId);
	}

	function close() {
		open = false;
	}

	async function copyLink() {
		if (!sessionId) return;
		error = "";
		try {
			const url = sessionShareUrl(options.getSpaceId(), sessionId);
			await copyTextToClipboard(url);
			markCopied();
		} catch (err) {
			error = err instanceof Error ? err.message : "Failed to copy link";
		}
	}

	/**
	 * Toggle public link access. Stays open so the user can keep copying the URL
	 * and inspect the current state.
	 */
	async function setPublic(next: boolean) {
		if (!sessionId || !options.canManageAccess()) return;
		if (loadingAccess || saving) return;
		if (hasPermission(sessionId) === next) return;

		error = "";
		saving = true;
		const targetSessionId = sessionId;
		const previous = accessById[targetSessionId] ?? null;

		// Optimistic UI for instant feedback on the switch.
		accessById = {
			...accessById,
			[targetSessionId]: next ? PUBLIC_POLICY : null,
		};

		try {
			if (next) {
				const policy = await sdk.sessionAccess.set(targetSessionId, {
					anonymous_user: "guest",
				});
				accessById = {
					...accessById,
					[targetSessionId]: {
						signed_in_user: policy.signed_in_user ?? null,
						anonymous_user: policy.anonymous_user ?? "guest",
					},
				};
			} else {
				await sdk.sessionAccess.remove(targetSessionId);
				accessById = { ...accessById, [targetSessionId]: null };
			}
		} catch (err) {
			accessById = { ...accessById, [targetSessionId]: previous };
			error =
				err instanceof Error
					? err.message
					: next
						? "Failed to make session public"
						: "Failed to make session private";
		} finally {
			saving = false;
		}
	}

	function reset() {
		accessLoadToken += 1;
		open = false;
		sessionId = null;
		accessById = {};
		error = "";
		copied = false;
		saving = false;
		loadingAccess = false;
	}

	function dispose() {
		clearCopiedTimer();
		accessLoadToken += 1;
	}

	return {
		get open() {
			return open;
		},
		get sessionId() {
			return sessionId;
		},
		get shareUrl() {
			if (!sessionId) return "";
			return sessionShareUrl(options.getSpaceId(), sessionId);
		},
		get copied() {
			return copied;
		},
		get error() {
			return error;
		},
		get saving() {
			return saving;
		},
		get loadingAccess() {
			return loadingAccess;
		},
		get isCurrentPublic() {
			return sessionId ? hasPermission(sessionId) : false;
		},
		hasPermission,
		removeAccess,
		openFor,
		close,
		copyLink,
		setPublic,
		reset,
		dispose,
	};
}
