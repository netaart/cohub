import type {
	CommandPaletteResourceType,
	RemoteCommandPaletteResourceType,
} from "./types";

export type CommandPaletteSearchPlan = {
	query: string;
	resourceTypes?: CommandPaletteResourceType[];
	labelRef?: string;
};

const REMOTE_TYPES = new Set<CommandPaletteResourceType>([
	"chat",
	"space",
	"label",
]);

export function allowsResourceType(
	plan: Pick<CommandPaletteSearchPlan, "resourceTypes">,
	type: CommandPaletteResourceType,
) {
	return !plan.resourceTypes || plan.resourceTypes.includes(type);
}

export function getRemoteResourceTypes(
	plan: Pick<CommandPaletteSearchPlan, "resourceTypes">,
): RemoteCommandPaletteResourceType[] | undefined {
	if (!plan.resourceTypes) return undefined;
	const types = plan.resourceTypes.filter((type) =>
		REMOTE_TYPES.has(type),
	) as RemoteCommandPaletteResourceType[];
	return types.length > 0 ? types : [];
}
