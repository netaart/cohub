import type {
	ChannelEnvelope,
	SessionRecord,
	SpaceRecord,
} from "@neta-art/cohub";
import { HttpError } from "@neta-art/cohub";
import {
	getCachedSpacePage,
	setCachedSpacePage,
} from "$lib/cache/space-list-page-cache";
import {
	compareSpaces,
	matchesSpacesFilter,
	SPACES_FILTERS,
	type SpacesFilter,
	time,
} from "$lib/features/spaces/spaces-filter";
import { LiveList } from "$lib/lists/live-list.svelte";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import { getRecentSpaces, onRecentSpaceVisit } from "$lib/stores/recent-space";

const PAGE_SIZE = 50;
const PINNED_SYSTEM_KEY = "user:pinned";
const ARCHIVED_SYSTEM_KEY = "user:archived";

type ViewerFlags = { isPinned?: boolean; isArchived?: boolean };

function recentVisits() {
	return getRecentSpaces(authStore.userUuid ?? "").map((entry) => ({
		id: entry.spaceId,
		timestamp: entry.timestamp,
	}));
}

function listFields(space: SpaceRecord): Partial<SpaceRecord> {
	return {
		name: space.name,
		slug: space.slug,
		description: space.description,
		publicProfile: space.publicProfile,
		ownerProfile: space.ownerProfile,
		lastActivityAt: space.lastActivityAt,
		updatedAt: space.updatedAt,
	};
}

class SpacesInbox {
	readonly list = new LiveList<SpacesFilter, SpaceRecord, null>({
		name: "spaces",
		pageSize: PAGE_SIZE,
		memoLimit: SPACES_FILTERS.length,
		key: (filter) => filter,
		id: (space) => space.id,
		compare: compareSpaces,
		emptyExtra: () => null,
		mergeExtra: () => null,
		fetch: async (filter, cursor) => {
			const page = await sdk.spaces.list({
				limit: PAGE_SIZE,
				cursor,
				filter,
				query: "",
				recentSpaces: recentVisits(),
			});
			return {
				items: page.items,
				hasMore: page.pageInfo.hasMore,
				cursor: page.pageInfo.nextCursor,
				extra: null,
			};
		},
		read: async (filter) => {
			const cached = await getCachedSpacePage(filter, "");
			if (!cached) return null;
			return {
				items: cached.items.filter((space) =>
					matchesSpacesFilter(space, filter),
				),
				hasMore: cached.hasMore ?? false,
				cursor: null,
				extra: null,
			};
		},
		write: async (filter, snapshot) => {
			await setCachedSpacePage(filter, "", {
				items: snapshot.items,
				pageInfo: { hasMore: snapshot.hasMore, nextCursor: null },
			});
		},
	});

	#stop: (() => void) | null = null;
	#refreshing = new Map<string, Promise<void>>();

