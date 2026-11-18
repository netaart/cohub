import { isSeoWorkerPath } from "#lib/seo-pages.ts";
import type { DocsFrontmatter, DocsTocItem } from "./types.ts";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function parseDocsFrontmatter(source: string): {
	frontmatter: DocsFrontmatter;
	body: string;
} {
	const match = source.match(FRONTMATTER_RE);
	if (!match) {
		return {
			frontmatter: { title: "Untitled", description: "" },
			body: source.trim(),
		};
	}

	const raw = match[1] ?? "";
	const fields = new Map<string, string>();
	for (const line of raw.split(/\r?\n/)) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		const value = unquote(line.slice(idx + 1));
		if (key) fields.set(key, value);
	}

	return {
		frontmatter: {
			title: fields.get("title")?.trim() || "Untitled",
			description: fields.get("description")?.trim() || "",
		},
		body: source.slice(match[0].length).trim(),
	};
}

/** Keep letters (incl. CJK), numbers, and spaces so Chinese headings stay usable as anchors. */
export function slugifyHeading(text: string): string {
	const slug = text
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}\s-]/gu, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 80);
	return slug;
}

function stripTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Add stable ids to h2/h3 and collect a table of contents. */
export function injectHeadingAnchors(html: string): {
	html: string;
	toc: DocsTocItem[];
} {
	const toc: DocsTocItem[] = [];
	const used = new Map<string, number>();

	const nextHtml = html.replace(
		/<h([23])(\s[^>]*)?>([\s\S]*?)<\/h\1>/gi,
		(_full, levelRaw: string, attrs = "", inner: string) => {
			const level = Number(levelRaw) as 2 | 3;
			const text = stripTags(inner);
			if (!text) return `<h${level}${attrs}>${inner}</h${level}>`;

			const existingId = attrs.match(/\sid="([^"]+)"/i)?.[1];
			let id =
				existingId || slugifyHeading(text) || `section-${toc.length + 1}`;
			const count = used.get(id) ?? 0;
			used.set(id, count + 1);
			if (count > 0) id = `${id}-${count + 1}`;

			toc.push({ id, text, level });

			const withoutId = attrs.replace(/\s+id="[^"]*"/i, "");
			return `<h${level}${withoutId} id="${id}">${inner}</h${level}>`;
		},
	);

	return { html: nextHtml, toc };
}

/** Force a full page load for links to pages served by the SEO Worker. */
export function markSeoWorkerLinks(html: string): string {
	return html.replace(
		/<a(\s[^>]*?)?\shref="([^"]+)"([^>]*)>/gi,
		(full, before = "", href: string, after: string) => {
			if (!isSeoWorkerPath(href) || /\srel=/i.test(full)) return full;
			return `<a${before} href="${href}" rel="external"${after}>`;
		},
	);
}

export function htmlToPlainText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}
