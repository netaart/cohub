import type { SessionRecord } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";

const ARCHIVED_LABEL_REF = "Archived";
const BATCH_SIZE = 200;

const states = new Map<string, boolean>();
let revision = $state(0);

function bump() {
	revision += 1;
}

export const sessionArchive = {
	/** Read inside `$derived` to re-evaluate when archive state changes. */
	get revision() {
		return revision;
	},

	/** `undefined` means no list or event has reported this session yet. */
	stateOf(sessionId: string): boolean | undefined {
		void revision;
		return states.get(sessionId);
	},

	isArchived(sessionId: string) {
		return sessionArchive.stateOf(sessionId) === true;
	},

	/**
	 * Network pages are authoritative. Cached pages only fill unknown ids so a
	 * stale cache cannot overwrite a newer event or list response.
	 */
	seed(
		records: readonly Pick<SessionRecord, "id" | "isArchived">[],
		options: { authoritative?: boolean } = {},
	) {
		const authoritative = options.authoritative ?? true;
		let changed = false;
		for (const record of records) {
			if (!authoritative && states.has(record.id)) continue;
			const archived = record.isArchived === true;
			if (states.get(record.id) === archived) continue;
			states.set(record.id, archived);
			changed = true;
		}
		if (changed) bump();
	},

	mark(sessionIds: readonly string[], archived: boolean) {
		let changed = false;
		for (const sessionId of sessionIds) {
			if (states.get(sessionId) === archived) continue;
			states.set(sessionId, archived);
			changed = true;
		}
		if (changed) bump();
	},

	/** Read archive flags from a `label.assignments.updated` user event. */
	applyAssignments(
		assignments: readonly {
			resourceRef: string;
			assignments: readonly { labelSystemKey?: string | null }[];
		}[],
	) {
		for (const entry of assignments) {
			sessionArchive.mark(
				[entry.resourceRef],
				entry.assignments.some(
					(assignment) => assignment.labelSystemKey === "user:archived",
				),
			);
		}
	},
};

async function patchArchive(
	sessionIds: readonly string[],
	archived: boolean,
): Promise<void> {
	for (let index = 0; index < sessionIds.length; index += BATCH_SIZE) {
		await sdk.user.labels.patchResourceLabelsBatch(
			"session",
			sessionIds.slice(index, index + BATCH_SIZE),
			archived
				? { addLabelRefs: [ARCHIVED_LABEL_REF] }
				: { removeLabelRefs: [ARCHIVED_LABEL_REF] },
		);
	}
}

/**
 * Archive or restore chats in the viewer's personal list. State flips
 * optimistically so rows leave or enter lists immediately.
 */
export async function setSessionsArchived(
	sessionIds: readonly string[],
	archived: boolean,
): Promise<boolean> {
	const ids = [...new Set(sessionIds)];
	if (ids.length === 0) return true;
	const previous = ids.map((id) => sessionArchive.stateOf(id));
	sessionArchive.mark(ids, archived);
	try {
		await patchArchive(ids, archived);
		return true;
	} catch (error) {
		ids.forEach((id, index) => {
			sessionArchive.mark([id], previous[index] ?? false);
		});
		console.error("[session-archive] failed to update archive state", error);
		return false;
	}
}
