import type { CommandPaletteItem, CommandPaletteItemType } from "./types";

const TYPE_PRIORITY: Record<CommandPaletteItemType, number> = {
	command: 1,
	space: 0.88,
	chat: 0.74,
	label: 0.72,
};

const FIELD_WEIGHT: Record<string, number> = {
	userText: 1,
	command: 0.98,
	title: 0.94,
	name: 0.9,
	labelName: 0.88,
	labelItemContent: 0.86,
	description: 0.68,
};

export function normalizeSearchText(value: string | null | undefined) {
	return (value ?? "")
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[\s_-]+/g, " ")
		.trim();
}

function subsequenceScore(text: string, query: string) {
	if (!query) return 0;
	let qi = 0;
	let streak = 0;
	let score = 0;
	for (let i = 0; i < text.length && qi < query.length; i += 1) {
		if (text[i] !== query[qi]) {
			streak = 0;
			continue;
		}
		qi += 1;
		streak += 1;
		score += 1 + Math.min(streak, 5) * 0.15;
	}
	if (qi < query.length) return 0;
	return Math.min(0.68, score / Math.max(text.length, query.length) + 0.22);
}

export function textMatchScore(text: string | null | undefined, query: string) {
	const haystack = normalizeSearchText(text);
	const needle = normalizeSearchText(query);
	if (!haystack || !needle) return 0;
	if (haystack === needle) return 1;
	if (haystack.startsWith(needle)) return 0.92;
	if (haystack.includes(` ${needle}`)) return 0.84;
	if (haystack.includes(needle)) return 0.74;
	return subsequenceScore(haystack, needle);
}

export function recencyScore(value: string | null | undefined) {
	if (!value) return 0.2;
	const time = new Date(value).getTime();
	if (!Number.isFinite(time)) return 0.2;
	const ageDays = Math.max(0, Date.now() - time) / 86_400_000;
	return 1 / (1 + ageDays / 30);
}

export function scoreCommandItem(input: {
	type: CommandPaletteItemType;
	query: string;
	primary: string | null | undefined;
	secondary?: string | null;
	matchedField: CommandPaletteItem["matchedField"];
	updatedAt?: string | null;
}) {
	const primaryScore = textMatchScore(input.primary, input.query);
	const secondaryScore = input.secondary
		? textMatchScore(input.secondary, input.query) * 0.78
		: 0;
	const textScore =
		Math.max(primaryScore, secondaryScore) *
		(FIELD_WEIGHT[input.matchedField] ?? 0.8);
	return blendCommandScore({ ...input, textScore });
}

export function blendCommandScore(input: {
	type: CommandPaletteItemType;
	textScore: number;
	updatedAt?: string | null;
}) {
	const fresh = recencyScore(input.updatedAt);
	const typePriorityScore = TYPE_PRIORITY[input.type];
	return {
		score: input.textScore * 0.76 + fresh * 0.18 + typePriorityScore * 0.06,
		textScore: input.textScore,
		recencyScore: fresh,
		typePriorityScore,
	};
}

export function sortCommandItems(
	items: CommandPaletteItem[],
	longQuery = false,
) {
	const tierOf = (item: CommandPaletteItem) => {
		// Long, specific queries let strong exact/prefix matches bypass tiers.
		if (longQuery && item.textScore >= 0.9) return 0;
		if (item.viewerTier !== undefined) return item.viewerTier;
		if (
			item.viewerRelation === "creator" ||
			item.viewerRelation === "participant"
		)
			return 0;
		if (item.viewerRelation === "unrelated") return 2;
		return 1;
	};
	return [...items].sort((a, b) => {
		const tierDelta = tierOf(a) - tierOf(b);
		if (tierDelta !== 0) return tierDelta;
		const scoreDelta = b.score - a.score;
		if (Math.abs(scoreDelta) > 0.0001) return scoreDelta;
		const textDelta = b.textScore - a.textScore;
		if (Math.abs(textDelta) > 0.0001) return textDelta;
		const typeDelta = b.typePriorityScore - a.typePriorityScore;
		if (Math.abs(typeDelta) > 0.0001) return typeDelta;
		return (
			new Date(b.updatedAt ?? 0).getTime() -
			new Date(a.updatedAt ?? 0).getTime()
		);
	});
}
