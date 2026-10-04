import {
	SETTINGS_SECTIONS,
	type SettingsSection,
	settingsSectionHref,
} from "$lib/settings-nav";
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

const SETTINGS_COMMAND_PREFIX = "settings:";

const SETTINGS_ALIASES: Record<SettingsSection, string[]> = {
	general: ["general", "preferences", "profile", "language", "theme"],
	activity: ["activity", "usage"],
	referrals: ["referrals", "invite", "referral"],
	billing: ["billing", "plan", "subscription", "balance", "credits"],
	rules: ["rules", "user rules", "instructions"],
	channels: ["channels", "integrations", "feishu", "discord", "wechat", "qq"],
};

const SETTINGS_COMMANDS: CommandPaletteItem[] = SETTINGS_SECTIONS.map(
	(section, index) => ({
		type: "command",
		id: `${SETTINGS_COMMAND_PREFIX}${section}`,
		spaceId: "",
		sessionId: null,
		turnId: null,
		sequence: null,
		title: section,
		excerpt: "Settings",
		spaceName: null,
		sessionTitle: null,
		matchedField: "command",
		href: settingsSectionHref(section),
		score: 0.8 - index * 0.01,
		textScore: 0.8 - index * 0.01,
		recencyScore: 0.4,
		typePriorityScore: 0.5,
		updatedAt: null,
		source: "default",
	}),
);

export function settingsCommandSection(
	item: Pick<CommandPaletteItem, "type" | "id">,
): SettingsSection | null {
	if (item.type !== "command" || !item.id.startsWith(SETTINGS_COMMAND_PREFIX))
		return null;
	const section = item.id.slice(SETTINGS_COMMAND_PREFIX.length);
	return (SETTINGS_SECTIONS as readonly string[]).includes(section)
		? (section as SettingsSection)
		: null;
}

function commandAliases(item: CommandPaletteItem) {
	const section = settingsCommandSection(item);
	if (section) return [...SETTINGS_ALIASES[section], `${section} settings`];
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

export type CommandTitleLocalizer = (item: CommandPaletteItem) => string | null;

/** Always synchronous — never waits on network or IndexedDB. */
export function resolveLocalCommandItems(
	plan: CommandPaletteSearchPlan,
	localize?: CommandTitleLocalizer,
): CommandPaletteItem[] {
	if (allowsResourceType(plan, "command"))
		return searchCommandItems(plan, localize);

	// Space lens still surfaces New Space as a local action.
	if (!isSpaceOnlyDefault(plan)) return [];
	const item = COMMANDS.find((command) => command.id === "new-space");
	return item ? [{ ...item, score: 1, textScore: 1, source: "default" }] : [];
}

function isCommandOnly(plan: CommandPaletteSearchPlan) {
	return (
		plan.resourceTypes?.length === 1 && plan.resourceTypes[0] === "command"
	);
}

export function searchCommandItems(
	plan: CommandPaletteSearchPlan,
	localize?: CommandTitleLocalizer,
) {
	if (!allowsResourceType(plan, "command")) return [];
	const query = plan.query.trim();
	if (!query) {
		if (isCommandOnly(plan))
			return [...COMMANDS, ...SETTINGS_COMMANDS].map((item) => ({
				...item,
				source: "default" as const,
			}));
		return COMMANDS.filter(
			(item) => item.id !== "open-changelog" && item.id !== "manage-spaces",
		).map((item) => ({ ...item, source: "default" as const }));
	}
	const items: CommandPaletteItem[] = [];
	for (const item of [...COMMANDS, ...SETTINGS_COMMANDS]) {
		const localizedTitle = localize?.(item);
		const textScore = Math.max(
			textMatchScore(item.title, query),
			localizedTitle ? textMatchScore(localizedTitle, query) : 0,
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
