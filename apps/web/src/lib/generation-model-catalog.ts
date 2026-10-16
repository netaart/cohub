import {
	filterDiscoverableGenerationModels,
	type PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import { textMatchScore } from "$lib/command-palette/score";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

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

/** What a model makes: its declared category, else what its inputs suggest. */
export function generationModelKind(
	model: Pick<PublicGenerationDeclaration, "category" | "content">,
	locale: Locale,
): string {
	switch (model.category) {
		case "image":
			return m.model_kind_image({}, { locale });
		case "video":
			return m.model_kind_video({}, { locale });
		case "audio":
			return m.model_kind_audio({}, { locale });
		case "3d":
			return m.model_kind_3d({}, { locale });
		case "decision":
			return m.model_kind_decision({}, { locale });
	}
	const inputs = new Set(model.content.input.map((item) => item.type));
	if (inputs.has("video")) return m.model_kind_video({}, { locale });
	if (inputs.has("audio")) return m.model_kind_audio({}, { locale });
	if (inputs.has("image")) return m.model_kind_image({}, { locale });
	return m.model_kind_multimodal({}, { locale });
}
