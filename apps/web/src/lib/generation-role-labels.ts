import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import { validateBoardGenerationParameters } from "$lib/board/board-generation";
import {
	type GenerationRoleTexts,
	missingRequiredRoles,
} from "$lib/generation-text-roles";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

/** Known roles have a translated label; an unknown role is labelled with its own name. */
export function generationRoleLabel(role: string, locale: Locale): string {
	switch (role) {
		case "prompt":
			return m.generation_role_prompt({}, { locale });
		case "lyrics":
			return m.generation_role_lyrics({}, { locale });
		case "abc":
			return m.generation_role_abc({}, { locale });
		default:
			return role;
	}
}

export function generationRolePlaceholder(
	role: string,
	locale: Locale,
): string | undefined {
	switch (role) {
		case "prompt":
			return m.generation_role_prompt_placeholder({}, { locale });
		case "lyrics":
			return m.generation_role_lyrics_placeholder({}, { locale });
		case "abc":
			return m.generation_role_abc_placeholder({}, { locale });
		default:
			return undefined;
	}
}

/** Why sending is blocked: the first required role whose box is empty. */
export function generationRoleBlockedReason(
	model: Pick<PublicGenerationDeclaration, "content">,
	texts: GenerationRoleTexts,
	locale: Locale,
): string | null {
	const [role] = missingRequiredRoles(model, texts);
	return role === undefined
		? null
		: m.generation_role_missing(
				{ role: generationRoleLabel(role, locale) },
				{ locale },
			);
}

/** The validator speaks English; the localized lead names the place to look. */
export function generationParametersBlockedReason(
	model: PublicGenerationDeclaration | null,
	parameters: Readonly<Record<string, unknown>>,
	locale: Locale,
): string | null {
	const detail = validateBoardGenerationParameters(model, parameters);
	return detail === null
		? null
		: m.generation_parameters_invalid({ detail }, { locale });
}
