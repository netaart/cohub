import type { RuntimeCapabilities } from "@neta-art/cohub";

export type ModelCatalogItem = {
	provider: string;
	id: string;
	model: Record<string, unknown> & { hidden?: boolean };
};

export type ModelThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export type LocalModelSelection = {
	provider: string;
	id: string;
	name?: string;
	thinkingLevel?: ModelThinkingLevel;
};

type LocalModel = RuntimeCapabilities["models"][number];

function toLocalModelItem({
	provider,
	id,
	name,
	reasoning,
	thinkingLevelMap,
	defaultThinkingLevel,
}: LocalModel): ModelCatalogItem {
	return {
		provider,
		id,
		model: { name, reasoning, thinkingLevelMap, defaultThinkingLevel },
	};
}

export function toLocalModelCatalog(
	models: RuntimeCapabilities["models"],
): ModelCatalogItem[] {
	return models.map(toLocalModelItem);
}

/**
 * Resolves what a local Turn runs with against one Harness's catalog: the
 * requested model when the Runtime still offers it, else the Harness default.
 * The level follows the model like the Cohub picker: a requested level is
 * clamped to the requested model, any other model starts at its default.
 * Models without a level choice carry none, so none is sent.
 */
export function resolveLocalModel(
	models: RuntimeCapabilities["models"],
	requested: LocalModelSelection | null,
): LocalModelSelection | null {
	const match =
		requested &&
		models.find(
			(model) =>
				model.provider === requested.provider && model.id === requested.id,
		);
	const model = match ?? models.find((entry) => entry.isDefault);
	if (!model) return null;
	const item = toLocalModelItem(model);
	const thinkingLevel =
		getSupportedThinkingLevels(item).length > 1
			? resolveCandidateThinkingLevel(
					item,
					match ? requested?.thinkingLevel : null,
				)
			: undefined;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

const THINKING_LEVELS = new Set<ModelThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

/** Read only an explicitly requested level; effective defaults are intentionally ignored. */
export function getRequestedThinkingLevel(
	meta: unknown,
): ModelThinkingLevel | null {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
	const value = (meta as Record<string, unknown>).requestedThinkingLevel;
	return typeof value === "string" &&
		THINKING_LEVELS.has(value as ModelThinkingLevel)
		? (value as ModelThinkingLevel)
		: null;
}

/** Compact labels for dense controls (composer, chips). */
export function formatThinkingLevelShort(level: ModelThinkingLevel): string {
	switch (level) {
		case "minimal":
			return "Min";
		case "medium":
			return "Med";
		case "xhigh":
			return "xHigh";
		default:
			return level.charAt(0).toUpperCase() + level.slice(1);
	}
}

/** Full labels for menus, titles, and aria. */
export function formatThinkingLevelFull(level: ModelThinkingLevel): string {
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

const ALL_THINKING_LEVELS: ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function isModelHidden(item: ModelCatalogItem): boolean {
	return item.model.hidden === true;
}

/**
 * Returns the thinking levels supported by a model, mirroring pi-ai's
 * getSupportedThinkingLevels. Non-reasoning models only support "off".
 * xhigh/max are opt-in and require an explicit non-null thinkingLevelMap entry.
 */
export function getSupportedThinkingLevels(
	item: ModelCatalogItem,
): ModelThinkingLevel[] {
	const reasoning = item.model.reasoning === true;
	if (!reasoning) return ["off"];
	const map = item.model.thinkingLevelMap as
		| Partial<Record<ModelThinkingLevel, string | null>>
		| undefined;
	return ALL_THINKING_LEVELS.filter((level) => {
		if (!map) return level !== "xhigh" && level !== "max";
		const mapped = map[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/**
 * Returns the model's default thinking level, falling back to "high" for
 * reasoning models (matching agent runtime behavior) and "off" otherwise.
 */
export function getModelDefaultThinkingLevel(
	item: ModelCatalogItem,
): ModelThinkingLevel {
	const configured = item.model.defaultThinkingLevel;
	if (
		typeof configured === "string" &&
		ALL_THINKING_LEVELS.includes(configured as ModelThinkingLevel)
	) {
		return configured as ModelThinkingLevel;
	}
	return item.model.reasoning === true ? "high" : "off";
}

const CLAMP_ORDER: ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Clamps a requested thinking level to one supported by the model, mirroring
 * pi-ai's clampThinkingLevel. Falls back to the nearest supported level.
 */
export function clampThinkingLevel(
	item: ModelCatalogItem,
	requested: ModelThinkingLevel,
): ModelThinkingLevel {
	const supported = getSupportedThinkingLevels(item);
	if (supported.includes(requested)) return requested;
	const requestedIndex = CLAMP_ORDER.indexOf(requested);
	if (requestedIndex === -1) return supported[0] ?? "off";
	// Try same or higher level first
	for (let i = requestedIndex; i < CLAMP_ORDER.length; i++) {
		const candidate = CLAMP_ORDER[i];
		if (candidate && supported.includes(candidate)) return candidate;
	}
	// Fall back to nearest lower level
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = CLAMP_ORDER[i];
		if (candidate && supported.includes(candidate)) return candidate;
	}
	return supported[0] ?? "off";
}

/**
 * Computes the thinking level that would be used if switching to a model,
 * given the current session level and any explicit override.
 */
export function resolveCandidateThinkingLevel(
	item: ModelCatalogItem,
	sessionThinkingLevel: ModelThinkingLevel | null | undefined,
	override?: ModelThinkingLevel | null,
): ModelThinkingLevel {
	if (override) return clampThinkingLevel(item, override);
	if (sessionThinkingLevel)
		return clampThinkingLevel(item, sessionThinkingLevel);
	return getModelDefaultThinkingLevel(item);
}

export type ModelCatalogIndex = {
	byProviderAndId: Map<string, ModelCatalogItem>;
	uniqueById: Map<string, ModelCatalogItem>;
};

const catalogIndexCache = new WeakMap<ModelCatalogItem[], ModelCatalogIndex>();

function getCatalogModelName(item: ModelCatalogItem | null | undefined) {
	const name = item?.model?.name;
	return typeof name === "string" && name.trim() ? name.trim() : "";
}

function providerModelKey(provider: string, model: string) {
	return `${provider}\u0000${model}`;
}

export function getModelCatalogIndex(
	modelsCatalog: ModelCatalogItem[] | null | undefined,
): ModelCatalogIndex | null {
	if (!modelsCatalog?.length) return null;
	const cached = catalogIndexCache.get(modelsCatalog);
	if (cached) return cached;

	const byProviderAndId = new Map<string, ModelCatalogItem>();
	const byId = new Map<string, ModelCatalogItem[]>();
	for (const item of modelsCatalog) {
		byProviderAndId.set(providerModelKey(item.provider, item.id), item);
		const matches = byId.get(item.id);
		if (matches) matches.push(item);
		else byId.set(item.id, [item]);
	}
	const uniqueById = new Map<string, ModelCatalogItem>();
	for (const [id, matches] of byId) {
		if (matches.length === 1 && matches[0]) uniqueById.set(id, matches[0]);
	}
	const index = { byProviderAndId, uniqueById };
	catalogIndexCache.set(modelsCatalog, index);
	return index;
}

export function findModelCatalogItem(
	modelsCatalog: ModelCatalogItem[] | ModelCatalogIndex | null | undefined,
	input: { provider?: string | null; model?: string | null },
): ModelCatalogItem | null {
	const model = input.model?.trim();
	if (!model || !modelsCatalog) return null;
	const index = Array.isArray(modelsCatalog)
		? getModelCatalogIndex(modelsCatalog)
		: modelsCatalog;
	if (!index) return null;
	const provider = input.provider?.trim();
	if (provider) {
		const providerMatch = index.byProviderAndId.get(
			providerModelKey(provider, model),
		);
		if (providerMatch) return providerMatch;
	}
	return index.uniqueById.get(model) ?? null;
}

export function getModelDisplayName(
	modelsCatalog: ModelCatalogItem[] | ModelCatalogIndex | null | undefined,
	input: { provider?: string | null; model?: string | null },
) {
	const model = input.model?.trim() ?? "";
	if (!model) return "";
	return (
		getCatalogModelName(findModelCatalogItem(modelsCatalog, input)) || model
	);
}
