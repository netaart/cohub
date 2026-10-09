import type { GlobalSearchResult } from "@neta-art/cohub";
import { sortCommandItems } from "./score";
import type { CommandPaletteItem } from "./types";

type CommandItemKeySource = Pick<CommandPaletteItem, "type" | "id">;

export function commandItemKey(item: CommandItemKeySource) {
	return `${item.type}:${item.id}`;
}

/**
 * True when two lists resolve to the same ordered keys. The palette result
 * list is keyed by these identities, so a refresh that lands on an identical
 * sequence changes nothing visually — callers can skip the state update (and
 * the re-render) entirely instead of swapping in an equivalent list.
 */
export function sameCommandItemSequence(
	left: readonly CommandItemKeySource[],
	right: readonly CommandItemKeySource[],
) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		if (commandItemKey(left[index]) !== commandItemKey(right[index]))
			return false;
	}
	return true;
}

function remoteToItem(item: GlobalSearchResult): CommandPaletteItem {
	return {
		...item,
		excerpt: item.excerpt ?? null,
		spaceName: item.spaceName ?? null,
		viewerRelation: item.viewerRelation ?? null,
		viewerTier: item.effectiveTier ?? undefined,
		source: "remote",
		remoteScore: item.score,
	};
}

export function mergeCommandResults(input: {
	local: CommandPaletteItem[];
	remote: GlobalSearchResult[];
	limit?: number;
	longQuery?: boolean;
}) {
	const byKey = new Map<string, CommandPaletteItem>();
	for (const item of input.local) byKey.set(commandItemKey(item), item);
	for (const remoteResult of input.remote) {
		const item = remoteToItem(remoteResult);
		const key = commandItemKey(item);
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, item);
			continue;
		}
		// Remote knows the viewer relation authoritatively; keep its tier.
		const keepLocalHit = !item.hit && Boolean(existing.hit);
		byKey.set(key, {
			...existing,
			...item,
			...(keepLocalHit
				? {
						hit: existing.hit,
						href: existing.href,
						matchCount: Math.max(
							item.matchCount ?? 0,
							existing.matchCount ?? 0,
						),
					}
				: {}),
			source: "local+remote",
			localScore: existing.localScore ?? existing.score,
			remoteScore: item.score,
			score: Math.max(existing.score, item.score),
			textScore: Math.max(existing.textScore, item.textScore),
			recencyScore: Math.max(existing.recencyScore, item.recencyScore),
			typePriorityScore: Math.max(
				existing.typePriorityScore,
				item.typePriorityScore,
			),
		});
	}
	return sortCommandItems([...byKey.values()], input.longQuery).slice(
		0,
		input.limit ?? 30,
	);
}
