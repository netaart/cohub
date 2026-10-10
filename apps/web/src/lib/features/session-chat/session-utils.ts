import { resolveHarness } from "@cohub/protocol";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import type { SessionRecord, TaskRunRecord } from "@neta-art/cohub";
import {
	getRequestedThinkingLevel,
	type LocalModelSelection,
	type ModelCatalogItem,
} from "$lib/model-catalog";
import { mergeTurnsById } from "$lib/stores/turn-cache";
import type { SessionViewState } from "./session-workspace-controller.svelte";

export {
	areSessionTurnRecordsEqual,
	areSessionTurnsEqual,
	preserveSessionTurnRefs,
} from "$lib/session-turn-equality";

type HarnessTurn = {
	meta?: Record<string, unknown> | null;
	harness?: "cohub" | "pi" | "codex";
};
export const resolveTurnHarness = (turn?: HarnessTurn) =>
	resolveHarness({ harness: turn?.meta?.harness ?? turn?.harness });
const isCloudTurn = (turn: HarnessTurn) => resolveTurnHarness(turn) === "cohub";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

type ComposerTurnSource = Pick<
	SessionTurnRecord,
	"id" | "sequence" | "executionKind" | "provider" | "model"
> &
	HarnessTurn;

export function resolveLocalModelFromTurns(
	turns: ComposerTurnSource[],
	harness: "cohub" | "pi" | "codex",
): LocalModelSelection | null {
	if (harness === "cohub") return null;
	const previous = turns.findLast(
		(turn) =>
			turn.executionKind !== "direct_generation" &&
			resolveTurnHarness(turn) === harness &&
			turn.model,
	);
	if (!previous?.model) return null;
	const thinkingLevel = getRequestedThinkingLevel(previous.meta);
	return {
		id: previous.model,
		provider: previous.provider ?? harness,
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

export function mergeComposerTurnSources(
	turns: ComposerTurnSource[],
	turnIndex: ComposerTurnSource[],
): ComposerTurnSource[] {
	const byId = new Map(turnIndex.map((turn) => [turn.id, turn]));
	for (const turn of turns) {
		byId.set(turn.id, { ...byId.get(turn.id), ...turn });
	}
	return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

export type SessionComposerSelection =
	| {
			mode: "agent";
			model: { provider: string; id: string; name?: string } | null;
	  }
	| { mode: "create"; modelId: string | null };

export function shouldClearComposerDraftAfterSend(
	mode: SessionComposerSelection["mode"],
) {
	return mode === "agent";
}

export function resolveComposerSelectionFromTurn(
	turn: Pick<SessionTurnRecord, "executionKind" | "provider" | "model"> &
		HarnessTurn,
	catalog: ModelCatalogItem[] | null | undefined,
): SessionComposerSelection {
	if (turn.executionKind === "direct_generation") {
		return { mode: "create", modelId: turn.model ?? null };
	}
	if (!turn.model || !isCloudTurn(turn)) return { mode: "agent", model: null };
	const provider = turn.provider ?? "cohub";
	const catalogItem = catalog?.find(
		(item) => item.provider === provider && item.id === turn.model,
	);
	return {
		mode: "agent",
		model: {
			provider,
			id: turn.model,
			name: catalogItem?.model.name as string | undefined,
		},
	};
}

function tailText(value: unknown, limit = 420) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

export function resolveLastAgentTurnModel(
	turns: Array<
		Pick<
			SessionTurnRecord,
			"sequence" | "executionKind" | "provider" | "model"
		> &
			HarnessTurn
	>,
	catalog: ModelCatalogItem[] | null | undefined,
): { provider: string; id: string; name?: string } | null {
	const lastTurn = [...turns]
		.filter(
			(turn) =>
				turn.executionKind !== "direct_generation" &&
				isCloudTurn(turn) &&
				typeof turn.model === "string" &&
				turn.model.trim(),
		)
		.sort((a, b) => a.sequence - b.sequence)
		.at(-1);
	if (!lastTurn?.model) return null;
	const provider = lastTurn.provider ?? "cohub";
	const catalogItem = catalog?.find(
		(item) => item.id === lastTurn.model && item.provider === provider,
	);
	return {
		provider,
		id: lastTurn.model,
		name: catalogItem?.model.name as string | undefined,
	};
}

export function getSessionTitle(session: SessionRecord): string {
	const candidates = [session.title, session.latestMessageText];
	for (const candidate of candidates) {
		const normalized = candidate
			?.replace(/\s+/g, " ")
			.replace(/^[:\-\s]+/, "")
			.trim();
		if (normalized) return normalized.slice(0, 36);
	}
	return "New chat";
}

export function extractBackgroundBashResultPreview(result: unknown) {
	const content = asRecord(result)?.content;
	if (!Array.isArray(content)) return null;
	for (const block of content) {
		const record = asRecord(block);
		if (record?.type === "tool_result") return tailText(record.content);
	}
	return null;
}

export function formatBackgroundBashSubtitle(run: TaskRunRecord) {
	const result = asRecord(run.result);
	const parts = [
		run.status === "completed"
			? "Completed"
			: run.status === "failed"
				? "Failed"
				: run.status === "pending"
					? "Queued"
					: "Running",
		typeof result?.exitCode === "number" ? `exit ${result.exitCode}` : null,
		typeof result?.durationMs === "number"
			? `${Math.max(1, Math.round(result.durationMs / 1000))}s`
			: null,
	].filter(Boolean);
	return parts.join(" · ") || null;
}

export function getTurnClientMessageId(turn: Pick<SessionTurnRecord, "meta">) {
	const value = turn.meta?.clientMessageId;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isOptimisticTurn(turn: Pick<SessionTurnRecord, "meta">) {
	return turn.meta?.optimistic === true;
}

export function withOptimisticMetaCleared(turn: SessionTurnRecord) {
	if (!isOptimisticTurn(turn)) return turn;
	const meta = turn.meta ? { ...turn.meta } : null;
	if (meta && "optimistic" in meta) delete meta.optimistic;
	return { ...turn, meta };
}

export function isSameClientMessageTurn(
	turn: Pick<SessionTurnRecord, "meta">,
	clientMessageId: string | null,
) {
	return Boolean(
		clientMessageId && getTurnClientMessageId(turn) === clientMessageId,
	);
}

export function reconcileOptimisticTurn(
	turns: SessionTurnRecord[],
	confirmedTurn: SessionTurnRecord,
) {
	const clientMessageId = getTurnClientMessageId(confirmedTurn);
	let remapped = false;
	const nextTurns = turns.map((turn) => {
		if (!isOptimisticTurn(turn)) return turn;
		if (!isSameClientMessageTurn(turn, clientMessageId)) return turn;
		remapped = true;
		const meta = {
			...(turn.meta ?? {}),
			...(confirmedTurn.meta ?? {}),
		};
		delete meta.optimistic;
		return {
			...withOptimisticMetaCleared(turn),
			id: confirmedTurn.id,
			sequence: confirmedTurn.sequence,
			status: confirmedTurn.status,
			userUuid: confirmedTurn.userUuid ?? turn.userUuid,
			userContent: confirmedTurn.userContent,
			userText: confirmedTurn.userText ?? turn.userText,
			provider: confirmedTurn.provider ?? turn.provider,
			model: confirmedTurn.model ?? turn.model,
			createdAt: confirmedTurn.createdAt,
			updatedAt: confirmedTurn.updatedAt,
			meta,
		};
	});
	return {
		turns: remapped
			? mergeTurnsById([], nextTurns, { preferIncoming: true })
			: turns,
		remapped,
	};
}

export function adoptPromptSessionState(input: {
	existing?: SessionViewState;
	session: SessionRecord;
	turn: SessionTurnRecord;
}): SessionViewState {
	return {
		session: input.session,
		turns: normalizeTurnDuplicates(
			mergeTurnsById(input.existing?.turns ?? [], [input.turn], {
				preferIncoming: true,
			}),
		),
		loading: false,
		loaded: true,
		error: null,
		hasMore: false,
		hasMoreNewer: false,
		loadingOlder: false,
		loadingNewer: false,
		oldestCursor: undefined,
	};
}

export function normalizeTurnDuplicates(turns: SessionTurnRecord[]) {
	const optimistic = turns.filter((turn) => turn.meta?.optimistic === true);
	const confirmed = turns.filter((turn) => turn.meta?.optimistic !== true);
	const confirmedClientMessageIds = new Set(
		confirmed
			.map(getTurnClientMessageId)
			.filter((value): value is string => Boolean(value)),
	);
	const optimisticByClientMessageId = new Map(
		optimistic
			.map((turn) => [getTurnClientMessageId(turn), turn] as const)
			.filter((entry): entry is [string, SessionTurnRecord] =>
				Boolean(entry[0]),
			),
	);
	return mergeTurnsById(
		optimistic.filter((turn) => {
			const clientMessageId = getTurnClientMessageId(turn);
			return (
				!clientMessageId || !confirmedClientMessageIds.has(clientMessageId)
			);
		}),
		confirmed.map((turn) => {
			const optimisticTurn = optimisticByClientMessageId.get(
				getTurnClientMessageId(turn) ?? "",
			);
			if (!optimisticTurn) return turn;
			return {
				...turn,
				userUuid: turn.userUuid ?? optimisticTurn.userUuid,
				authorProfile: turn.authorProfile ?? optimisticTurn.authorProfile,
			};
		}),
		{ preferIncoming: true },
	);
}
