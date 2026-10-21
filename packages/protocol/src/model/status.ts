/** Per-model availability status, derived from observed traffic with probe fallback. */

export type ModelAvailabilityStatus = "operational" | "degraded" | "outage";

/**
 * Aggregated availability for a single model.
 * All rate fields are percentages (0–100); `null` means no samples in that window.
 */
export type ModelStatusEntry = {
	status: ModelAvailabilityStatus;
	/** Exact 5-minute success rate. Real observed traffic (`online`) when
	 *  available, else the probe self-test window. */
	successRate5m: number | null;
	/** Most recent non-empty success rate used by the selector dot. */
	successRateRecent: number | null;
	/** Window in minutes that produced `successRateRecent`. */
	successRateRecentWindowMinutes: number | null;
	successRate2h: number | null;
	successRate24h: number | null;
	/** 1-hour average / P90 response duration in milliseconds. */
	latencyAvgMs: number | null;
	latencyP90Ms: number | null;
	checkedAt: string | null;
	probeIntervalSeconds: number | null;
	/** 24-hour history in 15-minute buckets (oldest → newest), or null. */
	history: Array<{
		t: string;
		status: ModelAvailabilityStatus;
		rate: number | null;
		samples: number;
	}> | null;
	/**
	 * Bar-chart series (oldest → newest), always 96 buckets. Source is real
	 * observed traffic (`online` heartbeats resampled across its reported
	 * window) when available, else the probe self-test `history` (15-min
	 * buckets) as a fallback for models not yet covered by online. Drives the
	 * hover card bar chart; color each bucket via the 6-tier success-rate scale.
	 */
	heartbeats8h: Array<number | null> | null;
	/**
	 * Total minutes spanned by `heartbeats8h` (the upstream-reported online
	 * window, or 1440 for history fallback). The frontend divides by bucket
	 * count for the per-bar age and the axis label, so the window reads
	 * honestly regardless of source.
	 */
	heartbeatsWindowMinutes: number | null;
};

export type ModelStatusResponse = {
	generatedAt: string;
	overallStatus: ModelAvailabilityStatus | "unknown";
	/** Keyed by model id. */
	models: Record<string, ModelStatusEntry>;
};
