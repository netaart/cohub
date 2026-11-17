import {
	filterDiscoverableGenerationModels,
	type PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import { textMatchScore } from "#lib/command-palette/score.ts";

type SearchableGenerationModel = Pick<
	PublicGenerationDeclaration,
	"model" | "title" | "hidden"
>;

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

export function resolvePreferredGenerationModel<
	T extends SearchableGenerationModel,
>(models: readonly T[], preferredModelId: string | null | undefined): T | null {
	return (
		models.find((model) => model.model === preferredModelId) ??
		getGenerationModelPickerItems(models)[0] ??
		null
	);
}
