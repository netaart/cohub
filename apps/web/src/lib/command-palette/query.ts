import type { CommandPaletteResourceType } from "./types";

const TYPE_ALIASES = new Map<string, CommandPaletteResourceType>([
	["turn", "turn"],
	["turns", "turn"],
	["session", "session"],
	["sessions", "session"],
	["space", "space"],
	["spaces", "space"],
	["label", "label"],
	["labels", "label"],
	["command", "command"],
	["commands", "command"],
]);

const SHORT_PREFIX_TYPES = new Map<string, CommandPaletteResourceType>([
	["t", "turn"],
	["s", "session"],
	["a", "space"],
	["l", "label"],
	["c", "command"],
]);

export type ParsedCommandPaletteQuery = {
	raw: string;
	query: string;
	resourceTypes?: CommandPaletteResourceType[];
	labelRef?: string;
	explicitTypeFilter: boolean;
};

function uniqueTypes(values: CommandPaletteResourceType[]) {
	return [...new Set(values)];
}

function normalizeLabelRef(value: string) {
	return value
		.split("/")
		.map((part) => part.replace(/\s+/g, " ").trim())
		.filter(Boolean)
		.join("/");
}

export function parseLabelScope(value: string) {
	const trimmed = value.trim();
	if (!trimmed) return null;
	const [labelRef = "", ...rest] = trimmed.split(/\s+/);
	const normalizedRef = normalizeLabelRef(labelRef);
	if (!normalizedRef) return null;
	return { labelRef: normalizedRef, query: rest.join(" ").trim() };
}

function parseTypeList(value: string) {
	const rawTypes = value
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);
	if (rawTypes.length === 0) return null;
	const types: CommandPaletteResourceType[] = [];
	for (const rawType of rawTypes) {
		const type = TYPE_ALIASES.get(rawType);
		if (!type) return null;
		types.push(type);
	}
	return uniqueTypes(types);
}

export type TypePrefix = {
	type: CommandPaletteResourceType;
	rest: string;
};

export function takeTypePrefix(input: string): TypePrefix | null {
	const short = /^\s*([tsacl]):\s*/i.exec(input);
	if (short) {
		const type = SHORT_PREFIX_TYPES.get((short[1] ?? "").toLowerCase());
		return type ? { type, rest: input.slice(short[0].length) } : null;
	}
	const long = /^\s*type:(\S+)\s+/i.exec(input);
	if (long) {
		const types = parseTypeList(long[1] ?? "");
		return types?.length === 1 && types[0]
			? { type: types[0], rest: input.slice(long[0].length) }
			: null;
	}
	const label = /^\s*label:(?=\S+\s)/i.exec(input);
	return label ? { type: "label", rest: input.slice(label[0].length) } : null;
}

export function parseCommandPaletteQuery(
	input: string,
): ParsedCommandPaletteQuery {
	const raw = input;
	const trimmedStart = input.trimStart();

	const labelScopeMatch = /^label:(\S+)(?:\s+)?(.*)$/i.exec(trimmedStart);
	if (labelScopeMatch) {
		const labelRef = normalizeLabelRef(labelScopeMatch[1] ?? "");
		if (labelRef) {
			return {
				raw,
				query: (labelScopeMatch[2] ?? "").trim(),
				resourceTypes: ["label"],
				labelRef,
				explicitTypeFilter: true,
			};
		}
	}

	const longMatch = /^type:([^\s]+)(?:\s+)?(.*)$/i.exec(trimmedStart);
	if (longMatch) {
		const resourceTypes = parseTypeList(longMatch[1] ?? "");
		if (resourceTypes) {
			const value = longMatch[2] ?? "";
			const scoped =
				resourceTypes.length === 1 && resourceTypes[0] === "label"
					? parseLabelScope(value)
					: null;
			return {
				raw,
				query: scoped?.query ?? value.trim(),
				resourceTypes,
				labelRef: scoped?.labelRef,
				explicitTypeFilter: true,
			};
		}
	}

	const shortMatch = /^([tsacl]):(?:\s+)?(.*)$/i.exec(trimmedStart);
	if (shortMatch) {
		const type = SHORT_PREFIX_TYPES.get((shortMatch[1] ?? "").toLowerCase());
		if (type) {
			const value = shortMatch[2] ?? "";
			if (type === "label") {
				const scoped = parseLabelScope(value);
				return {
					raw,
					query: scoped?.query ?? value.trim(),
					resourceTypes: [type],
					labelRef: scoped?.labelRef,
					explicitTypeFilter: true,
				};
			}
			return {
				raw,
				query: value.trim(),
				resourceTypes: [type],
				explicitTypeFilter: true,
			};
		}
	}

	return {
		raw,
		query: input.trim(),
		explicitTypeFilter: false,
	};
}
