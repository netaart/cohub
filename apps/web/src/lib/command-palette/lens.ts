import {
	parseCommandPaletteQuery,
	parseLabelScope,
	takeTypePrefix,
} from "./query";
import type { CommandPaletteSearchPlan } from "./scope";
import type { CommandPaletteResourceType } from "./types";

export type CommandPaletteLens = "all" | CommandPaletteResourceType;

export const COMMAND_PALETTE_LENSES = [
	"all",
	"space",
	"chat",
	"label",
	"command",
] as const satisfies readonly CommandPaletteLens[];

export function lensResourceTypes(
	lens: CommandPaletteLens,
): CommandPaletteResourceType[] | undefined {
	return lens === "all" ? undefined : [lens];
}

export function lensOf(
	resourceTypes: readonly CommandPaletteResourceType[] | undefined,
): CommandPaletteLens | null {
	if (!resourceTypes?.length) return "all";
	return resourceTypes.length === 1 ? (resourceTypes[0] ?? null) : null;
}

export function absorbLensPrefix(lens: CommandPaletteLens, input: string) {
	const prefix = takeTypePrefix(input);
	return prefix
		? { lens: prefix.type as CommandPaletteLens, input: prefix.rest }
		: { lens, input };
}

export function buildSearchPlan(
	lens: CommandPaletteLens,
	input: string,
): CommandPaletteSearchPlan {
	const parsed = parseCommandPaletteQuery(input);
	if (parsed.explicitTypeFilter) {
		return {
			query: parsed.query,
			resourceTypes: parsed.resourceTypes,
			labelRef: parsed.labelRef,
		};
	}
	if (lens === "label") {
		const scoped = parseLabelScope(input);
		return {
			query: scoped?.query ?? "",
			resourceTypes: ["label"],
			labelRef: scoped?.labelRef,
		};
	}
	return { query: input.trim(), resourceTypes: lensResourceTypes(lens) };
}
