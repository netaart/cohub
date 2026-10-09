import type { ContentBlock } from "@cohub/protocol/core";
import type { SessionRecord } from "@neta-art/cohub";
import type { Locale } from "$lib/i18n/locale";
import { getModelDisplayName, type ModelCatalogItem } from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";
import type { SessionGenerationState } from "$lib/stores/session-generation.svelte";

type SessionActiveTurn = NonNullable<SessionRecord["activeTurn"]>;
type SessionTurnIssue = NonNullable<SessionRecord["lastTurnIssue"]>;

export type SessionSidebarActivityPhase =
	| "idle"
	| "pending"
	| "waiting_model"
	| "streaming"
	| "thinking"
	| "tool"
	| "result"
	| "queued"
	| "failed"
	| "interrupted";

export type SessionSidebarActivity = {
	active: boolean;
	phase: SessionSidebarActivityPhase;
	label: string;
	text: string | null;
	progressKey: string;
};

const INLINE_TEXT_LIMIT = 76;
const TOOL_TEXT_LIMIT = 58;

function stripControlCharacters(value: string) {
	return Array.from(value, (char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127 ? " " : char;
	}).join("");
}

function compactInlineText(value: unknown, limit = INLINE_TEXT_LIMIT): string {
	const raw = typeof value === "string" ? value : stringifyCompact(value);
	const normalized = stripControlCharacters(raw).replace(/\s+/g, " ").trim();
	if (normalized.length <= limit) return normalized;
	return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function stringifyCompact(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function blockText(block: ContentBlock): string {
	if (block.type === "text") return block.text;
	if (block.type === "thinking") return block.thinking;
	if (block.type === "shell_command") return block.rawText || block.command;
	if (block.type === "tool_use") return previewToolInput(block.input);
	if (block.type === "tool_result") return previewToolResult(block.content);
	return "";
}

function previewToolInput(input: Record<string, unknown>) {
	const preferredKeys = [
		"path",
		"file_path",
		"pattern",
		"command",
		"query",
		"url",
		"prompt",
		"oldText",
		"newText",
	];
	const parts: string[] = [];
	for (const key of preferredKeys) {
		const value = input[key];
		const text = compactInlineText(value, 34);
		if (text)
			parts.push(
				key === "command" || key === "path" ? text : `${key}: ${text}`,
			);
		if (parts.length >= 2) break;
	}
	return parts.length > 0 ? parts.join(" ") : stringifyCompact(input);
}

function previewToolResult(content: string | ContentBlock[]) {
	if (typeof content === "string") return content;
	return content.map(blockText).filter(Boolean).join(" ");
}

function previewPartialResult(value: unknown) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return previewToolResult(value as ContentBlock[]);
	return "";
}

function findToolNameForResult(blocks: ContentBlock[], resultIndex: number) {
	const result = blocks[resultIndex];
	if (result?.type !== "tool_result") return null;
	for (let index = resultIndex - 1; index >= 0; index -= 1) {
		const block = blocks[index];
		if (block?.type === "tool_use" && block.id === result.tool_use_id)
			return block.name;
	}
	return null;
}

function findLatestSignal(blocks: ContentBlock[], locale: Locale) {
	for (let index = blocks.length - 1; index >= 0; index -= 1) {
		const block = blocks[index];
		if (!block) continue;
		if (block.type === "tool_result") {
			const name = findToolNameForResult(blocks, index);
			const text = compactInlineText(
				previewToolResult(block.content),
				TOOL_TEXT_LIMIT,
			);
			return {
				phase: "result" as const,
				label:
					name ??
					(block.is_error
						? m.session_activity_tool_error({}, { locale })
						: m.session_activity_tool_result({}, { locale })),
				text: text || null,
				progressKey: `result:${block.tool_use_id}:${index}`,
			};
		}
		if (block.type === "tool_use") {
			const partialText = compactInlineText(
				previewPartialResult(block._meta?.partialResult),
				TOOL_TEXT_LIMIT,
			);
			const text =
				partialText ||
				compactInlineText(previewToolInput(block.input), TOOL_TEXT_LIMIT);
			return {
				phase: partialText ? ("result" as const) : ("tool" as const),
				label: block.name,
				text: text || null,
				progressKey: `tool:${block.id}:${index}:${partialText.length}`,
			};
		}
		if (block.type === "shell_command") {
			const text = compactInlineText(
				block.rawText || block.command,
				TOOL_TEXT_LIMIT,
			);
			return {
				phase: "tool" as const,
				label: m.session_activity_command({}, { locale }),
				text: text || null,
				progressKey: `shell-command:${index}`,
			};
		}
		if (block.type === "thinking") {
			const text = compactInlineText(block.thinking);
			if (text) {
				return {
					phase: "thinking" as const,
					label: m.session_activity_thinking({}, { locale }),
					text,
					progressKey: `thinking:${index}`,
				};
			}
		}
		if (block.type === "text") {
			const text = compactInlineText(block.text);
			if (text) {
				return {
					phase: "streaming" as const,
					label: m.session_activity_writing({}, { locale }),
					text,
					progressKey: `text:${index}`,
				};
			}
		}
	}
	return null;
}

const idleActivity: SessionSidebarActivity = {
	active: false,
	phase: "idle",
	label: "idle",
	text: null,
	progressKey: "idle",
};

function activeTurnActivity(
	activeTurn: SessionActiveTurn,
	locale: Locale,
): SessionSidebarActivity {
	const label =
		activeTurn.status === "queued"
			? m.session_activity_queued({}, { locale })
			: activeTurn.status === "abort_requested"
				? m.session_activity_stopping({}, { locale })
				: m.session_activity_running({}, { locale });
	return {
		active: true,
		phase: activeTurn.status === "queued" ? "queued" : "pending",
		label,
		text: null,
		progressKey: `${activeTurn.status}:${activeTurn.id}`,
	};
}

function issueActivity(
	issue: SessionTurnIssue,
	locale: Locale,
): SessionSidebarActivity {
	if (issue.status === "failed") {
		return {
			active: false,
			phase: "failed",
			label: m.session_activity_failed({}, { locale }),
			text: compactInlineText(issue.errorMessage) || null,
			progressKey: `failed:${issue.turnId}`,
		};
	}
	const label =
		issue.reason === "abort"
			? m.session_activity_stopped({}, { locale })
			: issue.reason === "stale_active_recovered"
				? m.session_activity_run_lost({}, { locale })
				: m.session_activity_interrupted({}, { locale });
	return {
		active: false,
		phase: "interrupted",
		label,
		text: null,
		progressKey: `interrupted:${issue.turnId}`,
	};
}

export function getSessionSidebarActivity(
	state: SessionGenerationState | null | undefined,
	options: {
		locale: Locale;
		modelsCatalog?: ModelCatalogItem[] | null;
		session?: Pick<SessionRecord, "activeTurn" | "lastTurnIssue">;
	},
): SessionSidebarActivity {
	const { locale, modelsCatalog, session } = options;
	const activeTurn = session?.activeTurn;
	if (activeTurn) {
		const live =
			activeTurn.status === "running" && state?.turnId === activeTurn.id
				? detailFor(state, modelsCatalog, locale)
				: null;
		return live?.active ? live : activeTurnActivity(activeTurn, locale);
	}
	const issue = session?.lastTurnIssue;
	const newerLocalTurn =
		(state?.status === "pending" || state?.status === "streaming") &&
		state.turnId !== issue?.turnId;
	if (issue && !newerLocalTurn) return issueActivity(issue, locale);
	if (activeTurn === null) return idleActivity;
	return state ? detailFor(state, modelsCatalog, locale) : idleActivity;
}

function detailFor(
	state: SessionGenerationState,
	modelsCatalog: ModelCatalogItem[] | null | undefined,
	locale: Locale,
): SessionSidebarActivity {
	if (state.status === "failed") {
		return {
			active: false,
			phase: "failed",
			label: m.session_activity_failed({}, { locale }),
			text: compactInlineText(state.error, 58) || null,
			progressKey: "failed",
		};
	}
	if (state.status === "interrupted") {
		return {
			active: false,
			phase: "interrupted",
			label: m.session_activity_interrupted({}, { locale }),
			text: null,
			progressKey: "interrupted",
		};
	}
	if (state.runtimePhase === "llm_call_started") {
		const model = compactInlineText(
			getModelDisplayName(modelsCatalog, {
				provider: state.runtimeProvider,
				model: state.runtimeModel,
			}),
			42,
		);
		return {
			active: true,
			phase: "waiting_model",
			label: model
				? m.session_activity_waiting_model({ model }, { locale })
				: m.session_activity_waiting({}, { locale }),
			text: null,
			progressKey: `waiting:${state.turnId ?? state.sessionId}:${state.llmRound ?? 1}`,
		};
	}
	if (state.status === "pending") {
		return {
			active: true,
			phase: "pending",
			label: m.session_activity_starting({}, { locale }),
			text: null,
			progressKey: state.turnId ?? "pending",
		};
	}
	if (state.status === "streaming") {
		const messageSources = [...(state.intermediateMessages ?? [])].reverse();
		for (const message of messageSources) {
			const signal = findLatestSignal(message.content, locale);
			if (signal) return { active: true, ...signal };
		}
		const signal = findLatestSignal(state.contentBlocks, locale);
		if (signal) return { active: true, ...signal };
		return {
			active: true,
			phase: "streaming",
			label: m.session_activity_writing({}, { locale }),
			text: null,
			progressKey: state.turnId ?? "streaming",
		};
	}
	return idleActivity;
}
