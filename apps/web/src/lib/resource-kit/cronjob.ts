import type { ModelThinkingLevel } from "@cohub/protocol";
import { m } from "../paraglide/messages.js";
import { asRecord, type Locale } from "./core.ts";

export type CronjobSelectedModel = {
	provider: string;
	id: string;
	name?: string;
	thinkingLevel?: ModelThinkingLevel | null;
};

export function formatContentBlockForPreview(block: unknown): string {
	const record = asRecord(block);
	if (!record)
		return typeof block === "string" ? block : JSON.stringify(block, null, 2);
	if (record.type === "text" && typeof record.text === "string") {
		return record.text;
	}
	if (record.type === "thinking" && typeof record.thinking === "string") {
		return `[thinking]\n${record.thinking}`;
	}
	if (record.type === "image") return "[image attachment]";
	if (record.type === "tool_use" && typeof record.name === "string") {
		return `[tool use: ${record.name}]\n${JSON.stringify(record.input ?? {}, null, 2)}`;
	}
	if (record.type === "tool_result") return "[tool result]";
	return JSON.stringify(record, null, 2);
}

export function cronjobPayloadContent(payload: unknown): unknown {
	return asRecord(payload)?.content;
}

export function formatCronjobPrompt(payload: unknown): string {
	const content = cronjobPayloadContent(payload);
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const preview = content
			.map(formatContentBlockForPreview)
			.map((part) => part.trim())
			.filter(Boolean)
			.join("\n\n");
		return preview || JSON.stringify(content, null, 2);
	}
	if (content !== undefined) return JSON.stringify(content, null, 2);
	return "—";
}

export function cronjobPromptMeta(payload: unknown, locale?: Locale): string {
	const content = cronjobPayloadContent(payload);
	const chars = (count: number) => m.cron_prompt_chars({ count }, { locale });
	if (Array.isArray(content)) {
		const textLength = content.reduce((sum, block) => {
			const record = asRecord(block);
			return sum + (typeof record?.text === "string" ? record.text.length : 0);
		}, 0);
		const count = content.length;
		const blocks =
			count === 1
				? m.cron_prompt_blocks_one({ count }, { locale })
				: m.cron_prompt_blocks_many({ count }, { locale });
		return textLength ? `${blocks} · ${chars(textLength)}` : blocks;
	}
	if (typeof content === "string") return chars(content.length);
	return m.cron_payload({}, { locale });
}

export function cronjobPayloadField(payload: unknown, key: string): string {
	const value = asRecord(payload)?.[key];
	if (typeof value === "string" && value.trim()) return value;
	return "—";
}

export function promptTextFromPayload(payload: unknown): {
	text: string;
	structured: boolean;
} {
	const content = cronjobPayloadContent(payload);
	if (typeof content === "string") return { text: content, structured: false };
	if (Array.isArray(content)) {
		if (content.length === 1) {
			const block = asRecord(content[0]);
			if (block?.type === "text" && typeof block.text === "string") {
				return { text: block.text, structured: false };
			}
		}
		return { text: formatCronjobPrompt(payload), structured: true };
	}
	return { text: "", structured: false };
}

export function buildSendMessagePayload(
	originalPayload: unknown,
	prompt: string,
	model: CronjobSelectedModel | null,
) {
	const next: Record<string, unknown> = {
		...(asRecord(originalPayload) ?? {}),
		content: [{ type: "text", text: prompt.trim() }],
	};
	if (model) {
		next.provider = model.provider;
		next.model = model.id;
		if (model.thinkingLevel) next.thinkingLevel = model.thinkingLevel;
		else delete next.thinkingLevel;
	} else {
		delete next.provider;
		delete next.model;
		delete next.thinkingLevel;
	}
	return next;
}

export function cronjobModelLabel(model: CronjobSelectedModel | null) {
	if (!model) return "Default model";
	return model.name?.trim() || model.id;
}

export function defaultTimezone() {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function validateCronjobForm(input: {
	title: string;
	cronExpression: string;
	timezone: string;
	prompt: string;
}) {
	if (!input.title.trim()) return "Title is required";
	if (!input.cronExpression.trim()) return "Cron expression is required";
	if (!input.timezone.trim()) return "Timezone is required";
	if (!input.prompt.trim()) return "Prompt message is required";
	const cronParts = input.cronExpression.trim().split(/\s+/);
	if (cronParts.length !== 5) {
		return "Invalid cron expression format. Expected 5 fields, e.g. 0 9 * * *.";
	}
	return "";
}
