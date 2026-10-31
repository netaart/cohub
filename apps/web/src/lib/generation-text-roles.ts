import type {
	GenerationContentBlock,
	PublicGenerationDeclaration,
} from "@cohub/protocol/generation";

export type GenerationTextRoleField = { role: string; required: boolean };

/** Text typed into each role box, keyed by role. */
export type GenerationRoleTexts = Readonly<Record<string, string>>;

/**
 * One field per role the model's text input declares; none when it declares no roles.
 *
 * A declaration states how many text blocks are needed (`min`, or one when only
 * `required` is set) but not which roles, so the first that many roles in
 * declaration order are required and the rest are optional.
 */
export function generationTextRoleFields(
	model: Pick<PublicGenerationDeclaration, "content">,
): GenerationTextRoleField[] {
	const spec = model.content.input.find((input) => input.type === "text");
	const requiredCount = spec?.min ?? (spec?.required ? 1 : 0);
	return (spec?.roles ?? []).map((role, index) => ({
		role,
		required: index < requiredCount,
	}));
}

/** Required roles whose box is empty or blank, in declared order. */
export function missingRequiredRoles(
	model: Pick<PublicGenerationDeclaration, "content">,
	texts: GenerationRoleTexts,
): string[] {
	return generationTextRoleFields(model)
		.filter(({ role, required }) => required && !texts[role]?.trim())
		.map(({ role }) => role);
}

/**
 * A role-tagged text block per box that holds more than whitespace, in declared order;
 * null for a model without text roles. The text is sent exactly as typed: a score
 * must reach the model byte for byte, so `trim` only decides whether a box is blank.
 */
export function roleTextBlocks(
	model: Pick<PublicGenerationDeclaration, "content">,
	texts: GenerationRoleTexts,
): GenerationContentBlock[] | null {
	const fields = generationTextRoleFields(model);
	if (fields.length === 0) return null;
	return fields.flatMap(({ role }) => {
		const text = texts[role];
		if (text === undefined || !text.trim()) return [];
		return [
			{ type: "text", text, meta: { role } } satisfies GenerationContentBlock,
		];
	});
}
