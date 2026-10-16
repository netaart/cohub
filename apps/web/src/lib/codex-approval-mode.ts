import {
	type CodexApprovalMode,
	codexApprovalModeSchema,
} from "@cohub/protocol";

export const CODEX_APPROVAL_CHOICES = [
	"inherit",
	"auto",
	"full_access",
	"read_only",
] as const satisfies readonly CodexApprovalMode[];

type ApprovalTurn = {
	harness?: "cohub" | "pi" | "codex";
	executionKind?: string | null;
	meta?: Record<string, unknown> | null;
};

/** Keep explicit session choices across harness changes and native follow-ups. */
export function resolveCodexApprovalModeFromTurns(
	turns: readonly ApprovalTurn[],
): CodexApprovalMode | undefined {
	for (let index = turns.length - 1; index >= 0; index--) {
		const turn = turns[index];
		if (
			turn.executionKind === "direct_generation" ||
			(turn.meta?.harness ?? turn.harness) !== "codex" ||
			turn.meta?.codexApprovalMode === undefined
		)
			continue;
		const parsed = codexApprovalModeSchema.safeParse(
			turn.meta.codexApprovalMode,
		);
		if (!parsed.success)
			throw new Error("Invalid Codex approval mode in session history");
		return parsed.data;
	}
	return undefined;
}

export function buildCodexApprovalRequest(
	harness: "cohub" | "pi" | "codex",
	mode: CodexApprovalMode | undefined,
	supportedModes: readonly CodexApprovalMode[] | undefined,
): { codexApprovalMode?: CodexApprovalMode } {
	if (harness !== "codex" || mode === undefined) return {};
	if (!supportedModes?.includes(mode)) {
		throw new Error(
			"The connected Runtime does not support this Codex approval mode",
		);
	}
	return { codexApprovalMode: mode };
}

export type PendingCodexApprovalChoice = {
	mode: CodexApprovalMode;
	revision: number;
};

/** Acknowledged choices belong to server history; only unsent choices override it. */
export function finishCodexApprovalChoice(
	choices: Record<string, PendingCodexApprovalChoice>,
	key: string,
	sent: PendingCodexApprovalChoice | undefined,
): Record<string, PendingCodexApprovalChoice> {
	if (!sent || choices[key]?.revision !== sent.revision) return choices;
	const next = { ...choices };
	delete next[key];
	return next;
}
