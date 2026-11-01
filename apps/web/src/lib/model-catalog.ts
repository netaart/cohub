import {
	clampThinkingLevel as clampModelThinkingLevel,
	isModelThinkingLevel,
	type ModelThinkingLevel,
	supportedThinkingLevels,
} from "@cohub/protocol";
import type { RuntimeCapabilities } from "@neta-art/cohub";

export type { ModelThinkingLevel };

export type ModelCatalogItem = {
	provider: string;
	id: string;
	model: Record<string, unknown> & { hidden?: boolean };
};

export type LocalModelSelection = {
	provider: string;
	id: string;
	name?: string;
	thinkingLevel?: ModelThinkingLevel;
	/** Service tier for the next Turn; absent runs the Harness default. */
	serviceTier?: string;
};

/** A restored request; without a model the Harness default runs. */
export type LocalModelRequest =
	| LocalModelSelection
	| {
			id?: undefined;
			provider?: undefined;
			thinkingLevel?: undefined;
			serviceTier?: string;
	  };

/** The tier the Fast switch selects (Codex `priority`); models without it show no switch. */
export const FAST_SERVICE_TIER = "priority";

export function supportsFastServiceTier(item: ModelCatalogItem): boolean {
	const tiers = item.model.serviceTiers;
	return (
		Array.isArray(tiers) &&
		tiers.some((tier) => (tier as { id?: unknown })?.id === FAST_SERVICE_TIER)
	);
}

type LocalModel = RuntimeCapabilities["models"][number];

function toLocalModelItem({
	provider,
	id,
	name,
	reasoning,
	thinkingLevelMap,
	defaultThinkingLevel,
	serviceTiers,
}: LocalModel): ModelCatalogItem {
	return {
		provider,
		id,
		model: {
			name,
			reasoning,
			thinkingLevelMap,
			defaultThinkingLevel,
			serviceTiers,
		},
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
 * Models without a level choice carry none, so none is sent. A service tier
 * follows to any model that offers it.
 */
export function resolveLocalModel(
	models: RuntimeCapabilities["models"],
	requested: LocalModelRequest | null,
): LocalModelSelection | null {
	const selection = requested?.id !== undefined ? requested : null;
	const match =
		selection &&
		models.find(
			(model) =>
				model.provider === selection.provider && model.id === selection.id,
		);
	const model = match ?? models.find((entry) => entry.isDefault);
	if (!model) return null;
	const item = toLocalModelItem(model);
	const thinkingLevel =
		getSupportedThinkingLevels(item).length > 1
			? resolveCandidateThinkingLevel(
					item,
					match ? selection?.thinkingLevel : null,
				)
			: undefined;
	const serviceTier = model.serviceTiers?.some(
		(tier) => tier.id === requested?.serviceTier,
	)
		? requested?.serviceTier
		: undefined;
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		...(thinkingLevel ? { thinkingLevel } : {}),
		...(serviceTier ? { serviceTier } : {}),
	};
}

/** Read only an explicitly requested level; effective defaults are intentionally ignored. */
export function getRequestedThinkingLevel(
	meta: unknown,
): ModelThinkingLevel | null {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
	const value = (meta as Record<string, unknown>).requestedThinkingLevel;
	return isModelThinkingLevel(value) ? value : null;
}

export function getRequestedServiceTier(meta: unknown): string | null {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
	const value = (meta as Record<string, unknown>).requestedServiceTier;
	return typeof value === "string" && value ? value : null;
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
		case "ultra":
			return "Ultra";
	}
}

export function isModelHidden(item: ModelCatalogItem): boolean {
	return item.model.hidden === true;
}

export function getSupportedThinkingLevels(
	item: ModelCatalogItem,
): ModelThinkingLevel[] {
	return supportedThinkingLevels(item.model);
}

/**
 * Returns the model's default thinking level, falling back to "high" for
 * reasoning models (matching agent runtime behavior) and "off" otherwise.
 */
export function getModelDefaultThinkingLevel(
	item: ModelCatalogItem,
): ModelThinkingLevel {
	const configured = item.model.defaultThinkingLevel;
	if (isModelThinkingLevel(configured)) return configured;
	return item.model.reasoning === true ? "high" : "off";
}

export function clampThinkingLevel(
	item: ModelCatalogItem,
	requested: ModelThinkingLevel,
): ModelThinkingLevel {
	return clampModelThinkingLevel(item.model, requested);
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
