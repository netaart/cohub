import LogtoClient, { type IdTokenClaims } from "@logto/browser";
import {
	type AuthSessionSnapshot,
	type AuthTokenRequestOptions,
	type ClearBrokenSessionOptions,
	createAuthRefreshCoordinator,
} from "$lib/auth-refresh-coordinator";
import { callHost, hostOwnsCredentials, readyHost } from "$lib/host-bridge";

const IS_DEV =
	(typeof location !== "undefined" && location.hostname.startsWith("dev")) ||
	Boolean(import.meta.env?.DEV);

/**
 * Official hosted defaults. Self-hosted deployments should override via
 * PUBLIC_LOGTO_ENDPOINT / PUBLIC_LOGTO_APP_ID / PUBLIC_LOGTO_API_RESOURCE.
 */
const OFFICIAL = IS_DEV
	? {
			endpoint: "https://dev-auth.neta.art/",
			appId: "vpikk7sl9zwvefiptowtn",
			resource: "https://api.talesofai",
		}
	: {
			endpoint: "https://auth.neta.art/",
			appId: "16ai0wao2mud3xqkbzqo0",
			resource: "https://api.talesofai",
		};

export const API_RESOURCE =
	import.meta.env?.PUBLIC_LOGTO_API_RESOURCE?.trim() || OFFICIAL.resource;

const LOGTO_ENDPOINT =
	import.meta.env?.PUBLIC_LOGTO_ENDPOINT?.trim() || OFFICIAL.endpoint;

const LOGTO_APP_ID =
	import.meta.env?.PUBLIC_LOGTO_APP_ID?.trim() || OFFICIAL.appId;

/**
 * Lazy browser-only client. Safe to import on the server; construction and
 * method access only happen in the browser.
 */
let logtoClientInstance: LogtoClient | null = null;

function getLogtoClient(): LogtoClient {
	if (typeof window === "undefined") {
		throw new Error("Logto client is only available in the browser");
	}
	if (!logtoClientInstance) {
		logtoClientInstance = new LogtoClient({
			endpoint: LOGTO_ENDPOINT,
			appId: LOGTO_APP_ID,
			scopes: ["openid", "offline_access", "profile", "email"],
			resources: [API_RESOURCE],
		});
	}
	return logtoClientInstance;
}

export const logtoClient: LogtoClient = new Proxy({} as LogtoClient, {
	get(_target, property, _receiver) {
		const client = getLogtoClient();
		const value = Reflect.get(client, property, client);
		return typeof value === "function"
			? (value as (...args: unknown[]) => unknown).bind(client)
			: value;
	},
	set(_target, property, value) {
		const client = getLogtoClient();
		return Reflect.set(client, property, value, client);
	},
});

export const AUTH_TOKEN_STORAGE_KEY = "cohub_token";
const AUTH_SESSION_SNAPSHOT_STORAGE_KEY = "cohub:auth-session:v1";
/** Lightweight flag for first-paint home redirect (not an auth token). */
export const SESSION_HINT_STORAGE_KEY = "cohub:session-hint";
/** Set after OAuth callback succeeds; used to break silent SSO redirect loops. */
export const AUTH_JUST_COMPLETED_KEY = "cohub:auth-just-completed";
const AUTH_JUST_COMPLETED_TTL_MS = 30_000;
const AUTH_REFRESH_LOCK_NAME = `cohub:logto-token:${LOGTO_APP_ID}`;
const OPAQUE_TOKEN_RECHECK_MS = 30_000;
const TOKEN_EXPIRY_SKEW_MS = 1_000;

function hasLogtoSessionResidue(): boolean {
	if (typeof localStorage === "undefined") return false;
	try {
		// Logto BrowserStorage keys: logto:<appId>:<item>
		const prefix = `logto:${LOGTO_APP_ID}:`;
		return Boolean(
			localStorage.getItem(`${prefix}refreshToken`) ||
				localStorage.getItem(`${prefix}idToken`),
		);
	} catch {
		return false;
	}
}

