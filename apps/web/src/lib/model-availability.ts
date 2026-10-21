import type {
	ModelAvailabilityStatus,
	ModelStatusEntry,
} from "@cohub/protocol/model/status";

/**
 * Selector dot color levels. The API uses the most recent non-empty observed
 * traffic window (5m, 10m, 30m, 60m) and falls back to probe data when no
 * observed traffic is available.
 *
 * - `available` (green): ≥95% success.
 * - `degraded` (amber): 75–95%.
 * - `outage` (red): <75%.
 * - `unknown` (neutral/gray): no probe or traffic data.
 */
export type AvailabilityLevel = "available" | "degraded" | "outage" | "unknown";

const AVAILABLE_THRESHOLD = 95;
const DEGRADED_THRESHOLD = 75;

export function availabilityLevel(
	entry: ModelStatusEntry | null | undefined,
): AvailabilityLevel {
	if (!entry) return "unknown";
	const rate = entry.successRateRecent;
	if (rate == null) return "unknown"; // no recent samples
	if (rate >= AVAILABLE_THRESHOLD) return "available";
	if (rate >= DEGRADED_THRESHOLD) return "degraded";
	return "outage";
}

export const AVAILABILITY_LABEL: Record<AvailabilityLevel, string> = {
	available: "Operational",
	degraded: "Degraded",
	outage: "Outage",
	unknown: "No Data",
};

/** Map a probe status to the same 3-level scale, used by the hover card header. */
export function statusToLevel(
	status: ModelAvailabilityStatus,
): AvailabilityLevel {
	if (status === "operational") return "available";
	if (status === "degraded") return "degraded";
	return "outage";
}
