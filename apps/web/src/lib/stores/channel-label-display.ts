import type { Channel } from "@neta-art/cohub";
import { sdk } from "#lib/sdk.ts";

export type ChannelLabelInfo = {
	id: string;
	provider: string;
	name: string;
};

/** Positive hits stay until refresh; misses only suppress refetch briefly. */
const MISS_TTL_MS = 60_000;

const byId = new Map<string, ChannelLabelInfo>();
const missUntil = new Map<string, number>();
const listeners = new Set<() => void>();
const listInflightBySpace = new Map<string, Promise<void>>();
let version = 0;

function emit() {
	version += 1;
	for (const listener of listeners) listener();
}

function toInfo(
	channel: Pick<Channel, "id" | "provider" | "name">,
): ChannelLabelInfo {
	return {
		id: channel.id,
		provider: channel.provider,
		name: channel.name,
	};
}

function isFreshMiss(channelId: string) {
	const until = missUntil.get(channelId);
	if (until == null) return false;
	if (until > Date.now()) return true;
	missUntil.delete(channelId);
	return false;
}

function collectMissing(channelIds: string[]) {
	return [
		...new Set(
			channelIds
				.map((value) => value.trim())
				.filter((value) => value && !byId.has(value) && !isFreshMiss(value)),
		),
	];
}

function rememberChannels(
	channels: Array<Pick<Channel, "id" | "provider" | "name"> | null | undefined>,
) {
	let changed = false;
	for (const channel of channels) {
		if (!channel?.id) continue;
		const next = toInfo(channel);
		const prev = byId.get(next.id);
		if (!prev || prev.name !== next.name || prev.provider !== next.provider) {
			changed = true;
		}
		byId.set(next.id, next);
		missUntil.delete(next.id);
	}
	return changed;
}

function markMisses(channelIds: string[]) {
	const until = Date.now() + MISS_TTL_MS;
	for (const channelId of channelIds) {
		if (!byId.has(channelId)) missUntil.set(channelId, until);
	}
}

export function fallbackChannelLabelName(channelId: string) {
	return channelId.replaceAll("-", "").slice(0, 8) || "Channel";
}

export function formatChannelLabelName(
	info: ChannelLabelInfo | null | undefined,
	channelId: string,
	options?: { includeProvider?: boolean },
) {
	const name = info?.name?.trim();
	const provider = info?.provider?.trim();
	const includeProvider = options?.includeProvider !== false;
	if (name && provider && includeProvider) return `${provider} · ${name}`;
	if (name) return name;
	if (provider && includeProvider)
		return `${provider} · ${fallbackChannelLabelName(channelId)}`;
	return fallbackChannelLabelName(channelId);
}

export function getChannelLabelInfo(channelId: string) {
	return byId.get(channelId) ?? null;
}

export function onChannelLabelDisplayUpdated(handler: () => void) {
	listeners.add(handler);
	return () => listeners.delete(handler);
}

export function getChannelLabelDisplayVersion() {
	return version;
}

async function refreshChannelLabels(spaceId: string, requestedIds: string[]) {
	let changed = false;

	try {
		const bindings = await sdk.space(spaceId).channels.list();
		changed =
			rememberChannels(bindings.map((binding) => binding.channel)) || changed;
	} catch {
		// Keep going — personal channels may still resolve owner-owned labels.
	}

	const stillMissing = collectMissing(requestedIds);
	if (stillMissing.length > 0) {
		try {
			const personal = await sdk.channels.list();
			changed = rememberChannels(personal) || changed;
		} catch {
			// Do not write misses on total failure — retry on next hydrate.
			if (changed) emit();
			return;
		}
	}

	markMisses(requestedIds);
	if (changed) emit();
}

export async function hydrateChannelLabels(
	spaceId: string,
	channelIds: string[],
) {
	const normalizedSpaceId = spaceId.trim();
	if (!normalizedSpaceId) return;

	while (true) {
		const missing = collectMissing(channelIds);
		if (missing.length === 0) return;

		const inflight = listInflightBySpace.get(normalizedSpaceId);
		if (inflight) {
			await inflight;
			continue;
		}

		const task = refreshChannelLabels(normalizedSpaceId, missing).finally(
			() => {
				listInflightBySpace.delete(normalizedSpaceId);
			},
		);
		listInflightBySpace.set(normalizedSpaceId, task);
		await task;
		return;
	}
}