/**
 * Sync, best-effort signal that a browser session may exist.
 * Used to avoid marketing-page flash before auth finishes hydrating.
 * Never treat this as authenticated — always confirm with ensureLoaded().
 */
export function hasLocalSessionHint(): boolean {
	if (typeof window === "undefined" || typeof localStorage === "undefined") {
		return false;
	}
	try {
		if (localStorage.getItem(SESSION_HINT_STORAGE_KEY) === "1") return true;
		const cached = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)?.trim();
		if (cached) {
			setSessionHint(true);
			return true;
		}
		if (hasLogtoSessionResidue()) {
			setSessionHint(true);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

export function setSessionHint(active: boolean) {
	if (typeof localStorage === "undefined") return;
	try {
		if (active) localStorage.setItem(SESSION_HINT_STORAGE_KEY, "1");
		else localStorage.removeItem(SESSION_HINT_STORAGE_KEY);
	} catch {
		// ignore quota / private mode
	}
}

export function markAuthJustCompleted() {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.setItem(AUTH_JUST_COMPLETED_KEY, String(Date.now()));
	} catch {
		// ignore quota / private mode
	}
}

export function hasRecentAuthCompletion(
	ttlMs = AUTH_JUST_COMPLETED_TTL_MS,
): boolean {
	if (typeof sessionStorage === "undefined") return false;
	try {
		const raw = sessionStorage.getItem(AUTH_JUST_COMPLETED_KEY);
		if (!raw) return false;
		const ts = Number(raw);
		return Number.isFinite(ts) && Date.now() - ts < ttlMs;
	} catch {
		return false;
	}
}

export function clearAuthJustCompleted() {
	if (typeof sessionStorage === "undefined") return;
	try {
		sessionStorage.removeItem(AUTH_JUST_COMPLETED_KEY);
	} catch {
		// ignore
	}
}

const isAuthEndpointPath = (pathname: string) =>
	pathname === "/callback" ||
	pathname.startsWith("/callback/") ||
	pathname === "/app-auth" ||
	pathname.startsWith("/app-auth/");

/**
 * Keep post-login destinations same-app and off auth endpoints.
 * Accepts relative paths (`/foo?x=1#h`) or same-origin absolute URLs.
 * Rejects protocol-relative (`//…`), backslashes, and open redirects.
 */
export function sanitizeRedirectPath(path?: string | null): string {
	if (!path) return "/";
	const trimmed = path.trim();
	if (!trimmed) return "/";

	try {
		// Relative app path: "/spaces/new?x=1#section"
		if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
			if (trimmed.includes("\\")) return "/";
			const url = new URL(trimmed, "http://local.invalid");
			if (isAuthEndpointPath(url.pathname)) return "/";
			return `${url.pathname}${url.search}${url.hash}` || "/";
		}

		// Absolute URL — only same-origin when running in the browser.
		if (typeof window === "undefined") return "/";
		const url = new URL(trimmed, window.location.origin);
		if (url.origin !== window.location.origin) return "/";
		if (isAuthEndpointPath(url.pathname)) return "/";
		return `${url.pathname}${url.search}${url.hash}` || "/";
	} catch {
		return "/";
	}
}

function sanitizeClientToken(token: string | null | undefined): string | null {
	if (typeof token !== "string") return null;
	const cleaned = token.replace(/[\r\n\t\0]/g, "").trim();
	return cleaned.length > 0 ? cleaned : null;
}

type LogtoClientWithRefreshFallback = {
	getAccessTokenByRefreshToken?: (resource?: string) => Promise<string>;
};

