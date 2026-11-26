import type { ContentBlock } from "@cohub/protocol/core";
import type { MessageToolCallsFile } from "@cohub/protocol/model";
import type { HarnessKind } from "@cohub/protocol/runtime";
import {
	presentTool,
	type ToolSection,
	type ToolView,
	toolLabel,
} from "@cohub/protocol/tools";
import type { Locale } from "#lib/i18n/locale.ts";
import { m } from "#lib/paraglide/messages.js";
import type { ToolState } from "#lib/session-tree.ts";

const WORKSPACE = "/workspace/";

export type ToolCallStatus = "running" | "done" | "failed";

export type ToolCallPhase = "drafting" | "executing";

export type ToolCallViewModel = {
	id: string;
	name: string;
	input?: Record<string, unknown>;
	view: ToolView;
	result?: string;
	partialResult?: string;
	status: ToolCallStatus;
	phase?: ToolCallPhase;
	durationMs?: number | null;
	resultPartial?: boolean;
	resultOmitted?: boolean;
	resultImages?: Extract<ContentBlock, { type: "image" }>[];
};

export type ToolCallsSummary = {
	count: number;
	names: string;
	failed: number;
	running: boolean;
};

export function summarizeToolCalls(
	content: readonly ContentBlock[],
	harness: HarnessKind,
): ToolCallsSummary {
	const results = indexToolResults(content);
	const counts = new Map<string, number>();
	let count = 0;
	let failed = 0;
	let running = false;
	for (const block of content) {
		if (block.type !== "tool_use") continue;
		count += 1;
		const label = toolLabel(harness, block.name);
		counts.set(label, (counts.get(label) ?? 0) + 1);
		const status = toolCallStatus(block, results.get(block.id), null);
		if (status === "failed") failed += 1;
		if (status === "running") running = true;
	}
	const names = [...counts]
		.map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
		.join(" · ");
	return { count, names, failed, running };
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

export function toolFilePath(view: ToolView, harness: HarnessKind) {
	const path = view.target?.kind === "path" ? view.target.text : "";
	if (harness !== "cohub" || !["read", "write", "edit"].includes(view.verb))
		return null;
	return path.startsWith(WORKSPACE) && path.length > WORKSPACE.length
		? path.slice(WORKSPACE.length)
		: null;
}

export function isLongSection(section: ToolSection): boolean {
	if (section.kind === "diff")
		return (
			section.lines.length > 10 ||
			isLongTextValue(section.before ?? "") ||
			isLongTextValue(section.after ?? "")
		);
	if (section.kind === "todos") return false;
	return isLongTextValue(section.text);
}

export function describeSection(
	section: ToolSection,
	locale?: Locale,
): string | undefined {
	if (section.kind === "text") return describeTextValue(section.text, locale);
	if (section.kind !== "diff") return undefined;
	if (section.before !== undefined || section.after !== undefined) {
		const side = (value?: string) =>
			value === undefined ? "…" : describeTextValue(value, locale);
		return `${side(section.before)} → ${side(section.after)}`;
	}
	const removed = section.lines.filter((line) => line.sign === "-").length;
	const added = section.lines.filter((line) => line.sign === "+").length;
	return [removed && `−${removed}`, added && `+${added}`]
		.filter(Boolean)
		.join(" ");
}

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;
type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;

function indexToolResults(content: readonly ContentBlock[]) {
	const results = new Map<string, ToolResultBlock>();
	for (const block of content) {
		if (block.type === "tool_result" && !results.has(block.tool_use_id)) {
			results.set(block.tool_use_id, block);
		}
	}
	return results;
}

function toolCallStatus(
	block: ToolUseBlock,
	result: ToolResultBlock | undefined,
	fullTool: MessageToolCallsFile["toolCalls"][number] | null,
): ToolCallStatus {
	if (fullTool?.result) return fullTool.result.isError ? "failed" : "done";
	if (result) return result.is_error ? "failed" : "done";
	const metaStatus = block._meta?.toolStatus;
	return metaStatus === "done" ||
		metaStatus === "failed" ||
		metaStatus === "running"
		? metaStatus
		: "running";
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
	harness: HarnessKind;
}): ToolCallViewModel[] {
	const results = indexToolResults(input.content);
	const toolUseBlocks = input.content.filter(
		(block): block is ToolUseBlock => block.type === "tool_use",
	);
	return toolUseBlocks.map((block) => {
		const fullTool =
			input.toolCallsFile?.toolCalls.find((tool) => tool.id === block.id) ??
			null;
		const result = results.get(block.id);
		const status = toolCallStatus(block, result, fullTool);
		const phase =
			status === "running"
				? block._meta?.toolStatus === "running"
					? "executing"
					: "drafting"
				: undefined;
		const resultContent = fullTool?.result
			? stringifyToolValue(fullTool.result.content)
			: result
				? stringifyToolValue(result.content)
				: "";
		const resultImages = toolResultImages(
			fullTool?.result ? fullTool.result.content : (result?.content ?? null),
		);
		const partialResult = stringifyToolValue(block._meta?.partialResult);
		const resultPartial = Boolean(partialResult);
		const durationMs =
			timingDurationMs(fullTool?.meta?.timing) ??
			timingDurationMs(fullTool?.result?.meta?.timing) ??
			timingDurationMs(block._meta?.timing) ??
			timingDurationMs(result?._meta?.timing);
		const toolInput = fullTool?.input ?? block.input;
		return {
			id: block.id,
			name: block.name,
			input: toolInput,
			view: presentTool(input.harness, block.name, toolInput),
			result: resultContent,
			partialResult,
			status,
			phase,
			durationMs,
			resultPartial,
			resultOmitted: result?._meta?.resultDetail === "omitted",
			...(resultImages.length > 0 ? { resultImages } : {}),
		};
	});
}

export function toolStateToViewModel(tool: ToolState): ToolCallViewModel {
	return {
		id: tool.id,
		name: tool.name,
		input: tool.input,
		view: presentTool("cohub", tool.name, tool.input),
		result: tool.output,
		status: tool.status,
	};
}
