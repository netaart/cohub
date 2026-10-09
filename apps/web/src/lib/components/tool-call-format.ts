import type { ContentBlock } from "@cohub/protocol/core";
import type { MessageToolCallsFile } from "@cohub/protocol/model";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import type { ToolState } from "$lib/session-tree";

export type ToolInputField = {
	label: string;
	value: string;
	mono?: boolean;
};

export type ToolInputDiffLine = {
	sign: "+" | "-";
	text: string;
};

export type ToolInputSection = {
	id: string;
	label: string;
	summary?: string;
	kind: "text" | "json" | "diff";
	value?: string;
	lines?: ToolInputDiffLine[];
	collapsible?: boolean;
};

export type ToolInputView = {
	primary?: { value: string };
	fields: ToolInputField[];
	sections: ToolInputSection[];
};

export type ToolCallStatus = "running" | "done" | "failed";

export type ToolCallPhase = "drafting" | "executing";

export type ToolCallViewModel = {
	id: string;
	name: string;
	input?: Record<string, unknown>;
	result?: string;
	partialResult?: string;
	status: ToolCallStatus;
	phase?: ToolCallPhase;
	durationMs?: number | null;
	resultPartial?: boolean;
	resultOmitted?: boolean;
	resultImages?: Extract<ContentBlock, { type: "image" }>[];
};

export function summarizeToolInput(
	name: string,
	input?: Record<string, unknown>,
): string {
	if (!input) return "";
	const command = input.command;
	if (name === "bash") {
		if (typeof command === "string") return `$ ${command}`;
		if (command && typeof command === "object" && "preview" in command) {
			return `$ ${String((command as { preview?: unknown }).preview ?? "")}`;
		}
	}
	if (typeof input.path === "string") {
		if (["read", "write", "edit", "ls"].includes(name)) return input.path;
	}
	if (name === "grep" && typeof input.pattern === "string") {
		return [input.pattern, typeof input.path === "string" ? input.path : null]
			.filter(Boolean)
			.join(" · ");
	}
	if (name === "find" && typeof input.pattern === "string") {
		return [input.pattern, typeof input.path === "string" ? input.path : null]
			.filter(Boolean)
			.join(" · ");
	}
	try {
		return JSON.stringify(input);
	} catch {
		return String(input);
	}
}