async function resolveLogtoAccessToken(forceRefresh: boolean) {
	const client = getLogtoClient();
	if (forceRefresh) await client.clearAccessToken();
	if (await client.isAuthenticated()) {
		return client.getAccessToken(API_RESOURCE);
	}

	// Logto's public API requires an ID token. Preserve origin/main's private
	// fallback only for the recoverable missing-ID-token case.
	const refreshToken = await client.getRefreshToken().catch(() => null);
	if (!refreshToken) return null;

	const refreshWithToken = (client as unknown as LogtoClientWithRefreshFallback)
		.getAccessTokenByRefreshToken;
	if (typeof refreshWithToken !== "function") {
		console.warn(
			"[auth] Logto refresh-token fallback is unavailable; upgrade auth integration before relying on missing-ID-token recovery.",
		);
		return null;
	}
	return refreshWithToken.call(client, API_RESOURCE);
}

function readLegacyAuthToken(): string | null {
	if (typeof localStorage === "undefined") return null;
	try {
		return sanitizeClientToken(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY));
	} catch {
		return null;
	}
}

export function getAuthSessionSnapshot(): AuthSessionSnapshot {
	const fallback = {
		generation: 0,
		attempt: 0,
		token: readLegacyAuthToken(),
		updatedAt: 0,
		lastResolutionSucceeded: false,
	};
	if (typeof localStorage === "undefined") return fallback;

	try {
		const raw = localStorage.getItem(AUTH_SESSION_SNAPSHOT_STORAGE_KEY);
		if (!raw) return fallback;
		const parsed = JSON.parse(raw) as Partial<AuthSessionSnapshot>;
		if (
			!Number.isSafeInteger(parsed.generation) ||
			(parsed.generation ?? -1) < 0 ||
			!Number.isSafeInteger(parsed.attempt) ||
			(parsed.attempt ?? -1) < 0 ||
			!Number.isFinite(parsed.updatedAt) ||
			(parsed.updatedAt ?? -1) < 0 ||
			typeof parsed.lastResolutionSucceeded !== "boolean" ||
			(parsed.token !== null && typeof parsed.token !== "string")
		) {
			return fallback;
		}
		return {
			generation: parsed.generation as number,
			attempt: parsed.attempt as number,
			token: sanitizeClientToken(parsed.token) ?? null,
			updatedAt: parsed.updatedAt as number,
			lastResolutionSucceeded: parsed.lastResolutionSucceeded,
		};
	} catch {
		return fallback;
	}
}

function writeAuthSessionSnapshot(snapshot: AuthSessionSnapshot) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(
			AUTH_SESSION_SNAPSHOT_STORAGE_KEY,
			JSON.stringify(snapshot),
		);
		if (snapshot.token) {
			localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, snapshot.token);
		} else {
			localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
		}
	} catch {
		// Storage can be unavailable in private browsing. The coordinator still
		// provides same-page single-flight behavior in that case.
	}
}

function nextGeneration(current: number) {
	return Number.isSafeInteger(current) && current < Number.MAX_SAFE_INTEGER
		? current + 1
		: 1;
}

function commitTokenResolution(token: string | null, forceRefresh: boolean) {
	const current = getAuthSessionSnapshot();
	if (
		token &&
		!forceRefresh &&
		token === current.token &&
		current.lastResolutionSucceeded
	) {
		return;
	}
	writeAuthSessionSnapshot({
		generation:
			token &&
			(forceRefresh ||
				token !== current.token ||
				!current.lastResolutionSucceeded)
				? nextGeneration(current.generation)
				: current.generation,
		attempt: nextGeneration(current.attempt),
		token: token ?? current.token,
		updatedAt: token ? Date.now() : current.updatedAt,
		lastResolutionSucceeded: token !== null,
	});
	if (token) setSessionHint(true);
}

function decodeJwtExpiry(token: string): number | null {
	const payload = token.split(".")[1];
	if (!payload || typeof atob === "undefined") return null;
	try {
		const padded = payload
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(payload.length / 4) * 4, "=");
		const parsed = JSON.parse(atob(padded)) as { exp?: unknown };
		return typeof parsed.exp === "number" && Number.isFinite(parsed.exp)
			? parsed.exp * 1_000
			: null;
	} catch {
		return null;
	}
}

