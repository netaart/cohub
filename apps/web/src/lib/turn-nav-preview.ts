import type { ContentBlock } from "@cohub/protocol/core";
import type {
	SessionTurnAuthorProfile,
	SessionTurnIndexItem,
	SessionTurnIntent,
	SessionTurnRecord,
} from "@cohub/protocol/model";

const IMAGE_ONLY_URL_RE =
	/^(?:https?:\/\/\S+|data:image\/[a-z0-9.+-]+;base64,\S+)$/i;
const IMAGE_LABEL_RE = /^(\d+)\s+images$/i;
const TRAILING_IMAGE_LABEL_RE = /(?:\s*[·•]\s*)?(?:(\d+)\s+images|image)\s*$/i;

function imageLabel(count: number) {
	return count === 1 ? "Image" : `${count} images`;
}

function normalizeWhitespace(value: string) {
	return value.replace(/\s+/g, " ").trim();
}

function countImagesInContent(content: ContentBlock[] | null | undefined) {
	if (!content?.length) return 0;
	return content.reduce(
		(count, block) => count + (block.type === "image" ? 1 : 0),
		0,
	);
}

function textFromContent(content: ContentBlock[] | null | undefined) {
	if (!content?.length) return null;
	const parts: string[] = [];
	for (const block of content) {
		switch (block.type) {
			case "text": {
				const text = normalizeWhitespace(block.text);
				if (text) parts.push(text);
				break;
			}
			case "shell_command":
				parts.push(`$${block.command}`);
				break;
			case "system_note": {
				const text = normalizeWhitespace(block.text);
				if (text) parts.push(text);
				break;
			}
			default:
				break;
		}
	}
	const text = normalizeWhitespace(parts.join(" "));
	return text || null;
}

/** Split stored/legacy previews into body text + image count. */
function parseStoredPreview(preview: string): {
	text: string | null;
	imageCount: number;
} {
	const parts = preview
		.split(/\n+/)
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) return { text: null, imageCount: 0 };

	const textParts: string[] = [];
	let imageCount = 0;

	for (const part of parts) {
		if (IMAGE_ONLY_URL_RE.test(part)) {
			imageCount += 1;
			continue;
		}
		if (/^image$/i.test(part)) {
			imageCount += 1;
			continue;
		}
		const multi = part.match(IMAGE_LABEL_RE);
		if (multi) {
			imageCount += Number(multi[1]) || 0;
			continue;
		}

		// "look · Image" / "look · 2 images" from write-path previews
		const trailing = part.match(TRAILING_IMAGE_LABEL_RE);
		if (trailing && trailing.index != null && trailing.index > 0) {
			const head = part.slice(0, trailing.index).trim();
			if (head) textParts.push(head);
			if (trailing[1]) imageCount += Number(trailing[1]) || 0;
			else imageCount += 1;
			continue;
		}

		textParts.push(part);
	}

	const text = normalizeWhitespace(textParts.join(" "));
	return { text: text || null, imageCount };
}

function parseTurnNavPreview(turn: {
	userPreview?: string | null;
	intent?: SessionTurnIntent | null;
	userContent?: ContentBlock[] | null;
}): { text: string | null; imageCount: number; compact: boolean } {
	if (turn.intent === "compact") {
		return { text: "Context compacted", imageCount: 0, compact: true };
	}
	if (turn.intent === "goal") {
		return { text: "Continuing goal", imageCount: 0, compact: true };
	}

	const contentImageCount = countImagesInContent(turn.userContent);
	const contentText = textFromContent(turn.userContent);
	if (contentText || contentImageCount > 0) {
		return {
			text: contentText,
			imageCount: contentImageCount,
			compact: false,
		};
	}

	const raw = turn.userPreview?.trim() ?? "";
	if (!raw) return { text: null, imageCount: 0, compact: false };

	const parsed = parseStoredPreview(raw);
	return { text: parsed.text, imageCount: parsed.imageCount, compact: false };
}

/** Compact preview length for turn navigator / rail jump lists (~3 lines). */
export const TURN_NAV_PREVIEW_MAX_LENGTH = 180;

export function truncateTurnNavPreview(
	value: string,
	maxLength = TURN_NAV_PREVIEW_MAX_LENGTH,
): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

export function formatTurnNavPreview(turn: {
	userPreview?: string | null;
	intent?: SessionTurnIntent | null;
	userContent?: ContentBlock[] | null;
}): string {
	const parsed = parseTurnNavPreview(turn);
	if (parsed.compact) return "Context compacted";
	if (parsed.text) return parsed.text;
	// Pure attachments leave the body empty; meta line carries the label.
	if (parsed.imageCount > 0) return "";
	return "Empty message";
}

/** Display-ready body for navigator lists: full text for short, truncated for long. */
export function formatTurnNavPreviewDisplay(turn: {
	userPreview?: string | null;
	intent?: SessionTurnIntent | null;
	userContent?: ContentBlock[] | null;
}): string {
	return truncateTurnNavPreview(formatTurnNavPreview(turn));
}

export function getTurnNavAttachmentLabel(turn: {
	userPreview?: string | null;
	intent?: SessionTurnIntent | null;
	userContent?: ContentBlock[] | null;
}): string | null {
	const parsed = parseTurnNavPreview(turn);
	if (parsed.compact || parsed.imageCount <= 0) return null;
	return imageLabel(parsed.imageCount);
}

export function getTurnNavAuthorName(turn: {
	userUuid?: string | null;
	authorProfile?: SessionTurnAuthorProfile | null;
}): string | null {
	const name = turn.authorProfile?.displayName?.trim();
	if (name) return name;
	return null;
}

/** Only show author names when the visible turn list has multiple distinct users. */
export function shouldShowTurnNavAuthors(
	turns: Array<{ userUuid?: string | null }>,
): boolean {
	const uuids = new Set<string>();
	for (const turn of turns) {
		const uuid = turn.userUuid?.trim();
		if (!uuid) continue;
		uuids.add(uuid);
		if (uuids.size >= 2) return true;
	}
	return false;
}

export function turnRecordToIndexItem(
	turn: SessionTurnRecord,
): SessionTurnIndexItem {
	const contentText = textFromContent(turn.userContent);
	const contentImageCount = countImagesInContent(turn.userContent);
	// Keep a compact stored preview for index merge / search without forcing
	// attachment labels into the body line (UI renders them on the meta row).
	const userPreview =
		contentText ??
		(contentImageCount > 0
			? imageLabel(contentImageCount)
			: turn.userText
				? normalizeWhitespace(turn.userText)
				: null);

	return {
		id: turn.id,
		sessionId: turn.sessionId,
		sourceSessionId: turn.sourceSessionId,
		sourceTurnId: turn.sourceTurnId,
		sequence: turn.sequence,
		status: turn.status,
		intent: turn.intent,
		userUuid: turn.userUuid,
		authorProfile: turn.authorProfile ?? null,
		startedAt: turn.startedAt,
		completedAt: turn.completedAt,
		durationMs: turn.durationMs,
		createdAt: turn.createdAt,
		updatedAt: turn.updatedAt,
		userPreview,
		assistantPreview: turn.assistantText
			? normalizeWhitespace(turn.assistantText)
			: null,
		provider: turn.provider,
		model: turn.model,
		finalUsage: turn.finalUsage,
		totalUsage: turn.totalUsage,
		errorMessage: turn.errorMessage,
	};
}

export type TurnNavPreviewSource = {
	intent?: SessionTurnIntent | null;
	userPreview?: string | null;
	userContent?: ContentBlock[] | null;
	userUuid?: string | null;
	authorProfile?: SessionTurnAuthorProfile | null;
};
