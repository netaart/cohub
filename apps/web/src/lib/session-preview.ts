import type { SessionRecord } from "@neta-art/cohub";

const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
const LINE_MARKER_RE = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm;
const LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g;
// Paired emphasis only, so `snake_case`, `~/path` and `2 * 3` survive.
const EMPHASIS_RE = /(\*\*|__|~~|\*)(?=\S)([\s\S]*?\S)\1/g;

function stripPreviewMarkdown(value: string) {
	return value
		.replace(FENCED_CODE_RE, " ")
		.replace(LINE_MARKER_RE, "")
		.replace(LINK_RE, "$1")
		.replace(EMPHASIS_RE, "$2")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function normalize(value: string) {
	return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function getSessionPreview(
	session: SessionRecord,
	limit = 96,
): string | null {
	const title = session.title?.trim();
	const raw = session.latestMessageText;
	if (!title || !raw) return null;
	const text = stripPreviewMarkdown(raw.slice(0, limit * 4));
	if (!text || normalize(text).startsWith(normalize(title))) return null;
	if (text.length <= limit) return text;
	const head = text
		.slice(0, Math.max(0, limit - 1))
		.replace(/[\uD800-\uDBFF]$/, "");
	return `${head.trimEnd()}…`;
}
