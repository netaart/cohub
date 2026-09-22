import type { RuntimeStatus } from "@neta-art/cohub";

/**
 * Presentation model for a Space Runtime.
 *
 * The header chip and the composer read the same tone/watcher rules so a
 * degraded or disconnected Runtime looks identical everywhere; only the copy
 * lives in the components.
 */

/** `attention` means online but its file monitoring is degraded. */
export type RuntimeTone = "online" | "attention" | "offline" | "unknown";
export type RuntimeWatcher = NonNullable<RuntimeStatus["fileWatcher"]>;

/** File-watcher telemetry older than this is treated as unknown. */
export const RUNTIME_WATCHER_FRESHNESS_MS = 60_000;

/** Whether a heartbeat/telemetry timestamp is missing or expired. */
export function isStale(
	observedAt: string,
	now: number,
	maxAgeMs = RUNTIME_WATCHER_FRESHNESS_MS,
): boolean {
	const at = Date.parse(observedAt);
	return !Number.isFinite(at) || now - at >= maxAgeMs || at - now > maxAgeMs;
}

/** Fresh file-watcher telemetry, or null when absent/expired. */
export function freshWatcher(
	status: RuntimeStatus | null | undefined,
	now: number,
): RuntimeWatcher | null {
	const watcher = status?.fileWatcher;
	if (!watcher || isStale(watcher.observedAt, now)) return null;
	return watcher;
}

/**
 * `offline` when no Runtime is connected, `attention` when it is online but its
 * file monitoring is degraded or unavailable, otherwise `online`.
 */
export function runtimeTone(
	status: RuntimeStatus | null | undefined,
	now: number,
): RuntimeTone {
	if (status?.observedAt && isStale(status.observedAt, now)) return "unknown";
	if (!status?.online) return "offline";
	if (
		status.workspace &&
		(!status.workspace.online ||
			!status.workspace.observedAt ||
			isStale(status.workspace.observedAt, now))
	)
		return "attention";
	const watcher = freshWatcher(status, now);
	return watcher && watcher.state !== "running" ? "attention" : "online";
}

/** Local model counts per Harness, for the capability summary. */
export function harnessModelCounts(
	status: RuntimeStatus | null | undefined,
): Record<"pi" | "codex", number> {
	const counts = { pi: 0, codex: 0 };
	for (const model of status?.capabilities?.models ?? [])
		counts[model.harness] += 1;
	return counts;
}
