import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import type { GenerationCategoryFilter } from "#lib/generation-model-catalog.ts";
import type { Locale } from "#lib/i18n/locale.ts";
import { m } from "#lib/paraglide/messages.js";

export function generationCategoryLabel(
	category: GenerationCategoryFilter,
	locale: Locale,
): string {
	const options = { locale };
	switch (category) {
		case "all":
			return m.generation_category_all({}, options);
		case "image":
			return m.generation_category_image({}, options);
		case "video":
			return m.generation_category_video({}, options);
		case "audio":
			return m.generation_category_audio({}, options);
		case "3d":
			return m.generation_category_3d({}, options);
		case "decision":
			return m.generation_category_decision({}, options);
		case "other":
			return m.generation_category_other({}, options);
	}
}

export function generationInputSummary(
	model: Pick<PublicGenerationDeclaration, "content">,
	locale: Locale,
): string {
	return model.content.input
		.map((spec) => {
			const label =
				spec.type === "text"
					? m.generation_input_text({}, { locale })
					: generationCategoryLabel(spec.type, locale);
			return typeof spec.max === "number" && spec.max > 1
				? `${label} ≤${spec.max}`
				: label;
		})
		.join(" · ");
}