	start(): () => void {
		if (this.#stop) return this.#stop;
		this.list.start();
		const stopEvents = sdk.onUserEvent((event) => this.#handleEvent(event));
		const stopVisits = onRecentSpaceVisit((visit) =>
			this.#bumpPersonalActivity(visit.spaceId, visit.timestamp),
		);
		this.#stop = () => {
			stopEvents();
			stopVisits();
			this.list.stop();
			this.#stop = null;
		};
		return this.#stop;
	}

	find(spaceId: string) {
		return this.list.find(spaceId);
	}

	applyViewerFlags(spaceIds: readonly string[], flags: ViewerFlags) {
		for (const id of spaceIds) {
			const merge = (space: SpaceRecord) => ({ ...space, ...flags });
			const known = this.list.find(id);
			const next = known ? merge(known) : null;
			this.list.apply({
				id,
				fit: (filter) =>
					next ? (matchesSpacesFilter(next, filter) ? "in" : "out") : "unknown",
				merge,
				create: () => next,
				settled: true,
			});
		}
	}

	#handleEvent(event: ChannelEnvelope) {
		switch (event.type) {
			case "label.assignments.updated":
				this.#handleLabels(event.payload);
				return;
			case "space.list.changed": {
				const spaceId = (event.payload as { spaceId?: unknown }).spaceId;
				if (typeof spaceId === "string") void this.#refreshSpace(spaceId);
				return;
			}
			case "session.turn.notify": {
				const payload = event.payload as {
					spaceId?: unknown;
					completedAt?: unknown;
				};
				if (typeof payload.spaceId !== "string") return;
				const at =
					typeof payload.completedAt === "string"
						? time(payload.completedAt)
						: Date.now();
				this.#bumpPersonalActivity(payload.spaceId, at || Date.now());
				return;
			}
			case "session.created":
			case "session.updated": {
				const session = (event.payload as { session?: unknown }).session as
					| Partial<SessionRecord>
					| undefined;
				if (
					typeof session?.spaceId !== "string" ||
					typeof session.lastMessageAt !== "string"
				)
					return;
				this.#bumpSpaceActivity(session.spaceId, session.lastMessageAt);
				// The Space room hears every session; only the viewer's own count as theirs.
				const viewer = authStore.userUuid;
				if (
					viewer &&
					(session.userUuid === viewer ||
						session.participantUserUuids?.includes(viewer))
				)
					this.#bumpPersonalActivity(
						session.spaceId,
						time(session.lastMessageAt),
					);
				return;
			}
		}
	}

	#handleLabels(payload: Record<string, unknown>) {
		if (payload.resourceType !== "space") return;
		const entries = payload.resourceAssignments as
			| {
					resourceRef: string;
					assignments: { labelSystemKey?: string | null }[];
			  }[]
			| undefined;
		for (const entry of entries ?? []) {
			const keys = new Set(
				entry.assignments.map((assignment) => assignment.labelSystemKey),
			);
			this.applyViewerFlags([entry.resourceRef], {
				isPinned: keys.has(PINNED_SYSTEM_KEY),
				isArchived: keys.has(ARCHIVED_SYSTEM_KEY),
			});
		}
	}

	#bumpPersonalActivity(spaceId: string, at: number) {
		if (!at) return;
		const personalActivityAt = new Date(at).toISOString();
		this.list.apply({
			id: spaceId,
			fit: (filter) => (filter === "recent" ? "unknown" : "keep"),
			merge: (space) =>
				time(space.personalActivityAt) >= at
					? space
					: { ...space, personalActivityAt },
		});
	}

	#bumpSpaceActivity(spaceId: string, lastActivityAt: string) {
		this.list.apply({
			id: spaceId,
			fit: () => "keep",
			merge: (space) =>
				time(space.lastActivityAt) >= time(lastActivityAt)
					? space
					: { ...space, lastActivityAt },
		});
	}

	#refreshSpace(spaceId: string): Promise<void> {
		const pending = this.#refreshing.get(spaceId);
		if (pending) return pending;
		const request = this.#readSpace(spaceId).finally(() => {
			this.#refreshing.delete(spaceId);
		});
		this.#refreshing.set(spaceId, request);
		return request;
	}

	async #readSpace(spaceId: string) {
		try {
			const space = await sdk.space(spaceId).get();
			if (space.accessLevel === "minimal") {
				this.list.remove(spaceId);
				return;
			}
			const known = this.list.find(spaceId);
			if (!known) {
				this.list.invalidate((filter) => filter !== "archived");
				return;
			}
			const fields = listFields(space);
			const next = { ...known, ...fields };
			this.list.apply({
				id: spaceId,
				fit: (filter) => (matchesSpacesFilter(next, filter) ? "keep" : "out"),
				merge: (current) => ({ ...current, ...fields }),
			});
		} catch (error) {
			if (
				error instanceof HttpError &&
				(error.status === 403 || error.status === 404)
			) {
				this.list.remove(spaceId);
				return;
			}
			this.list.invalidate();
		}
	}
}

export const spacesInbox = new SpacesInbox();
