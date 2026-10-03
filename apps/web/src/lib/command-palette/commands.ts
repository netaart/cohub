import { commandItemKey } from "./merge-results";
import { allowsResourceType, type CommandPaletteSearchPlan } from "./scope";
import { sortCommandItems, textMatchScore } from "./score";
import type { CommandPaletteItem } from "./types";

const COMMANDS: CommandPaletteItem[] = [
	{
		type: "command",
		id: "run-command",
		spaceId: "",
		sessionId: null,
		turnId: null,
		sequence: null,
		title: "Run Command",
		excerpt: "Execute bash in the current space",
		spaceName: null,
		sessionTitle: null,
		matchedField: "command",
		href: "#",
		score: 0.96,
		textScore: 0.96,
		recencyScore: 0.62,
		typePriorityScore: 0.9,
		updatedAt: null,
		source: "default",
	},
	{
		type: "command",
		id: "new-space",
		spaceId: "",
		sessionId: null,
		turnId: null,
		sequence: null,
		title: "New Space",
		excerpt: "Create a new space",
		spaceName: null,
		sessionTitle: null,
		matchedField: "command",
		href: "/spaces/new",
		score: 0.94,
		textScore: 0.94,
		recencyScore: 0.6,
		typePriorityScore: 0.8,
		updatedAt: null,
		source: "default",
	},
	{
		type: "command",
		id: "manage-spaces",
		spaceId: "",
		sessionId: null,
		turnId: null,
		sequence: null,
		title: "Manage Spaces",
		excerpt: "Browse, organize, and archive spaces",
		spaceName: null,
		sessionTitle: null,
		matchedField: "command",
		href: "/spaces",
		score: 0.92,
		textScore: 0.92,
		recencyScore: 0.58,
		typePriorityScore: 0.76,
		updatedAt: null,
		source: "default",
	},
	{
		type: "command",
		id: "open-changelog",
		spaceId: "",
		sessionId: null,
		turnId: null,
		sequence: null,
		title: "Changelog",
		excerpt: "What's new in Cohub",
		spaceName: null,
		sessionTitle: null,
		matchedField: "command",
		href: "/changelog",
		score: 0.9,
		textScore: 0.9,
		recencyScore: 0.45,
		typePriorityScore: 0.55,
		updatedAt: null,
		source: "default",
	},
];

function commandAliases(item: CommandPaletteItem) {
	if (item.id === "run-command")
		return ["run command", "run bash", "shell", "terminal", "command"];
	if (item.id === "new-space")
		return ["new space", "create space", "space new"];
	if (item.id === "manage-spaces")
		return ["manage spaces", "space management", "organize spaces"];
	if (item.id === "open-changelog")
		return [
			"changelog",
			"what's new",
			"whats new",
			"release notes",
			"updates",
			"version",
		];
	return [item.title];
}

function isSpaceOnlyDefault(plan: CommandPaletteSearchPlan) {
	return (
		!plan.query.trim() &&
		plan.resourceTypes?.length === 1 &&
		plan.resourceTypes[0] === "space"
	);
}

/** Always synchronous — never waits on network or IndexedDB. */
export function resolveLocalCommandItems(
	plan: CommandPaletteSearchPlan,
): CommandPaletteItem[] {
	if (allowsResourceType(plan, "command")) return searchCommandItems(plan);

	// Space lens still surfaces New Space as a local action.
	if (!isSpaceOnlyDefault(plan)) return [];
	const commands = COMMANDS.filter(
		(command) => command.id === "new-space" || command.id === "manage-spaces",
	);
	return commands.map((item) => ({
		...item,
		score: 1,
		textScore: 1,
		source: "default",
	}));
}

export function searchCommandItems(plan: CommandPaletteSearchPlan) {
	if (!allowsResourceType(plan, "command")) return [];
	const query = plan.query.trim();
	if (!query) {
		// Keep the empty palette lean: only primary actions, not browse links.
		return COMMANDS.filter((item) => item.id !== "open-changelog").map(
			(item) => ({ ...item, source: "default" as const }),
		);
	}
	const items: CommandPaletteItem[] = [];
	for (const item of COMMANDS) {
		const textScore = Math.max(
			textMatchScore(item.title, query),
			...commandAliases(item).map((alias) => textMatchScore(alias, query)),
		);
		if (textScore <= 0) continue;
		const score = textScore * 0.86 + item.typePriorityScore * 0.14;
		items.push({ ...item, score, textScore, source: "local" });
	}
	return items;
}

/**
 * Merge resource results with local commands.
 * Commands always get reserved slots so they cannot be pushed out by limit
 * or delayed by remote/IndexedDB work.
 */
export function withLocalCommands(
	items: CommandPaletteItem[],
	commands: CommandPaletteItem[],
	limit = 30,
	longQuery = false,
): CommandPaletteItem[] {
	if (commands.length === 0)
		return sortCommandItems(items, longQuery).slice(0, limit);

	const commandKeys = new Set(commands.map((item) => commandItemKey(item)));
	const rest = items.filter((item) => !commandKeys.has(commandItemKey(item)));
	const room = Math.max(0, limit - commands.length);
	const topRest = sortCommandItems(rest, longQuery).slice(0, room);

	if (isNewSpaceFirst(commands)) {
		return [...commands, ...topRest].slice(0, limit);
	}
	return sortCommandItems([...commands, ...topRest], longQuery).slice(0, limit);
}

function isNewSpaceFirst(commands: CommandPaletteItem[]) {
	return (
		commands.length === 1 &&
		commands[0]?.type === "command" &&
		commands[0]?.id === "new-space" &&
		commands[0]?.score >= 1
	);
}
