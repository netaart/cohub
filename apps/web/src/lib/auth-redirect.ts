import { HttpError, matchesUnauthorizedErrorToken } from "@neta-art/cohub";
import {
	clearAuthJustCompleted,
	clearAuthToken,
	clearBrokenAuthSession,
	getAuthSessionSnapshot,
	hasRecentAuthCompletion,
	sanitizeRedirectPath,
	signInAfterUnauthorized,
	signInWithRedirectPath,
} from "#lib/auth.ts";

export const getCurrentRedirectPath = () => {
	if (typeof window === "undefined") return undefined;
	return sanitizeRedirectPath(
		`${window.location.pathname}${window.location.search}`,
	);
};

type SignInRedirectOptions = {
	clearSession?: boolean;
	expectedGeneration?: number;
	rejectedToken?: string | null;
};

type SignInRedirectAttempt = {
	options: SignInRedirectOptions;
	promise: Promise<void>;
};

let signInRedirectAttempt: SignInRedirectAttempt | null = null;

const isSameRedirectAttempt = (
	left: SignInRedirectOptions,
	right: SignInRedirectOptions,
) =>
	Boolean(left.clearSession) === Boolean(right.clearSession) &&
	left.expectedGeneration === right.expectedGeneration &&
	left.rejectedToken === right.rejectedToken;

/**
 * Start OAuth sign-in. Guards against silent SSO loops after a just-completed
 * callback: if auth finished recently and we still got a 401, clear local
 * session and land on home instead of bouncing through Logto again.
 */
export const redirectToSignIn = async (
	redirectPath = getCurrentRedirectPath(),
	options: SignInRedirectOptions = {},
): Promise<void> => {
	const activeAttempt = signInRedirectAttempt;
	if (activeAttempt) {
		if (isSameRedirectAttempt(activeAttempt.options, options)) {
			return activeAttempt.promise;
		}
		try {
			await activeAttempt.promise;
		} catch {
			// A different session guard still needs its own attempt.
		}
		return redirectToSignIn(redirectPath, options);
	}

	const promise = (async () => {
		const safePath = sanitizeRedirectPath(redirectPath);

		// After callback, another 401 is almost always a broken/misconfigured
		// session — re-entering SSO would infinite-loop with silent login.
		// Always hard-navigate home so in-memory stores drop with the page,
		// even when already on "/" (common post-callback destination).
		if (hasRecentAuthCompletion()) {
			const cleared = await clearBrokenAuthSession({
				expectedGeneration: options.expectedGeneration,
				rejectedToken: options.rejectedToken,
			});
			if (!cleared) return;
			clearAuthJustCompleted();
			if (typeof window !== "undefined") {
				window.location.replace("/");
			}
			return;
		}

		if (options.clearSession) {
			const started = await signInAfterUnauthorized(safePath, {
				expectedGeneration: options.expectedGeneration,
				rejectedToken: options.rejectedToken,
			});
			if (!started) return;
		} else {
			clearAuthToken();
			await signInWithRedirectPath(safePath);
		}
	})().finally(() => {
		if (signInRedirectAttempt?.promise === promise) {
			signInRedirectAttempt = null;
		}
	});
	signInRedirectAttempt = { options, promise };

	return promise;
};

export const handleUnauthorizedError = async (
	error: unknown,
	redirectPath?: string,
): Promise<boolean> => {
	if (!(error instanceof HttpError) || error.status !== 401) return false;
	// HttpTransport's configured handler already performed guarded cleanup and
	// redirect. Do not run an unguarded second cleanup from the page catch path.
	if (error.unauthorizedHandled) return true;
	const current = getAuthSessionSnapshot();
	const rejectedGeneration =
		typeof error.authSessionVersion === "number"
			? error.authSessionVersion
			: current.generation;
	if (current.generation !== rejectedGeneration) return true;
	const tokenMatches = matchesUnauthorizedErrorToken(error, current.token);
	if (tokenMatches === false) return true;
	await redirectToSignIn(redirectPath, {
		clearSession: true,
		...(tokenMatches
			? {
					expectedGeneration: rejectedGeneration,
					rejectedToken: current.token,
				}
			: {}),
	});
	return true;
};
