import type { IdTokenClaims } from "@logto/browser";
import {
	HttpError,
	matchesUnauthorizedErrorToken,
	type UserProfile,
} from "@neta-art/cohub";
import {
	clearBrokenAuthSession,
	getAuthSessionSnapshot,
	getAuthToken,
	getCurrentIdTokenClaims,
	getHostSessionIdentity,
	hasRecoverableAuthSession,
	setSessionHint,
} from "$lib/auth";
import { sdk } from "$lib/sdk";
import {
	clearCachedMeProfile,
	getCachedMeProfile,
	setCachedMeProfile,
} from "$lib/stores/me-profile-cache";

type RestoredAuthSession = {
	isAuthenticated: boolean;
	claims: IdTokenClaims | null;
	userUuid: string | null;
	profile: UserProfile | null;
	email: string | null;
};

const unauthenticatedSession = (): RestoredAuthSession => ({
	isAuthenticated: false,
	claims: null,
	userUuid: null,
	profile: null,
	email: null,
});

const restoreAuthSession = async (
	onProfileUpdate?: (session: RestoredAuthSession) => void,
	options?: { refreshInBackground?: boolean },
): Promise<RestoredAuthSession> => {
	if (!(await hasRecoverableAuthSession())) {
		return unauthenticatedSession();
	}

	const tokenStart = getAuthSessionSnapshot();
	const token = await getAuthToken();
	if (!token) {
		await clearBrokenAuthSession({
			expectedGeneration: tokenStart.generation,
			rejectedToken: tokenStart.token,
		});
		return unauthenticatedSession();
	}

	const claims = await getCurrentIdTokenClaims();
	const subject = typeof claims?.sub === "string" ? claims.sub : null;
	let userUuid: string | null = null;
	let profile: UserProfile | null = null;
	let email: string | null = null;

	// Session restore must not trigger global sign-in redirects — callers
	// decide whether to prompt login. skipUnauthorizedHandler keeps transport
	// from racing with clearBrokenAuthSession via onUnauthorized.
	const meOptions = { skipUnauthorizedHandler: true as const };

	const cached = getCachedMeProfile(subject);
	if (cached) {
		userUuid = cached.uuid ?? null;
		profile = cached.profile ?? null;
		email = cached.email ?? null;
		const cachedSession = {
			isAuthenticated: true,
			claims,
			userUuid,
			profile,
			email,
		};
		onProfileUpdate?.(cachedSession);
		if (options?.refreshInBackground) {
			void sdk.user
				.getMe(meOptions)
				.then((me) => {
					setCachedMeProfile(subject, me);
					onProfileUpdate?.({
						isAuthenticated: true,
						claims,
						userUuid: me.uuid ?? null,
						profile: me.profile ?? null,
						email: me.email ?? null,
					});
				})
				.catch((error) => {
					if (error instanceof HttpError && error.status === 401) {
						clearCachedMeProfile(subject);
						console.warn(
							"[auth] Background current user profile refresh was unauthorized; keeping the recoverable auth session.",
						);
						return;
					}
					console.warn("[auth] Failed to refresh current user profile:", error);
				});
			return cachedSession;
		}
	}

	try {
		const me = await sdk.user.getMe(meOptions);
		userUuid = me.uuid ?? null;
		profile = me.profile ?? null;
		email = me.email ?? null;
		setCachedMeProfile(subject, me);
	} catch (error) {
		if (error instanceof HttpError && error.status === 401) {
			clearCachedMeProfile(subject);
			const current = getAuthSessionSnapshot();
			const rejectedGeneration =
				typeof error.authSessionVersion === "number"
					? error.authSessionVersion
					: current.generation;
			const tokenMatches = matchesUnauthorizedErrorToken(error, current.token);
			if (current.generation === rejectedGeneration && tokenMatches !== false) {
				await clearBrokenAuthSession({
					expectedGeneration: rejectedGeneration,
					rejectedToken: tokenMatches ? current.token : token,
				});
			}
			return unauthenticatedSession();
		}
		console.warn("[auth] Failed to load current user profile:", error);
	}

	return {
		isAuthenticated: true,
		claims,
		userUuid,
		profile,
		email,
	};
};

class AuthStore {
	claims = $state<IdTokenClaims | null>(null);
	isAuthenticated = $state(false);
	loaded = $state(false);
	loading = $state(false);

	// userUuid from backend API (/api/me), used for ownership checks
	// against space.userUuid, session ownership, etc.
	_userUuid = $state<string | null>(null);
	profile = $state<UserProfile | null>(null);
	email = $state<string | null>(null);
	/**
	 * Cache-partition subject reported by a native host, used only when ID token
	 * claims are unavailable. Null in a browser, where `claims.sub` covers it.
	 */
	hostSubjectKey = $state<string | null>(null);

	// Shared promise for in-flight ensureLoaded calls so concurrent callers all wait
	private _loadPromise: Promise<void> | null = null;

	get userUuid(): string | null {
		return this._userUuid;
	}

	async ensureLoaded(force = false) {
		if (this.loaded && !force) return;
		if (this.loading && this._loadPromise) return this._loadPromise;

		this.loading = true;
		this._loadPromise = (async () => {
			try {
				// Resolve the host identity before any session restore: the cache
				// partition key is read synchronously during restore, and a hosted
				// surface has no ID token claims to fall back on.
				this.hostSubjectKey =
					(await getHostSessionIdentity())?.subjectKey ?? null;
				const applySession = (restored: RestoredAuthSession) => {
					this.isAuthenticated = restored.isAuthenticated;
					this.claims = restored.claims;
					this._userUuid = restored.userUuid;
					this.profile = restored.profile;
					this.email = restored.email;
					this.loaded = true;
					setSessionHint(restored.isAuthenticated);
				};
				const restored = await restoreAuthSession(applySession, {
					refreshInBackground: !force,
				});
				applySession(restored);
			} finally {
				this.loading = false;
				this._loadPromise = null;
			}
		})();

		return this._loadPromise;
	}

	async updateProfile(input: {
		displayName?: string;
		avatarUrl?: string | null;
		username?: string | null;
	}) {
		const { profile } = await sdk.user.updateProfile(input);
		this.profile = profile;
		if (this._userUuid) {
			setCachedMeProfile(this.claims?.sub, {
				uuid: this._userUuid,
				profile,
				email: this.email,
			});
		}
		return profile;
	}

	reset() {
		clearCachedMeProfile(this.claims?.sub);
		setSessionHint(false);
		this.claims = null;
		this.hostSubjectKey = null;
		this.isAuthenticated = false;
		this.loaded = false;
		this.loading = false;
		this._userUuid = null;
		this.profile = null;
		this.email = null;
		this._loadPromise = null;
	}
}

export const authStore = new AuthStore();