function isReusableAuthSnapshot(snapshot: AuthSessionSnapshot) {
	if (
		!snapshot.token ||
		!snapshot.lastResolutionSucceeded ||
		!hasLogtoSessionResidue()
	) {
		return false;
	}
	const expiresAt = decodeJwtExpiry(snapshot.token);
	if (expiresAt !== null) return expiresAt > Date.now() + TOKEN_EXPIRY_SKEW_MS;
	return snapshot.updatedAt > Date.now() - OPAQUE_TOKEN_RECHECK_MS;
}

let localAuthLockTail: Promise<void> = Promise.resolve();

const authRefreshLock = {
	async runExclusive<T>(task: () => Promise<T>): Promise<T> {
		const previous = localAuthLockTail;
		let release = () => {};
		localAuthLockTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			if (typeof navigator !== "undefined" && navigator.locks?.request) {
				return await navigator.locks.request(
					AUTH_REFRESH_LOCK_NAME,
					{ mode: "exclusive" },
					task,
				);
			}
			return await task();
		} finally {
			release();
		}
	},
};

const authRefreshCoordinator = createAuthRefreshCoordinator({
	state: {
		read: getAuthSessionSnapshot,
		commitResolution: commitTokenResolution,
		clear: clearAuthToken,
	},
	lock: authRefreshLock,
	isReusable: isReusableAuthSnapshot,
	resolveToken: resolveLogtoAccessToken,
	clearSession: async () => {
		// The host owns the credential store; clearing Logto here would be a
		// no-op that leaves the real session intact.
		if ((await readyHost()) && hostOwnsCredentials()) return;
		try {
			await getLogtoClient().clearAllTokens();
		} catch {
			// Local cleanup remains authoritative if provider cleanup fails.
		}
	},
});

let lastLoggedEmptyResolutionGeneration: number | null = null;

function logEmptyTokenResolution(options?: AuthTokenRequestOptions) {
	const snapshot = getAuthSessionSnapshot();
	const providerSessionPresent = hasLogtoSessionResidue();
	if (
		snapshot.lastResolutionSucceeded ||
		(!snapshot.token && !providerSessionPresent) ||
		lastLoggedEmptyResolutionGeneration === snapshot.generation
	) {
		return;
	}
	lastLoggedEmptyResolutionGeneration = snapshot.generation;
	console.warn(
		"[auth] Access token resolution returned empty for a recoverable session.",
		{
			event: "auth.token_resolution_empty",
			authSessionGeneration: snapshot.generation,
			authSessionAttempt: snapshot.attempt,
			forceRefresh: Boolean(options?.forceRefresh),
			rejectedCredentialProvided: options?.rejectedToken !== undefined,
			cachedCredentialPresent: Boolean(snapshot.token),
			providerSessionPresent,
			visibilityState:
				typeof document === "undefined" ? "unknown" : document.visibilityState,
		},
	);
}

/** Resolve a valid API token without allowing parallel refresh exchanges. */
export const getAuthToken = async (
	options?: AuthTokenRequestOptions,
): Promise<string | null> => {
	if (typeof window === "undefined") return null;
	// Inside a native host the credential lives in the host's encrypted store and
	// is shared by every surface; the web side only asks for it. Refreshing here
	// would race the host's own refresher, so delegate and stop.
	if ((await readyHost()) && hostOwnsCredentials()) {
		try {
			const token = await callHost("auth.getAccessToken", {
				forceRefresh: Boolean(options?.forceRefresh),
			});
			return typeof token === "string" && token.trim() ? token : null;
		} catch (error) {
			console.warn(
				"[auth] Native host failed to resolve an access token:",
				error,
			);
			return null;
		}
	}
	try {
		const token = await authRefreshCoordinator.resolveToken(options);
		if (token) lastLoggedEmptyResolutionGeneration = null;
		else logEmptyTokenResolution(options);
		return token;
	} catch (error) {
		logEmptyTokenResolution(options);
		console.warn("[auth] Failed to resolve access token:", error);
		return null;
	}
};

