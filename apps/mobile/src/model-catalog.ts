import type { ModelCatalogEntry, ModelStatusEntry } from "@neta-art/cohub";

export type ModelThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

const THINKING_LEVELS: ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export type ModelAvailabilityLevel =
	| "available"
	| "degraded"
	| "outage"
	| "unknown";

export function modelDisplayName(entry: ModelCatalogEntry) {
	const value = entry.model?.name;
	return typeof value === "string" && value.trim() ? value.trim() : entry.id;
}

export function modelContextLabel(entry: ModelCatalogEntry) {
	const value = entry.model?.contextWindow;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
		return null;
	if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M context`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}K context`;
	return `${Math.round(value)} context`;
}

export function modelCostLabel(entry: ModelCatalogEntry) {
	const cost = entry.model?.cost;
	if (!cost || typeof cost !== "object" || Array.isArray(cost)) return null;
	const values = cost as Record<string, unknown>;
	const input = values.input;
	const output = values.output;
	if (typeof input !== "number" && typeof output !== "number") return null;
	const format = (value: unknown) => {
		if (typeof value !== "number" || !Number.isFinite(value) || value === 0)
			return null;
		return value < 0.01 ? value.toFixed(4) : value.toFixed(2);
	};
	const inputLabel = format(input);
	const outputLabel = format(output);
	if (!inputLabel && !outputLabel) return null;
	return `$${inputLabel ?? "-"} in / $${outputLabel ?? "-"} out per M`;
}

export function modelSupportsVision(entry: ModelCatalogEntry) {
	const input = entry.model?.input;
	return Array.isArray(input) && input.includes("image");
}

export function getSupportedThinkingLevels(
	entry: ModelCatalogEntry,
): ModelThinkingLevel[] {
	if (entry.model?.reasoning !== true) return ["off"];
	const map = entry.model?.thinkingLevelMap;
	if (!map || typeof map !== "object" || Array.isArray(map)) {
		return THINKING_LEVELS.filter(
			(level) => level !== "xhigh" && level !== "max",
		);
	}
	const values = map as Record<string, unknown>;
	return THINKING_LEVELS.filter((level) => {
		if (values[level] === null) return false;
		if (level === "xhigh" || level === "max")
			return values[level] !== undefined;
		return true;
	});
}

export function getDefaultThinkingLevel(
	entry: ModelCatalogEntry,
): ModelThinkingLevel {
	const configured = entry.model?.defaultThinkingLevel;
	const fallback =
		typeof configured === "string" &&
		THINKING_LEVELS.includes(configured as ModelThinkingLevel)
			? (configured as ModelThinkingLevel)
			: entry.model?.reasoning === true
				? "high"
				: "off";
	return clampThinkingLevel(entry, fallback);
}

export function clampThinkingLevel(
	entry: ModelCatalogEntry,
	requested: ModelThinkingLevel,
): ModelThinkingLevel {
	const supported = getSupportedThinkingLevels(entry);
	if (supported.includes(requested)) return requested;
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
		const candidate = THINKING_LEVELS[index];
		if (candidate && supported.includes(candidate)) return candidate;
	}
	for (let index = requestedIndex - 1; index >= 0; index -= 1) {
		const candidate = THINKING_LEVELS[index];
		if (candidate && supported.includes(candidate)) return candidate;
	}
	return supported[0] ?? "off";
}

export function formatThinkingLevel(level: ModelThinkingLevel) {
	switch (level) {
		case "off":
			return "Off";
		case "minimal":
			return "Minimal";
		case "low":
			return "Low";
		case "medium":
			return "Medium";
		case "high":
			return "High";
		case "xhigh":
			return "Extra high";
		case "max":
			return "Max";
	}
}

export function formatThinkingLevelShort(level: ModelThinkingLevel) {
	switch (level) {
		case "minimal":
			return "Min";
		case "medium":
			return "Med";
		case "xhigh":
			return "xHigh";
		default:
			return formatThinkingLevel(level);
	}
}

export function requestedThinkingLevel(
	meta: unknown,
): ModelThinkingLevel | null {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
	const value = (meta as Record<string, unknown>).requestedThinkingLevel;
	return typeof value === "string" &&
		THINKING_LEVELS.includes(value as ModelThinkingLevel)
		? (value as ModelThinkingLevel)
		: null;
}

export function modelAvailabilityLevel(
	entry: ModelStatusEntry | null | undefined,
): ModelAvailabilityLevel {
	if (!entry || entry.successRate5m == null) return "unknown";
	if (entry.successRate5m >= 95) return "available";
	if (entry.successRate5m >= 75) return "degraded";
	return "outage";
}

export function modelAvailabilityLabel(level: ModelAvailabilityLevel) {
	switch (level) {
		case "available":
			return "Operational";
		case "degraded":
			return "Degraded";
		case "outage":
			return "Outage";
		case "unknown":
			return "No status";
	}
}
