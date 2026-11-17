import type { AuthSessionSnapshot } from "#lib/auth-refresh-coordinator.ts";

export type UnauthorizedRecoveryDecision =
	| {
			action: "recover";
			reason: "matching_credential" | "failed_empty_resolution";
			expectedGeneration: number;
			rejectedToken: string | null;
	  }
	| {
			action: "ignore";
			reason: "stale_generation" | "credential_mismatch";
	  };

/**
 * Decide whether a final API 401 still belongs to the current browser session.
 * A failed token lookup deliberately retains the previous token as a guarded
 * session identity, even though the rejected request itself was anonymous.
 */
export function decideUnauthorizedRecovery(input: {
	snapshot: AuthSessionSnapshot;
	rejectedGeneration: number;
	matchesRejectedToken(candidate: string | null | undefined): boolean;
}): UnauthorizedRecoveryDecision {
	const { snapshot, rejectedGeneration, matchesRejectedToken } = input;
	if (snapshot.generation !== rejectedGeneration) {
		return { action: "ignore", reason: "stale_generation" };
	}

	if (matchesRejectedToken(snapshot.token)) {
		return {
			action: "recover",
			reason: "matching_credential",
			expectedGeneration: rejectedGeneration,
			rejectedToken: snapshot.token,
		};
	}

	if (!snapshot.lastResolutionSucceeded && matchesRejectedToken(null)) {
		return {
			action: "recover",
			reason: "failed_empty_resolution",
			expectedGeneration: rejectedGeneration,
			rejectedToken: snapshot.token,
		};
	}

	return { action: "ignore", reason: "credential_mismatch" };
}