export const getCurrentIdTokenClaims =
	async (): Promise<IdTokenClaims | null> => {
		if (typeof window === "undefined") return null;
		// The host owns credentials; ID token claims are not exposed. Callers that
		// need an identity key must use the host session instead (see
		// `getHostSessionIdentity`), which also feeds the cache partition key.
		if ((await readyHost()) && hostOwnsCredentials()) return null;
		try {
			return await getLogtoClient().getIdTokenClaims();
		} catch {
			return null;
		}
	};

/**
 * Signed-in identity reported by the native host, or `null` in a browser.
 * Exists because the host does not expose ID token claims, yet the cache
 * partition key still needs a stable, user-scoped value.
 */
export const getHostSessionIdentity = async (): Promise<{
	userUuid: string | null;
	subject: string | null;
	subjectKey: string | null;
} | null> => {
	if (typeof window === "undefined") return null;
	if (!(await readyHost()) || !hostOwnsCredentials()) return null;
	try {
		const session = await callHost("auth.getSession");
		return {
			userUuid: session.userUuid,
			subject: session.subject,
			subjectKey: session.subject ? `sub:${session.subject}` : null,
		};
	} catch (error) {
		console.warn("[auth] Native host failed to report its session:", error);
		return null;
	}
};

export const hasRecoverableAuthSession = async (): Promise<boolean> => {
	if (typeof window === "undefined") return false;
	// A hosted surface has a session exactly when the host says so; probing
	// Logto here would construct a browser client the host never authenticated.
	if ((await readyHost()) && hostOwnsCredentials()) {
		const identity = await getHostSessionIdentity();
		return Boolean(identity && (identity.userUuid || identity.subject));
	}
	const client = getLogtoClient();
	const [hasIdToken, refreshToken] = await Promise.all([
		client.isAuthenticated().catch(() => false),
		client.getRefreshToken().catch(() => null),
	]);

	return hasIdToken || Boolean(refreshToken);
};

export const clearBrokenAuthSession = async (
	options?: ClearBrokenSessionOptions,
): Promise<boolean> => {
	if (typeof window === "undefined") {
		clearAuthToken();
		return true;
	}
	try {
		return await authRefreshCoordinator.clearBrokenSession(options);
	} catch {
		// Lock acquisition or another coordinator-level failure must not be
		// reported as a successful clear.
		return false;
	}
};

export function setAuthToken(token: string) {
	// Keep stored token free of CR/LF so later Authorization headers stay valid
	// (Safari: "The string did not match the expected pattern.").
	const cleaned = sanitizeClientToken(token);
	if (!cleaned) return;
	const current = getAuthSessionSnapshot();
	writeAuthSessionSnapshot({
		generation:
			current.token === cleaned && current.lastResolutionSucceeded
				? current.generation
				: nextGeneration(current.generation),
		attempt: nextGeneration(current.attempt),
		token: cleaned,
		updatedAt: Date.now(),
		lastResolutionSucceeded: true,
	});
	setSessionHint(true);
}

export function clearAuthToken() {
	const current = getAuthSessionSnapshot();
	writeAuthSessionSnapshot({
		generation: nextGeneration(current.generation),
		attempt: nextGeneration(current.attempt),
		token: null,
		updatedAt: Date.now(),
		lastResolutionSucceeded: true,
	});
	// Single source of truth for hint teardown — covers broken-session cleanup
	// and redirectToSignIn({ clearSession }) via clearAuthToken().
	setSessionHint(false);
}

