import {
	filterDiscoverableGenerationModels,
	GENERATION_CATEGORIES,
	type GenerationCategory,
	generationModelCategory,
	type PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import { textMatchScore } from "#lib/command-palette/score.ts";

type SearchableGenerationModel = Pick<
	PublicGenerationDeclaration,
	"model" | "title" | "hidden" | "category"
>;

export type GenerationCategoryKey = GenerationCategory | "other";
export type GenerationCategoryFilter = GenerationCategoryKey | "all";

const CATEGORY_KEYS: readonly GenerationCategoryKey[] = [
	...GENERATION_CATEGORIES,
	"other",
];

export function generationCategoryKey(model: {
	category?: string | null;
}): GenerationCategoryKey {
	return generationModelCategory(model) ?? "other";
}

export function getGenerationModelPickerItems<
	T extends SearchableGenerationModel,
>(
	models: readonly T[],
	options: {
		query?: string;
		selectedModelIds?: Iterable<string>;
	} = {},
): T[] {
	const query = options.query?.trim() ?? "";
	const includeModelIds = new Set(options.selectedModelIds);
	if (
		query &&
		models.some((model) => model.hidden === true && model.model === query)
	) {
		includeModelIds.add(query);
	}

	const discoverable = filterDiscoverableGenerationModels(models, {
		includeModelIds,
	});
	if (!query) return discoverable;

	return discoverable
		.map((model, index) => ({
			model,
			index,
			score: Math.max(
				textMatchScore(model.model, query),
				textMatchScore(model.title, query),
			),
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((item) => item.model);
}

export function browseGenerationModels<T extends SearchableGenerationModel>(
	models: readonly T[],
	options: {
		query?: string;
		filter?: GenerationCategoryFilter;
		selectedModelIds?: Iterable<string>;
	} = {},
): {
	categories: GenerationCategoryKey[];
	filter: GenerationCategoryFilter;
	models: T[];
	outsideMatches: number;
} {
	const selectedModelIds = [...(options.selectedModelIds ?? [])];
	const present = new Set(
		getGenerationModelPickerItems(models, { selectedModelIds }).map(
			generationCategoryKey,
		),
	);
	const categories = CATEGORY_KEYS.filter((key) => present.has(key));
	const filter =
		options.filter && options.filter !== "all" && present.has(options.filter)
			? options.filter
			: "all";
	const matches = getGenerationModelPickerItems(models, {
		query: options.query,
		selectedModelIds,
	});
	const visible =
		filter === "all"
			? matches
			: matches.filter((model) => generationCategoryKey(model) === filter);
	return {
		categories,
		filter,
		models: visible,
		outsideMatches: matches.length - visible.length,
	};
}

export function resolvePreferredGenerationModel<
	T extends SearchableGenerationModel,
>(models: readonly T[], preferredModelId: string | null | undefined): T | null {
	return (
		models.find((model) => model.model === preferredModelId) ??
		getGenerationModelPickerItems(models)[0] ??
		null
	);
}
