import {
	type GenerationParameterSpec,
	type PublicGenerationDeclaration,
	resolveGenerationOperation,
} from "@cohub/protocol/generation";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";

export type GenerationParameterValues = Record<string, unknown>;
export type GenerationListSpec = Extract<
	GenerationParameterSpec,
	{ type: "array" }
>;

export const generationParameterLabel = (name: string) =>
	name.replaceAll("_", " ");

/** The parameters a request sends: the saved values the selected operation declares. */
export function declaredGenerationParameters(
	model: PublicGenerationDeclaration | null,
	saved: Readonly<GenerationParameterValues>,
): GenerationParameterValues {
	if (!model || model.allowUnknownParameters) return { ...saved };
	const declared = resolveGenerationOperation(model, saved).parameters ?? {};
	return Object.fromEntries(
		Object.entries(saved).filter(([name]) => Object.hasOwn(declared, name)),
	);
}

/** Parameters a settings form edits; a model with operations picks its operation separately. */
export function editableGenerationParameters(
	model: PublicGenerationDeclaration | null,
	parameters: Readonly<GenerationParameterValues>,
): [string, GenerationParameterSpec][] {
	if (!model) return [];
	return Object.entries(
		resolveGenerationOperation(model, parameters).parameters ?? {},
	).filter(([name]) => !(model.operations && name === "operation"));
}

function rangeError(
	name: string,
	value: number,
	bounds: { min?: number; max?: number },
	locale: Locale,
) {
	if (bounds.min !== undefined && value < bounds.min)
		return m.generation_param_min({ name, min: bounds.min }, { locale });
	if (bounds.max !== undefined && value > bounds.max)
		return m.generation_param_max({ name, max: bounds.max }, { locale });
	return null;
}

function listError(
	name: string,
	spec: GenerationListSpec,
	value: unknown,
	locale: Locale,
) {
	if (!Array.isArray(value))
		return m.generation_param_invalid({ name }, { locale });
	if (spec.min !== undefined && value.length < spec.min)
		return m.generation_param_items_min({ name, min: spec.min }, { locale });
	if (spec.max !== undefined && value.length > spec.max)
		return m.generation_param_items_max({ name, max: spec.max }, { locale });
	if (spec.unique && new Set(value).size !== value.length)
		return m.generation_param_items_unique({ name }, { locale });
	const { items } = spec;
	for (const item of value) {
		if (items.type === "string") {
			if (
				typeof item !== "string" ||
				(items.enum && !items.enum.includes(item))
			)
				return m.generation_param_invalid({ name }, { locale });
			continue;
		}
		if (typeof item !== "number" || !Number.isInteger(item))
			return m.generation_param_whole({ name }, { locale });
		const error = rangeError(name, item, items, locale);
		if (error) return error;
	}
	return null;
}

function textError(
	name: string,
	spec: Extract<GenerationParameterSpec, { type: "string" }>,
	value: unknown,
	locale: Locale,
) {
	if (typeof value !== "string" || (spec.enum && !spec.enum.includes(value)))
		return m.generation_param_invalid({ name }, { locale });
	if (!spec.dimensions) return null;
	const { min, max, multipleOf, separator = "x" } = spec.dimensions;
	const parts = value.split(separator);
	if (parts.length !== 2 || parts.some((part) => !/^\d+$/.test(part)))
		return m.generation_param_dimensions({ name, separator }, { locale });
	for (const dimension of parts.map(Number)) {
		const error =
			rangeError(name, dimension, { min, max }, locale) ??
			(multipleOf !== undefined && dimension % multipleOf !== 0
				? m.generation_param_multiple({ name, step: multipleOf }, { locale })
				: null);
		if (error) return error;
	}
	return null;
}

function numberError(
	name: string,
	spec: Extract<GenerationParameterSpec, { type: "number" | "integer" }>,
	value: unknown,
	locale: Locale,
) {
	if (typeof value !== "number" || !Number.isFinite(value))
		return m.generation_param_number({ name }, { locale });
	if (spec.type === "integer" && !Number.isInteger(value))
		return m.generation_param_whole({ name }, { locale });
	return (
		rangeError(name, value, spec, locale) ??
		(spec.multipleOf !== undefined && !Number.isInteger(value / spec.multipleOf)
			? m.generation_param_multiple({ name, step: spec.multipleOf }, { locale })
			: null)
	);
}

function parameterError(
	name: string,
	spec: GenerationParameterSpec,
	value: unknown,
	locale: Locale,
): string | null {
	switch (spec.type) {
		case "string":
			return textError(name, spec, value, locale);
		case "boolean":
			return typeof value === "boolean"
				? null
				: m.generation_param_invalid({ name }, { locale });
		case "array":
			return listError(name, spec, value, locale);
		default:
			return numberError(name, spec, value, locale);
	}
}

/** Why the parameters do not fit the model and the operation they select, or null when they do. */
export function generationParametersError(
	model: PublicGenerationDeclaration | null,
	parameters: Readonly<GenerationParameterValues>,
	locale: Locale,
): string | null {
	if (!model) return null;
	const resolved = resolveGenerationOperation(model, parameters);
	if (model.operations && resolved === model)
		return m.generation_choose_operation({}, { locale });
	for (const [name, spec] of Object.entries(resolved.parameters ?? {})) {
		const label = generationParameterLabel(name);
		const value = parameters[name];
		if (value === undefined) {
			if (spec.default === undefined && spec.optional !== true)
				return m.generation_param_set({ name: label }, { locale });
			continue;
		}
		const error = parameterError(label, spec, value, locale);
		if (error) return error;
	}
	return null;
}

/** Comma-separated items of a list parameter; whole-number lists parse items so validation can reject bad ones. */
export function parseListParameter(
	text: string,
	items: GenerationListSpec["items"],
): unknown[] {
	return text
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => (items.type === "integer" ? Number(part) : part));
}

function isStoredValue(value: unknown): boolean {
	const scalar = (item: unknown) =>
		typeof item === "string" ||
		(typeof item === "number" && Number.isFinite(item));
	return (
		scalar(value) ||
		typeof value === "boolean" ||
		(Array.isArray(value) && value.every(scalar))
	);
}

/** Parameter values restored from a draft, keeping only values a parameter can hold. */
export function storedGenerationParameters(
	value: unknown,
): GenerationParameterValues {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => isStoredValue(item)),
	);
}
