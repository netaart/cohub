import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";

const MODEL_SCHEMA = "neta.generation.model.v1";
const CONTENT_TYPES = new Set(["text", "image", "video", "audio", "3d"]);
const SOURCE_TYPES = new Set(["url", "base64"]);
const MERGE_TYPES = new Set(["newline", "space", "concat"]);
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optional(value: unknown, guard: (value: unknown) => boolean) {
	return value === undefined || guard(value);
}

function isString(value: unknown) {
	return typeof value === "string";
}

function isBoolean(value: unknown) {
	return typeof value === "boolean";
}

function isNumber(value: unknown) {
	return typeof value === "number" && Number.isFinite(value);
}

function optionalArray(value: unknown, guard: (value: unknown) => boolean) {
	return value === undefined || (Array.isArray(value) && value.every(guard));
}

function absent(spec: UnknownRecord, ...keys: string[]) {
	return keys.every((key) => spec[key] === undefined);
}

function isDimensionsSpec(value: unknown) {
	return (
		isRecord(value) &&
		optional(value.separator, (item) => item === "x" || item === "*") &&
		optional(value.min, isNumber) &&
		optional(value.max, isNumber) &&
		optional(value.multipleOf, isNumber)
	);
}

function isParameterSpec(value: unknown): boolean {
	if (
		!isRecord(value) ||
		!optional(value.optional, isBoolean) ||
		!optional(value.description, isString)
	) {
		return false;
	}

	switch (value.type) {
		case "string":
			return (
				optional(value.default, isString) &&
				optionalArray(value.enum, isString) &&
				optionalArray(value.examples, isString) &&
				optional(value.dimensions, isDimensionsSpec) &&
				absent(value, "min", "max")
			);
		case "number":
		case "integer":
			return (
				optional(value.default, isNumber) &&
				optional(value.min, isNumber) &&
				optional(value.max, isNumber) &&
				optionalArray(value.examples, isNumber) &&
				absent(value, "enum", "dimensions")
			);
		case "boolean":
			return (
				optional(value.default, isBoolean) &&
				optionalArray(value.examples, isBoolean) &&
				absent(value, "enum", "dimensions", "min", "max")
			);
		default:
			return false;
	}
}

function isContentSpec(value: unknown): boolean {
	return (
		isRecord(value) &&
		CONTENT_TYPES.has(value.type as string) &&
		optional(value.required, isBoolean) &&
		optional(value.roleRequired, isBoolean) &&
		optional(value.min, isNumber) &&
		optional(value.max, isNumber) &&
		optional(value.description, isString) &&
		optionalArray(value.sources, (source) =>
			SOURCE_TYPES.has(source as string),
		) &&
		optionalArray(value.roles, isString) &&
		optional(value.merge, (merge) => MERGE_TYPES.has(merge as string)) &&
		optional(value.meta, isRecord)
	);
}

function isMetaSpec(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const fields =
		value.fields === undefined ||
		(isRecord(value.fields) &&
			Object.values(value.fields).every(
				(field) =>
					isParameterSpec(field) ||
					(isRecord(field) &&
						field.type === "object" &&
						optional(field.optional, isBoolean) &&
						optional(field.description, isString)),
			));
	const variants =
		value.taskVariants === undefined ||
		(isRecord(value.taskVariants) &&
			Object.values(value.taskVariants).every(
				(variant) =>
					isRecord(variant) &&
					optional(variant.description, isString) &&
					optionalArray(variant.required, isString) &&
					optionalArray(variant.requiredContent, (type) =>
						CONTENT_TYPES.has(type as string),
					) &&
					optional(variant.sendTask, isBoolean),
			));
	return fields && optional(value.taskField, isString) && variants;
}

export function isValidCachedGenerationModel(
	value: unknown,
): value is PublicGenerationDeclaration {
	return (
		isRecord(value) &&
		value.schema === MODEL_SCHEMA &&
		typeof value.model === "string" &&
		value.model.trim() !== "" &&
		optional(value.title, isString) &&
		optional(value.description, isString) &&
		optional(value.hidden, isBoolean) &&
		optional(value.allowUnknownParameters, isBoolean) &&
		isRecord(value.content) &&
		Array.isArray(value.content.input) &&
		value.content.input.every(isContentSpec) &&
		(value.parameters === undefined ||
			(isRecord(value.parameters) &&
				Object.values(value.parameters).every(isParameterSpec))) &&
		(value.meta === undefined || isMetaSpec(value.meta)) &&
		(value.examples === undefined || Array.isArray(value.examples))
	);
}
