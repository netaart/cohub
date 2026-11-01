import { isAgentTurn, type SessionTurnRecord } from "@cohub/protocol/model";
import type { CreateSpacePromptInput } from "@neta-art/cohub";
import { sessionTurnsRepo } from "$lib/cache/repositories/session-turns-repo";
import {
	resolveApprovalModeFromTurns,
	resolveLocalModelFromTurns,
	resolveTurnHarness,
} from "$lib/features/session-chat/session-utils";
import { sdk } from "$lib/sdk";

export type SessionReplyRuntime = Pick<
	CreateSpacePromptInput,
	| "harness"
	| "model"
	| "provider"
	| "thinkingLevel"
	| "approvalMode"
	| "serviceTier"
>;

export async function resolveSessionReplyRuntime(
	spaceId: string,
	sessionId: string,
): Promise<SessionReplyRuntime> {
	const lastAgentTurn = (turns: readonly SessionTurnRecord[] | undefined) =>
		turns?.findLast(isAgentTurn);
	const latest = await sdk
		.space(spaceId)
		.session(sessionId)
		.turns.listPaginated({ limit: 5 })
		.catch(() => null);
	const turns = latest
		? latest.turns
		: (await sessionTurnsRepo.find(sessionId).catch(() => null))?.turns;
	const turn = lastAgentTurn(turns);
	const harness = resolveTurnHarness(turn);
	if (harness === "cohub") return {};
	const local = resolveLocalModelFromTurns(turn ? [turn] : [], harness);
	// A reply keeps the conversation's permissions rather than falling back to the Harness defaults.
	const approvalMode = resolveApprovalModeFromTurns(turns ?? [], harness);
	return {
		harness,
		...(approvalMode ? { approvalMode } : {}),
		...(local
			? {
					model: local.id,
					provider: local.provider,
					...(local.thinkingLevel
						? { thinkingLevel: local.thinkingLevel }
						: {}),
					...(local.serviceTier ? { serviceTier: local.serviceTier } : {}),
				}
			: {}),
	};
}
