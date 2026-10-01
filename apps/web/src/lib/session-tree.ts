import type { ContentBlock } from "@cohub/protocol/core";
import type {
	MessageToolCallsFile,
	SessionTurnIntermediateSummary,
	SessionTurnRecord,
} from "@cohub/protocol/model";

export type ChatMessage = {
	id: string;
	sourceId?: string;
	role: "user" | "assistant" | "system";
	content: ContentBlock[];
	text: string;
	sequence: number;
	blocks?: ContentBlock[];
	authorUuid?: string | null;
	authorProfile?: {
		userUuid: string;
		username?: string | null;
		displayName: string;
		avatarUrl: string | null;
	} | null;
	createdAt: string;
	meta?: {
		messageKind?: string | null;
		turn?: SessionTurnRecord | null;
		streaming?: boolean;
		turnId?: string | null;
		sessionId?: string | null;
		model?: string | null;
		provider?: string | null;
		contextWindow?: number | null;
		usage?: SessionTurnRecord["finalUsage"];
		durationMs?: number | null;
		stopReason?: string | null;
		errorMessage?: string | null;
		llmTiming?: unknown;
	};
	toolCallsLoader?: (() => Promise<MessageToolCallsFile | null>) | null;
};

export type ToolState = {
	id: string;
	name: string;
	input?: Record<string, unknown>;
	status: "running" | "done" | "failed";
	output: string;
};

export type TurnFooterPhase =
	| "starting"
	| "starting_generation"
	| "waiting_model";

export type TimelineItem =
	| {
			id: string;
			kind: "message";
			message: ChatMessage;
	  }
	| {
			id: string;
			kind: "tool";
			tool: ToolState;
	  }
	| {
			id: string;
			kind: "process";
			turn: SessionTurnRecord;
			summary?: SessionTurnIntermediateSummary;
			intermediateMessages?: import("@cohub/protocol/model").StoredIntermediateMessage[];
			streaming?: boolean;
	  }
	| {
			id: string;
			kind: "turn_footer";
			phase: TurnFooterPhase;
			runtimeProvider?: string | null;
			runtimeModel?: string | null;
	  }
	| {
			id: string;
			kind: "compact";
			turn: SessionTurnRecord;
	  };

export const stringifyUnknown = (value: unknown) => {
	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
};

export const renderToolPreview = (
	name: string,
	input?: Record<string, unknown>,
) => {
	if (name === "bash" && typeof input?.command === "string") {
		return `$ ${input.command}`;
	}

	if (name === "read" && typeof input?.path === "string") {
		return `read ${input.path}`;
	}

	if (name === "find" && typeof input?.pattern === "string") {
		return `find ${input.pattern}`;
	}

	if (name === "grep" && typeof input?.pattern === "string") {
		return `grep ${input.pattern}`;
	}

	if (name === "write" && typeof input?.path === "string") {
		return `write ${input.path}`;
	}

	if (name === "edit" && typeof input?.path === "string") {
		return `edit ${input.path}`;
	}

	return stringifyUnknown(input ?? {});
};