export function stringifyToolValue(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		const text = value
			.map((block) => {
				if (
					block &&
					typeof block === "object" &&
					"type" in block &&
					(block as { type?: unknown }).type === "text" &&
					"text" in block
				) {
					return String((block as { text?: unknown }).text ?? "");
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
		if (text) return text;
	}
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

export function formatToolInput(input?: Record<string, unknown>): string {
	if (!input || Object.keys(input).length === 0) return "";
	return JSON.stringify(input, null, 2);
}

function workspacePath(path: string): string {
	return path.startsWith("/workspace/")
		? path.slice("/workspace/".length)
		: path;
}

export function sanitizeToolDomId(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]+/g, "-") || "tool";
}

export function describeTextValue(value: string, locale?: Locale): string {
	const bytes = new TextEncoder().encode(value).length;
	const lines = value.length === 0 ? 0 : value.split("\n").length;
	const size =
		bytes < 1024
			? `${bytes} B`
			: bytes < 1024 * 1024
				? `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
				: `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	return lines === 1
		? m.tool_lines_one({ lines, size }, { locale })
		: m.tool_lines_many({ lines, size }, { locale });
}

export function isLongTextValue(value: string): boolean {
	return value.length > 700 || value.split("\n").length > 10;
}

function primitiveToString(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean")
		return String(value);
	if (value == null) return "null";
	return null;
}

function jsonString(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function addRemainingInputs(
	input: Record<string, unknown>,
	used: Set<string>,
	view: ToolInputView,
) {
	for (const [key, value] of Object.entries(input)) {
		if (used.has(key)) continue;
		const primitive = primitiveToString(value);
		if (primitive !== null) {
			view.fields.push({
				label: key,
				value: primitive,
				mono: typeof value === "string",
			});
			continue;
		}
		const text = jsonString(value);
		view.sections.push({
			id: `json-${key}`,
			label: key,
			kind: "json",
			value: text,
			collapsible: isLongTextValue(text),
		});
	}
}

function replacementDiffLines(
	oldText: string,
	newText: string,
): ToolInputDiffLine[] {
	return [
		...oldText.split("\n").map((text) => ({ sign: "-" as const, text })),
		...newText.split("\n").map((text) => ({ sign: "+" as const, text })),
	];
}

export function formatToolInputView(
	name: string,
	input?: Record<string, unknown>,
	locale?: Locale,
): ToolInputView | null {
	if (!input || Object.keys(input).length === 0) return null;
	const view: ToolInputView = { fields: [], sections: [] };
	const used = new Set<string>();

	if (name === "bash" && typeof input.command === "string") {
		view.primary = { value: input.command };
		used.add("command");
		if (typeof input.timeout === "number") {
			view.fields.push({ label: "timeout", value: `${input.timeout}s` });
			used.add("timeout");
		}
	} else if (
		["read", "write", "edit", "ls"].includes(name) &&
		typeof input.path === "string"
	) {
		view.primary = { value: workspacePath(input.path) };
		used.add("path");
		if (name === "read") {
			const offset =
				typeof input.offset === "number" ? input.offset : undefined;
			const limit = typeof input.limit === "number" ? input.limit : undefined;
			if (offset !== undefined && limit !== undefined) {
				view.fields.push({
					label: "lines",
					value: `${offset}–${offset + limit - 1}`,
				});
				used.add("offset");
				used.add("limit");
			} else if (offset !== undefined) {
				view.fields.push({ label: "offset", value: String(offset) });
				used.add("offset");
			} else if (limit !== undefined) {
				view.fields.push({ label: "limit", value: String(limit) });
				used.add("limit");
			}
		}
		if (name === "write" && typeof input.content === "string") {
			view.sections.push({
				id: "content",
				label: "content",
				summary: describeTextValue(input.content, locale),
				kind: "text",
				value: input.content,
				collapsible: isLongTextValue(input.content),
			});
			used.add("content");
		}
		if (name === "edit" && Array.isArray(input.edits)) {
			view.fields.push({
				label: "edits",
				value:
					input.edits.length === 1
						? m.tool_replacements_one({ count: input.edits.length }, { locale })
						: m.tool_replacements_many(
								{ count: input.edits.length },
								{ locale },
							),
			});
			input.edits.forEach((edit, index) => {
				if (!edit || typeof edit !== "object") {
					const value = jsonString(edit);
					view.sections.push({
						id: `edit-${index + 1}`,
						label: `#${index + 1}`,
						kind: "json",
						value,
						collapsible: isLongTextValue(value),
					});
					return;
				}
				const oldText = (edit as { oldText?: unknown }).oldText;
				const newText = (edit as { newText?: unknown }).newText;
				if (typeof oldText === "string" && typeof newText === "string") {
					view.sections.push({
						id: `edit-${index + 1}`,
						label: `#${index + 1}`,
						summary: `${describeTextValue(oldText, locale)} → ${describeTextValue(newText, locale)}`,
						kind: "diff",
						lines: replacementDiffLines(oldText, newText),
						collapsible: isLongTextValue(oldText) || isLongTextValue(newText),
					});
					return;
				}
				// Streaming partial: render diff progressively as each side arrives.
				if (typeof oldText === "string" || typeof newText === "string") {
					const partialLines: ToolInputDiffLine[] = [];
					if (typeof oldText === "string") {
						partialLines.push(
							...oldText
								.split("\n")
								.map((text) => ({ sign: "-" as const, text })),
						);
					}
					if (typeof newText === "string") {
						partialLines.push(
							...newText
								.split("\n")
								.map((text) => ({ sign: "+" as const, text })),
						);
					}
					const partialSummary = [
						typeof oldText === "string"
							? describeTextValue(oldText, locale)
							: "…",
						typeof newText === "string"
							? describeTextValue(newText, locale)
							: "…",
					].join(" → ");
					view.sections.push({
						id: `edit-${index + 1}`,
						label: `#${index + 1}`,
						summary: partialSummary,
						kind: "diff",
						lines: partialLines,
						collapsible:
							(typeof oldText === "string" && isLongTextValue(oldText)) ||
							(typeof newText === "string" && isLongTextValue(newText)),
					});
					return;
				}
				const value = jsonString(edit);
				view.sections.push({
					id: `edit-${index + 1}`,
					label: `#${index + 1}`,
					kind: "json",
					value,
					collapsible: isLongTextValue(value),
				});
			});
			used.add("edits");
		}
	} else if (
		["grep", "find"].includes(name) &&
		typeof input.pattern === "string"
	) {
		view.primary = { value: input.pattern };
		used.add("pattern");
		if (typeof input.path === "string") {
			view.fields.push({
				label: "path",
				value: workspacePath(input.path),
				mono: true,
			});
			used.add("path");
		}
		for (const key of [
			"glob",
			"ignoreCase",
			"literal",
			"context",
			"limit",
		] as const) {
			const value = input[key];
			const primitive = primitiveToString(value);
			if (primitive !== null && value !== undefined) {
				view.fields.push({
					label: key,
					value: primitive,
					mono: typeof value === "string",
				});
				used.add(key);
			}
		}
	}

	addRemainingInputs(input, used, view);
	return view;
}

/**
 * Returns the workspace-relative file path for read/write/edit tools.
 * Only absolute paths under /workspace are clickable in the tool call UI.
 */
export function getToolFilePath(
	name: string,
	input?: Record<string, unknown>,
): string | null {
	if (!["read", "write", "edit"].includes(name)) return null;
	const path = input?.path;
	if (typeof path !== "string" || !path.startsWith("/workspace/")) return null;
	const relativePath = path.slice("/workspace/".length);
	return relativePath.length > 0 ? relativePath : null;
}

export function isSimpleInput(
	name: string,
	input?: Record<string, unknown>,
): boolean {
	if (!input) return true;
	const keys = Object.keys(input);
	if (keys.length === 0) return true;
	if (
		keys.length === 1 &&
		keys[0] === "path" &&
		typeof input.path === "string"
	) {
		return ["ls", "read", "write"].includes(name);
	}
	if (
		name === "bash" &&
		keys.length === 1 &&
		typeof input.command === "string"
	) {
		return true;
	}
	return false;
}

function findToolResult(content: ContentBlock[], toolUseId: string) {
	return content.find(
		(block) => block.type === "tool_result" && block.tool_use_id === toolUseId,
	);
}

function toolResultImages(value: unknown) {
	return Array.isArray(value)
		? (value as ContentBlock[]).filter(
				(block): block is Extract<ContentBlock, { type: "image" }> =>
					block?.type === "image",
			)
		: [];
}

function timingDurationMs(value: unknown): number | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const durationMs = (value as { durationMs?: unknown }).durationMs;
	return typeof durationMs === "number" && Number.isFinite(durationMs)
		? durationMs
		: null;
}

export function buildToolCallViewModels(input: {
	content: ContentBlock[];
	toolCallsFile?: MessageToolCallsFile | null;
}): ToolCallViewModel[] {
	const toolUseBlocks = input.content.filter(
		(block) => block.type === "tool_use",
	);
	return toolUseBlocks.map((block) => {
		const fullTool =
			input.toolCallsFile?.toolCalls.find((tool) => tool.id === block.id) ??
			null;
		const result = findToolResult(input.content, block.id);
		const metaStatus = block._meta?.toolStatus;
		const status: ToolCallStatus = fullTool?.result
			? fullTool.result.isError
				? "failed"
				: "done"
			: result?.type === "tool_result"
				? result.is_error
					? "failed"
					: "done"
				: metaStatus === "done" ||
						metaStatus === "failed" ||
						metaStatus === "running"
					? metaStatus
					: "running";
		const phase =
			status === "running"
				? metaStatus === "running"
					? "executing"
					: "drafting"
				: undefined;
		const resultContent = fullTool?.result
			? stringifyToolValue(fullTool.result.content)
			: result?.type === "tool_result"
				? stringifyToolValue(result.content)
				: "";
		const resultImages = toolResultImages(
			fullTool?.result
				? fullTool.result.content
				: result?.type === "tool_result"
					? result.content
					: null,
		);
		const partialResult = stringifyToolValue(block._meta?.partialResult);
		const resultPartial = Boolean(partialResult);
		const durationMs =
			timingDurationMs(fullTool?.meta?.timing) ??
			timingDurationMs(fullTool?.result?.meta?.timing) ??
			timingDurationMs(block._meta?.timing) ??
			(result?.type === "tool_result"
				? timingDurationMs(result._meta?.timing)
				: null);
		return {
			id: block.id,
			name: block.name,
			input: fullTool?.input ?? block.input,
			result: resultContent,
			partialResult,
			status,
			phase,
			durationMs,
			resultPartial,
			resultOmitted:
				result?.type === "tool_result" &&
				result._meta?.resultDetail === "omitted",
			...(resultImages.length > 0 ? { resultImages } : {}),
		};
	});
}

export function toolStateToViewModel(tool: ToolState): ToolCallViewModel {
	return {
		id: tool.id,
		name: tool.name,
		input: tool.input,
		result: tool.output,
		status: tool.status,
	};
}
