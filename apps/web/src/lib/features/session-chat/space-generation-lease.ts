/**
 * Process-wide lease for space-scoped generation store ownership.
 * Multiple chat hosts in the same space share generation state; only the last
 * host to leave a space may release its generation memory.
 *
 * Callers must not release more times than they acquired. Prefer host-local
 * `leasedSpaceId` tracking so dispose + enterSpace cannot double-release.
 * Under-release is also safe: count already 0 is a no-op (never resets).
 */
const leases = new Map<string, number>();

type LastReleaseHandler = (spaceId: string) => void;

let onLastRelease: LastReleaseHandler | null = null;

export function setSpaceGenerationLastReleaseHandler(
	handler: LastReleaseHandler | null,
) {
	onLastRelease = handler;
}

export function acquireSpaceGeneration(spaceId: string) {
	if (!spaceId) return;
	leases.set(spaceId, (leases.get(spaceId) ?? 0) + 1);
}

/**
 * Release one host's claim on a space. The last host releases generation memory
 * only; persisted recovery snapshots remain.
 * Releasing a space that is not leased is a no-op (never resets).
 */
export function releaseSpaceGeneration(spaceId: string) {
	if (!spaceId) return;
	const current = leases.get(spaceId);
	// Never acquired, or already fully released — do not reset.
	if (!current) return;
	if (current > 1) {
		leases.set(spaceId, current - 1);
		return;
	}
	leases.delete(spaceId);
	onLastRelease?.(spaceId);
}

export function getSpaceGenerationLeaseCount(spaceId: string) {
	return leases.get(spaceId) ?? 0;
}

/** Test helper: clear leases and optionally replace the last-release hook. */
export function __resetSpaceGenerationLeaseForTests(
	nextOnLastRelease?: LastReleaseHandler | null,
) {
	leases.clear();
	onLastRelease = nextOnLastRelease === undefined ? null : nextOnLastRelease;
}