/** Complete the OAuth callback under the refresh/recovery lock. */
export const completeSignInCallback = async (
	callbackUri: string,
): Promise<string | null> =>
	authRefreshCoordinator.runExclusiveMutation(async () => {
		const client = getLogtoClient();
		await client.handleSignInCallback(callbackUri);
		// The callback has replaced the Logto session. Invalidate the previous
		// request generation before resolving its resource access token so a late
		// 401 cannot clear the new session if token resolution fails.
		clearAuthToken();
		const token = sanitizeClientToken(await resolveLogtoAccessToken(false));
		if (token) commitTokenResolution(token, true);
		return token;
	});

const createRedirectState = (redirectPath?: string) => {
	const searchParams = new URLSearchParams();
	if (redirectPath) {
		searchParams.set("redirect_path", sanitizeRedirectPath(redirectPath));
	}
	return searchParams.toString();
};

/**
 * Low-level Logto sign-in for **user-initiated** flows (CTA, ensureAuth, etc.).
 *
 * For automatic 401 recovery always use `redirectToSignIn` — that path owns
 * the post-callback silent-SSO loop breaker. Calling this after a failed API
 * auth check can re-enter Logto with a still-valid SSO cookie and loop.
 */
export const signInWithRedirectPath = async (redirectPath?: string) => {
	const safePath =
		redirectPath === undefined ? undefined : sanitizeRedirectPath(redirectPath);

	// The host owns the credential and the sign-in round trip (system browser +
	// PKCE), so the web side only asks for it. Logto's browser client would keep
	// a second session the host could not see.
	if ((await readyHost()) && hostOwnsCredentials()) {
		await callHost(
			"auth.signIn",
			safePath === undefined ? {} : { redirectPath: safePath },
		);
		return;
	}

	const client = getLogtoClient();
	const originalGenerateState = client.adapter.generateState;

	client.adapter.generateState = () => createRedirectState(safePath);
	try {
		await client.signIn({
			redirectUri: `${window.location.origin}/callback`,
		});
	} finally {
		client.adapter.generateState = originalGenerateState;
	}
};

let hostSignIn: Promise<void> | null = null;

/** The host drops its session when refresh fails; sign in once per page. */
export const recoverHostSession = async (
	redirectPath: string | undefined,
): Promise<void> => {
	if (hostSignIn) return hostSignIn;
	if (await hasRecoverableAuthSession()) return;
	hostSignIn ??= signInWithRedirectPath(redirectPath).catch((error) => {
		console.warn("[auth] Native host failed to start sign-in:", error);
	});
	return hostSignIn;
};

/** Clear and restart only the session whose token was actually rejected. */
export const signInAfterUnauthorized = async (
	redirectPath: string | undefined,
	guard: ClearBrokenSessionOptions,
): Promise<boolean> =>
	authRefreshCoordinator.runGuardedMutation(guard, async () => {
		try {
			await getLogtoClient().clearAllTokens();
		} catch {
			// Continue with local cleanup and a clean authorization round trip.
		}
		clearAuthToken();
		await signInWithRedirectPath(redirectPath);
	});

export const ensureAuth = async (options?: { redirectPath?: string }) => {
	const token = await getAuthToken();
	if (!token) {
		await signInWithRedirectPath(options?.redirectPath);
		return false;
	}
	return true;
};

/**
 * Sign out of the active session, wherever the credential lives.
 *
 * A hosted surface must delegate: the host owns the encrypted store and every
 * other surface in the app shares it. Signing out in the web view alone would
 * leave the app still signed in.
 */
export const signOut = async (): Promise<void> => {
	if (typeof window === "undefined") return;
	if ((await readyHost()) && hostOwnsCredentials()) {
		try {
			await callHost("auth.signOut");
		} catch (error) {
			console.error("[auth] Native host failed to sign out", error);
		}
		return;
	}
	try {
		await getLogtoClient().signOut(`${window.location.origin}/`);
	} catch (error) {
		console.error("[auth] Failed to sign out", error);
	}
};
