import { imageVariantUrl, mediaPreviewCandidates } from "@neta-art/cohub/media";
import DOMPurify from "isomorphic-dompurify";
import { marked, type Token, type Tokens } from "marked";
import remend from "remend";
import {
	createHighlighterCore,
	type HighlighterCore,
	type LanguageRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { RESOLVED_THEMES, THEME_REGISTRY } from "$lib/theme-registry";

const MARKDOWN_RENDER_CACHE_LIMIT = 256;
const STREAMING_MARKDOWN_TAIL_PLAIN_THRESHOLD = 1_800;
const SHIKI_THEME_MAP = Object.fromEntries(
	RESOLVED_THEMES.map((theme) => [theme, THEME_REGISTRY[theme].shikiTheme]),
);
const markdownRenderCache = new Map<string, Promise<string>>();

function cacheMarkdownRender(key: string, render: () => Promise<string>) {
	const cached = markdownRenderCache.get(key);
	if (cached) return cached;

	const promise = render().catch((error) => {
		markdownRenderCache.delete(key);
		throw error;
	});

	markdownRenderCache.set(key, promise);
	if (markdownRenderCache.size > MARKDOWN_RENDER_CACHE_LIMIT) {
		const firstKey = markdownRenderCache.keys().next().value;
		if (firstKey) markdownRenderCache.delete(firstKey);
	}

	return promise;
}

// Shiki highlighter — singleton, lazily initialized
let highlighterPromise: Promise<HighlighterCore> | null = null;
type ShikiLanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

const shikiLanguageLoaders = {
	bash: () => import("@shikijs/langs/bash"),
	c: () => import("@shikijs/langs/c"),
	cpp: () => import("@shikijs/langs/cpp"),
	css: () => import("@shikijs/langs/css"),
	diff: () => import("@shikijs/langs/diff"),
	dockerfile: () => import("@shikijs/langs/dockerfile"),
	go: () => import("@shikijs/langs/go"),
	graphql: () => import("@shikijs/langs/graphql"),
	html: () => import("@shikijs/langs/html"),
	ini: () => import("@shikijs/langs/ini"),
	java: () => import("@shikijs/langs/java"),
	javascript: () => import("@shikijs/langs/javascript"),
	json: () => import("@shikijs/langs/json"),
	jsx: () => import("@shikijs/langs/jsx"),
	markdown: () => import("@shikijs/langs/markdown"),
	mermaid: () => import("@shikijs/langs/mermaid"),
	protobuf: () => import("@shikijs/langs/protobuf"),
	python: () => import("@shikijs/langs/python"),
	rust: () => import("@shikijs/langs/rust"),
	shellscript: () => import("@shikijs/langs/shellscript"),
	sql: () => import("@shikijs/langs/sql"),
	toml: () => import("@shikijs/langs/toml"),
	tsx: () => import("@shikijs/langs/tsx"),
	typescript: () => import("@shikijs/langs/typescript"),
	xml: () => import("@shikijs/langs/xml"),
	yaml: () => import("@shikijs/langs/yaml"),
} satisfies Record<string, ShikiLanguageLoader>;

type SupportedShikiLanguage = keyof typeof shikiLanguageLoaders;

const shikiLanguageAliases = new Map<string, SupportedShikiLanguage>([
	["bash", "bash"],
	["c++", "cpp"],
	["cpp", "cpp"],
	["cxx", "cpp"],
	["c", "c"],
	["css", "css"],
	["diff", "diff"],
	["docker", "dockerfile"],
	["dockerfile", "dockerfile"],
	["go", "go"],
	["golang", "go"],
	["graphql", "graphql"],
	["gql", "graphql"],
	["html", "html"],
	["ini", "ini"],
	["java", "java"],
	["javascript", "javascript"],
	["js", "javascript"],
	["json", "json"],
	["jsx", "jsx"],
	["markdown", "markdown"],
	["md", "markdown"],
	["mdx", "markdown"],
	["mermaid", "mermaid"],
	["proto", "protobuf"],
	["protobuf", "protobuf"],
	["py", "python"],
	["python", "python"],
	["rs", "rust"],
	["rust", "rust"],
	["sh", "shellscript"],
	["shell", "shellscript"],
	["shellscript", "shellscript"],
	["sql", "sql"],
	["toml", "toml"],
	["tsx", "tsx"],
	["ts", "typescript"],
	["typescript", "typescript"],
	["xml", "xml"],
	["yaml", "yaml"],
	["yml", "yaml"],
]);

const loadedShikiLanguages = new Set<SupportedShikiLanguage>();

function normalizeShikiLanguage(rawLang: string) {
	return shikiLanguageAliases.get(rawLang.toLowerCase()) ?? null;
}

function collectCodeTokenLanguages(
	tokens: Token[],
	languages = new Set<SupportedShikiLanguage>(),
) {
	for (const token of tokens) {
		if (token.type === "code" && "lang" in token && token.lang) {
			const rawLang = token.lang.split(" ")[0];
			if (rawLang) {
				const lang = normalizeShikiLanguage(rawLang);
				if (lang) languages.add(lang);
			}
		}

		if ("tokens" in token && Array.isArray(token.tokens)) {
			collectCodeTokenLanguages(token.tokens, languages);
		}
	}

	return languages;
}

async function createMarkdownHighlighter() {
	return createHighlighterCore({
		engine: createJavaScriptRegexEngine(),
		themes: [
			import("@shikijs/themes/github-light"),
			import("@shikijs/themes/github-dark"),
			import("@shikijs/themes/solarized-light"),
			import("@shikijs/themes/solarized-dark"),
		],
		langs: [],
	});
}

function getHighlighter() {
	if (!highlighterPromise) {
		highlighterPromise = createMarkdownHighlighter();
	}
	return highlighterPromise;
}

async function loadShikiLanguages(
	highlighter: HighlighterCore,
	languages: Set<SupportedShikiLanguage>,
) {
	const pending = [...languages].filter(
		(lang) => !loadedShikiLanguages.has(lang),
	);
	if (pending.length === 0) return;

	const modules = await Promise.all(
		pending.map(async (lang) => ({
			lang,
			registration: (await shikiLanguageLoaders[lang]()).default,
		})),
	);

	await highlighter.loadLanguage(
		...modules.map(({ registration }) => registration),
	);
	for (const { lang } of modules) loadedShikiLanguages.add(lang);
}

/**
 * Walk tokens recursively and replace code tokens with html tokens
 * containing shiki-highlighted output.
 *
 * We use `html` tokens (not `code` tokens) because marked.parser
 * escapes code token content, which would break shiki's HTML output.
 */
async function highlightCodeTokens(tokens: Token[]) {
	const highlighter = await getHighlighter();
	await loadShikiLanguages(highlighter, collectCodeTokenLanguages(tokens));

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === "code" && "lang" in token && token.lang) {
			const rawLang = token.lang.split(" ")[0]; // handle e.g. "ts {1-3}"
			const lang = rawLang ? normalizeShikiLanguage(rawLang) : null;
			if (!lang || lang === "mermaid") continue;

			try {
				const highlighted = highlighter.codeToHtml(token.text, {
					lang,
					themes: SHIKI_THEME_MAP,
					defaultColor: false,
				});

				// Replace code token with html token so marked renders it unescaped
				const codeToken = token as Tokens.Code;
				tokens[i] = {
					type: "html",
					raw: codeToken.raw,
					text: highlighted,
					pre: true,
				} as Tokens.HTML;
			} catch {
				// Fallback: leave code as-is
			}
		}

		// Recurse into nested tokens (lists, blockquotes, etc.)
		if ("tokens" in token && Array.isArray(token.tokens)) {
			await highlightCodeTokens(token.tokens);
		}
	}
}

const AUDIO_EXTENSIONS = new Set([
	"aac",
	"flac",
	"m4a",
	"mp3",
	"oga",
	"ogg",
	"opus",
	"wav",
]);
const VIDEO_EXTENSIONS = new Set(["m4v", "mov", "mp4", "ogv", "webm"]);

type MarkdownMediaType = "audio" | "video";

function getMediaTypeFromHref(href: string): MarkdownMediaType | null {
	try {
		const url = new URL(
			href,
			typeof window === "undefined"
				? "https://cohub.local"
				: window.location.href,
		);
		const extension = url.pathname.split(".").pop()?.toLowerCase();
		if (!extension) return null;
		if (AUDIO_EXTENSIONS.has(extension)) return "audio";
		if (VIDEO_EXTENSIONS.has(extension)) return "video";
		return null;
	} catch {
		return null;
	}
}

/** Wider than any message column, so a variant renders at the original's size. */
const MARKDOWN_IMAGE_WIDTH = 1536;

function renderMediaPreviewHtml(input: {
	href: string;
	title?: string | null;
	label?: string;
	type: MarkdownMediaType;
}) {
	const src = escapeHtml(input.href);
	const title = input.title ? ` title="${escapeHtml(input.title)}"` : "";
	const label = input.label?.trim();
	const caption = label ? `<figcaption>${escapeHtml(label)}</figcaption>` : "";

	if (input.type === "audio") {
		// preload="none": the native element is only a no-JS / streaming
		// fallback — the enhanced player issues its own metadata request.
		return `<figure class="markdown-media markdown-audio"><audio controls preload="none" src="${src}"${title}></audio>${caption}</figure>`;
	}

	const ariaLabel = label ? escapeHtml(label) : "Video preview";
	// With a CDN still as the poster, nothing streams until the user plays.
	const [poster] = mediaPreviewCandidates(
		{ type: "video", url: input.href },
		{ size: MARKDOWN_IMAGE_WIDTH },
	);
	const frame = poster
		? `preload="none" poster="${escapeHtml(poster)}"`
		: `preload="metadata"`;
	return `<figure class="markdown-media markdown-video"><video controls playsinline ${frame} src="${src}" aria-label="${ariaLabel}"${title}></video>${caption}</figure>`;
}

// CDN images render as width-bounded WebP; the original stays reachable for
// the viewer and downloads through `data-original-src`.
marked.use({
	renderer: {
		image({ href, title, text }) {
			const variant = imageVariantUrl(href, MARKDOWN_IMAGE_WIDTH, "width");
			if (!variant) return false;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<img src="${escapeHtml(variant)}" alt="${escapeHtml(text)}"${titleAttr} data-original-src="${escapeHtml(href)}">`;
		},
	},
});

function getStandaloneMediaToken(token: Token) {
	if (token.type !== "paragraph" || !("tokens" in token)) return null;
	const inlineTokens = token.tokens;
	if (!Array.isArray(inlineTokens) || inlineTokens.length !== 1) return null;

	const inlineToken = inlineTokens[0];
	if (!inlineToken || !("href" in inlineToken)) return null;
	if (inlineToken.type !== "image" && inlineToken.type !== "link") return null;

	const href = String(inlineToken.href ?? "");
	const type = getMediaTypeFromHref(href);
	if (!type) return null;

	const label =
		"text" in inlineToken && typeof inlineToken.text === "string"
			? inlineToken.text
			: "";
	const title =
		"title" in inlineToken && typeof inlineToken.title === "string"
			? inlineToken.title
			: null;

	return { href, label, title, type };
}

function enhanceMediaPreviewTokens(tokens: Token[]) {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const media = getStandaloneMediaToken(token);
		if (media) {
			tokens[i] = {
				type: "html",
				raw: token.raw,
				text: renderMediaPreviewHtml(media),
				pre: false,
			} as Tokens.HTML;
			continue;
		}

		if ("tokens" in token && Array.isArray(token.tokens)) {
			enhanceMediaPreviewTokens(token.tokens);
		}
	}
}

function getCodeTokenLanguage(token: Token) {
	if (token.type !== "code" || !("lang" in token) || !token.lang) return null;
	return token.lang.split(" ")[0]?.toLowerCase() ?? null;
}

function isMermaidCodeToken(token: Token): token is Tokens.Code {
	return getCodeTokenLanguage(token) === "mermaid";
}

type CohubAskOption = {
	label: string;
	description: string;
	value?: string;
	preview?: string;
};

type CohubAskQuestion = {
	question: string;
	header: string;
	options: CohubAskOption[];
	multiSelect?: boolean;
};

type CohubAskBlock = {
	version?: 1;
	questions: CohubAskQuestion[];
	metadata?: Record<string, unknown>;
};

const COHUB_ASK_LANGUAGES = new Set(["cohub-ask", "ask-user-question"]);
const MAX_COHUB_ASK_SOURCE_LENGTH = 16_000;
const MAX_COHUB_ASK_INSERT_LENGTH = 2_000;

function isCohubAskCodeToken(token: Token): token is Tokens.Code {
	const lang = getCodeTokenLanguage(token);
	return Boolean(lang && COHUB_ASK_LANGUAGES.has(lang));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeCohubAskText(value: unknown, maxLength: number) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxLength) return null;
	return trimmed;
}

function parseCohubAskBlock(source: string): CohubAskBlock | null {
	if (source.length > MAX_COHUB_ASK_SOURCE_LENGTH) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch {
		return null;
	}

	if (!isPlainRecord(parsed)) return null;
	if (parsed.version !== undefined && parsed.version !== 1) return null;
	if (!Array.isArray(parsed.questions)) return null;
	if (parsed.questions.length < 1 || parsed.questions.length > 4) return null;

	const seenQuestions = new Set<string>();
	const questions: CohubAskQuestion[] = [];
	for (const rawQuestion of parsed.questions) {
		if (!isPlainRecord(rawQuestion)) return null;
		const question = sanitizeCohubAskText(rawQuestion.question, 600);
		const header = sanitizeCohubAskText(rawQuestion.header, 24);
		if (!question || !header || !Array.isArray(rawQuestion.options))
			return null;
		if (seenQuestions.has(question)) return null;
		seenQuestions.add(question);
		if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
			return null;
		}

		const seenLabels = new Set<string>();
		const options: CohubAskOption[] = [];
		for (const rawOption of rawQuestion.options) {
			if (!isPlainRecord(rawOption)) return null;
			const label = sanitizeCohubAskText(rawOption.label, 64);
			const description = sanitizeCohubAskText(rawOption.description, 320);
			if (!label || !description || seenLabels.has(label)) return null;
			seenLabels.add(label);
			const value = sanitizeCohubAskText(
				rawOption.value ?? rawOption.label,
				MAX_COHUB_ASK_INSERT_LENGTH,
			);
			if (!value) return null;
			const preview =
				sanitizeCohubAskText(rawOption.preview, 1_200) ?? undefined;
			options.push({ label, description, value, preview });
		}

		questions.push({
			question,
			header,
			options,
			multiSelect: rawQuestion.multiSelect === true,
		});
	}

	return { version: 1, questions };
}

function renderCohubAskPreviewHtml(source: string) {
	const block = parseCohubAskBlock(source);
	if (!block) return null;

	const questionsHtml = block.questions
		.map((question) => {
			const mode = question.multiSelect ? "Multi select" : "Choose one";
			const encodedQuestionKey = encodeURIComponent(question.question);
			const multiSelect = question.multiSelect ? "true" : "false";
			const optionsHtml = question.options
				.map((option) => {
					const encodedValue = encodeURIComponent(option.value ?? option.label);
					const previewHtml = option.preview
						? `<details class="markdown-cohub-ask-preview"><summary>Preview</summary><pre class="markdown-cohub-ask-preview-source">${escapeHtml(option.preview)}</pre></details>`
						: "";
					return `<li class="markdown-cohub-ask-option-item"><button type="button" class="markdown-cohub-ask-option" data-cohub-ask-option="true" data-cohub-ask-key="${encodedQuestionKey}" data-cohub-ask-multi="${multiSelect}" data-cohub-ask-value="${encodedValue}" aria-pressed="false" aria-label="Insert ${escapeHtml(option.label)}"><span class="markdown-cohub-ask-option-label">${escapeHtml(option.label)}</span><span class="markdown-cohub-ask-option-description">${escapeHtml(option.description)}</span></button>${previewHtml}</li>`;
				})
				.join("");
			return `<section class="markdown-cohub-ask-question" data-cohub-ask-question="true" data-cohub-ask-key="${encodedQuestionKey}"><div class="markdown-cohub-ask-question-meta"><span>${escapeHtml(question.header)}</span><span class="markdown-cohub-ask-question-mode">${mode}</span></div><div class="markdown-cohub-ask-question-title">${escapeHtml(question.question)}</div><ol class="markdown-cohub-ask-options">${optionsHtml}</ol></section>`;
		})
		.join("");

	return `<figure class="markdown-cohub-ask" data-cohub-ask-version="1">${questionsHtml}</figure>`;
}

function enhanceCohubAskTokens(tokens: Token[]) {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (isCohubAskCodeToken(token)) {
			const html = renderCohubAskPreviewHtml(token.text);
			if (html) {
				tokens[i] = {
					type: "html",
					raw: token.raw,
					text: html,
					pre: false,
				} as Tokens.HTML;
			}
			continue;
		}

		if ("tokens" in token && Array.isArray(token.tokens)) {
			enhanceCohubAskTokens(token.tokens);
		}
	}
}

const MAX_MERMAID_SOURCE_LENGTH = 12_000;
const MAX_MERMAID_SOURCE_LINES = 240;

function isMermaidSourceTooLarge(source: string) {
	return (
		source.length > MAX_MERMAID_SOURCE_LENGTH ||
		source.split(/\r?\n/).length > MAX_MERMAID_SOURCE_LINES
	);
}

function renderMermaidPreviewHtml(source: string) {
	const encodedSource = encodeURIComponent(source);
	const loadingText = isMermaidSourceTooLarge(source)
		? "Preview disabled"
		: "Rendering diagram…";
	return `<figure class="markdown-mermaid-figure"><div class="markdown-mermaid" data-mermaid-source="${encodedSource}" data-drawer-swipe-ignore role="img" aria-label="Mermaid diagram"><div class="markdown-mermaid-loading">${loadingText}</div></div><details class="markdown-mermaid-source"><summary>Source</summary><pre><code class="language-mermaid">${escapeHtml(source)}</code></pre></details></figure>`;
}

function enhanceMermaidTokens(tokens: Token[]) {
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (isMermaidCodeToken(token)) {
			tokens[i] = {
				type: "html",
				raw: token.raw,
				text: renderMermaidPreviewHtml(token.text),
				pre: false,
			} as Tokens.HTML;
			continue;
		}

		if ("tokens" in token && Array.isArray(token.tokens)) {
			enhanceMermaidTokens(token.tokens);
		}
	}
}

function normalizeNestedMarkdownCodeFences(source: string) {
	const lines = source.split(/(\r?\n)/);
	const output: string[] = [];
	let index = 0;

	while (index < lines.length) {
		const line = lines[index] ?? "";
		const lineBreak = lines[index + 1] ?? "";
		const opening = line.match(/^(\s*)([`~]{3,})([^`~]*)$/);
		const language = opening?.[3]?.trim().split(/\s+/)[0]?.toLowerCase();
		if (!opening || !["markdown", "md", "mdx"].includes(language ?? "")) {
			output.push(line, lineBreak);
			index += 2;
			continue;
		}

		const marker = opening[2][0];
		const fenceLength = opening[2].length;
		const fencePattern = new RegExp(`^(${marker}{${fenceLength},})(.*)$`);
		const contentStart = index + 2;
		let cursor = contentStart;
		let nestedFenceDepth = 0;
		let closingIndex = -1;
		let maxFenceLength = fenceLength;

		while (cursor < lines.length) {
			const currentLine = lines[cursor] ?? "";
			const currentFence = currentLine.trim().match(fencePattern);
			if (currentFence) {
				maxFenceLength = Math.max(maxFenceLength, currentFence[1].length);
				const info = currentFence[2].trim();
				if (nestedFenceDepth > 0) {
					if (info) nestedFenceDepth += 1;
					else nestedFenceDepth -= 1;
				} else if (info) {
					nestedFenceDepth = 1;
				} else {
					closingIndex = cursor;
					break;
				}
			}
			cursor += 2;
		}

		if (closingIndex === -1) {
			output.push(line, lineBreak);
			index += 2;
			continue;
		}

		const normalizedFence = marker.repeat(maxFenceLength + 1);
		output.push(
			`${opening[1]}${normalizedFence}${opening[3]}`,
			lineBreak,
			...lines.slice(contentStart, closingIndex),
			`${opening[1]}${normalizedFence}`,
			lines[closingIndex + 1] ?? "",
		);
		index = closingIndex + 2;
	}

	return output.join("");
}

const MARKDOWN_SOURCE_HTML_TAGS = [
	"a",
	"abbr",
	"b",
	"blockquote",
	"br",
	"caption",
	"code",
	"col",
	"colgroup",
	"dd",
	"del",
	"details",
	"div",
	"dl",
	"dt",
	"em",
	"figcaption",
	"figure",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"hr",
	"i",
	"img",
	"kbd",
	"li",
	"mark",
	"ol",
	"p",
	"picture",
	"pre",
	"q",
	"s",
	"samp",
	"small",
	"span",
	"strong",
	"sub",
	"summary",
	"sup",
	"table",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"tr",
	"ul",
	"var",
];

const MARKDOWN_SOURCE_HTML_ATTRIBUTES = [
	"align",
	"alt",
	"colspan",
	"height",
	"href",
	"open",
	"reversed",
	"rowspan",
	"src",
	"start",
	"title",
	"width",
];

const MARKDOWN_SOURCE_URL_PATTERN =
	/^(?:(?:https?:)?\/\/|\/|#|\?|\.{1,2}(?:\/|$)|[^:/?#]+(?:[/?#]|$))/i;

function sanitizeSourceHtml(html: string) {
	return DOMPurify.sanitize(html, {
		ALLOWED_ATTR: MARKDOWN_SOURCE_HTML_ATTRIBUTES,
		ALLOWED_TAGS: MARKDOWN_SOURCE_HTML_TAGS,
		ALLOWED_URI_REGEXP: MARKDOWN_SOURCE_URL_PATTERN,
		ALLOW_ARIA_ATTR: false,
		ALLOW_DATA_ATTR: false,
	});
}

function sanitizeInlineSourceHtml(html: string) {
	const tag = html.match(/^<(\/)?([a-z][a-z0-9-]*)(?:\s[^<>]*)?\s*\/?>$/i);
	if (!tag) return escapeHtml(html);

	const tagName = tag[2].toLowerCase();
	if (!MARKDOWN_SOURCE_HTML_TAGS.includes(tagName)) return escapeHtml(html);
	if (tag[1]) return `</${tagName}>`;

	const sanitized = sanitizeSourceHtml(`${html}</${tagName}>`);
	const openingTag = sanitized.match(/^<[^>]+>/)?.[0];
	return openingTag ?? "";
}

function prepareSourceHtmlTokens(tokens: Token[], allowHtml: boolean) {
	marked.walkTokens(tokens, (token) => {
		if (token.type !== "html") return;
		if (!allowHtml) {
			token.text = escapeHtml(token.text);
			return;
		}

		token.text = token.block
			? sanitizeSourceHtml(token.text)
			: sanitizeInlineSourceHtml(token.text);
	});
}

async function renderMarkdownHtml(
	source: string,
	options?: { highlight?: boolean; streamingSafe?: boolean },
) {
	const tokens = marked.lexer(normalizeNestedMarkdownCodeFences(source), {
		gfm: true,
	});
	// During streaming, incomplete source tags stay visible as text. Completed
	// renders accept a small document-oriented HTML subset before Cohub adds its
	// own generated HTML; the combined output is sanitized again below.
	prepareSourceHtmlTokens(tokens, !options?.streamingSafe);
	if (!options?.streamingSafe) {
		enhanceMediaPreviewTokens(tokens);
		enhanceCohubAskTokens(tokens);
		enhanceMermaidTokens(tokens);
	}
	if (options?.highlight !== false) await highlightCodeTokens(tokens);
	return marked.parser(tokens);
}

const EXTERNAL_LINK_PROTOCOLS = new Set(["http:", "https:"]);

function isExternalHttpLink(href: string) {
	try {
		const url = new URL(
			href,
			typeof window === "undefined"
				? "https://cohub.local"
				: window.location.href,
		);
		return (
			EXTERNAL_LINK_PROTOCOLS.has(url.protocol) && /^(https?:)?\/\//i.test(href)
		);
	} catch {
		return false;
	}
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
	if (node.nodeName !== "A") return;

	const element = node as Element;
	const href = element.getAttribute("href")?.trim();
	if (!href) return;
	if (!element.hasAttribute("title")) element.setAttribute("title", href);
	if (!isExternalHttpLink(href)) return;

	// Keep renderer-added new-tab behavior distinguishable from an author-supplied
	// target. Cohub App links can use the host workspace when no explicit target
	// was authored in the Markdown source.
	if (!element.hasAttribute("target")) {
		(element as HTMLElement).dataset.cohubAutoTarget = "blank";
		element.setAttribute("target", "_blank");
	}
	element.setAttribute("rel", "noopener noreferrer");
});

function sanitizeMarkdownHtml(html: string) {
	return DOMPurify.sanitize(html);
}

function isFencedCodeFenceLine(line: string) {
	const match = line.match(/^([`~]{3,})(.*)$/);
	if (!match) return null;
	return { fence: match[1], marker: match[1][0] };
}

type MarkdownBlock = {
	text: string;
	kind: "text" | "fence";
	closedFence: boolean;
};

function splitMarkdownBlocks(source: string): MarkdownBlock[] {
	if (!source) return [];

	const lines = source.split(/\r?\n/);
	const blocks: MarkdownBlock[] = [];
	let buffer: string[] = [];
	let fence: { fence: string; marker: string } | null = null;

	const commitBlock = (kind: "text" | "fence", closed: boolean) => {
		if (buffer.length === 0) return;
		blocks.push({
			text: buffer.join("\n"),
			kind,
			closedFence: closed,
		});
		buffer = [];
	};

	for (const line of lines) {
		const fenceState = fence ? isFencedCodeFenceLine(line.trim()) : null;

		if (fence) {
			buffer.push(line);
			if (
				fenceState &&
				fenceState.marker === fence.marker &&
				fenceState.fence.length >= fence.fence.length
			) {
				commitBlock("fence", true);
				fence = null;
			}
			continue;
		}

		const openingFence = isFencedCodeFenceLine(line.trim());
		if (openingFence) {
			commitBlock("text", true);
			buffer.push(line);
			fence = openingFence;
			continue;
		}

		buffer.push(line);
	}

	commitBlock(fence ? "fence" : "text", !fence);
	return blocks;
}

function renderPlainCodeBlock(source: string) {
	const lines = source.split(/\r?\n/);
	const openingFence = isFencedCodeFenceLine(lines[0]?.trim() ?? "");
	const language = openingFence
		? lines[0].trim().slice(openingFence.fence.length).trim().split(/\s+/)[0]
		: "";
	const code = openingFence ? lines.slice(1).join("\n") : source;
	const languageClass = language ? ` class="language-${language}"` : "";
	return sanitizeMarkdownHtml(
		`<pre data-streaming-code="true"><code${languageClass}>${escapeHtml(code)}</code></pre>`,
	);
}

function escapeHtml(source: string) {
	return source
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;");
}

async function renderMarkdownBlock(
	source: string,
	options?: { highlight?: boolean; streamingSafe?: boolean },
) {
	const html = await renderMarkdownHtml(source, options);
	return sanitizeMarkdownHtml(html);
}

export const renderMarkdown = async (source: string) => {
	const normalizedSource = source.trim();
	if (!normalizedSource) return "";

	return cacheMarkdownRender(`full:${normalizedSource}`, async () => {
		return renderMarkdownBlock(normalizedSource);
	});
};

function hasUnclosedInlineMarkdown(source: string) {
	const tail = source.slice(-320);
	const inlineCodeTicks = (tail.match(/(?<!`)`(?!`)/g) ?? []).length;
	if (inlineCodeTicks % 2 === 1) return true;

	const boldStars = (tail.match(/(?<!\*)\*\*(?!\*)/g) ?? []).length;
	const boldUnderscores = (tail.match(/(?<!_)__(?!_)/g) ?? []).length;
	if (boldStars % 2 === 1 || boldUnderscores % 2 === 1) return true;

	const linkOpen = tail.lastIndexOf("[");
	const linkClose = tail.lastIndexOf("]");
	const parenOpen = tail.lastIndexOf("](");
	const parenClose = tail.lastIndexOf(")");
	return linkOpen > linkClose || parenOpen > parenClose;
}

function findStreamingSafeIndex(source: string) {
	const length = source.length;
	if (length < 140) return 0;

	const minTail = source.endsWith("\n")
		? 56
		: Math.min(260, Math.max(84, Math.floor(length * 0.13)));
	const maxStableIndex = Math.max(0, length - minTail);
	const searchStart = Math.max(0, maxStableIndex - 1200);
	const window = source.slice(searchStart, maxStableIndex);
	const candidates: number[] = [];

	// With live Markdown repaired by remend, the current unfinished block can stay
	// in the live renderer. Promoting only at block boundaries avoids splitting a
	// single paragraph into stable/live <p> nodes, which otherwise causes already
	// streamed prose to rewrap and drift downward as the boundary moves.
	for (const match of window.matchAll(/\n\s*\n/g)) {
		candidates.push(searchStart + match.index + match[0].length);
	}

	candidates.sort((a, b) => b - a);
	for (const candidate of candidates) {
		const stable = source.slice(0, candidate);
		const tail = source.slice(candidate);
		if (!stable.trim()) continue;
		if (tail.length > 900) continue;
		if (hasUnclosedInlineMarkdown(stable.slice(-480))) continue;
		return candidate;
	}

	return 0;
}

export function splitStreamingStableMarkdown(source: string) {
	const safeIndex = findStreamingSafeIndex(source);
	return {
		stable: source.slice(0, safeIndex),
		tail: source.slice(safeIndex),
	};
}

function repairStreamingMarkdown(source: string) {
	return remend(source, {
		images: false,
		katex: false,
		inlineKatex: false,
	});
}

function renderStreamingPlainTail(source: string) {
	if (!source) return "";
	return sanitizeMarkdownHtml(
		`<span class="markdown-streaming-tail">${escapeHtml(source)}</span>`,
	);
}

export const renderStreamingMarkdownSplit = async (
	source: string,
): Promise<{ stableHtml: string; tailHtml: string }> => {
	const streamingSource = source.trimStart();
	if (!streamingSource.trim()) return { stableHtml: "", tailHtml: "" };

	const blocks = splitMarkdownBlocks(streamingSource);
	if (blocks.length === 0) return { stableHtml: "", tailHtml: "" };

	const stableSources: string[] = [];
	let tailSource = "";
	let tailIsFence = false;

	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		const isLast = index === blocks.length - 1;

		if (block.kind === "fence") {
			if (block.closedFence || !isLast) {
				stableSources.push(block.text);
			} else {
				tailSource = block.text;
				tailIsFence = true;
			}
			continue;
		}

		if (!isLast) {
			stableSources.push(block.text);
			continue;
		}

		// Last text block: split at the most recent paragraph boundary so
		// only the growing tail is re-rendered each commit.
		const { stable, tail } = splitStreamingStableMarkdown(block.text);
		if (stable.trim()) stableSources.push(stable);
		tailSource = tail;
		tailIsFence = false;
	}

	const hasTail = tailSource.trim().length > 0;
	// Render each stable block independently. Stable blocks never change once
	// promoted, so per-block caching means a new paragraph only costs one lexer +
	// DOMPurify pass for itself. Keying the cache on the concatenated stable
	// source instead would re-sanitize the entire message every time the
	// stable/tail boundary moves, which grows linearly with answer length.
	const stableHtml = (
		await Promise.all(
			stableSources.map((blockSource) =>
				blockSource.trim()
					? cacheMarkdownRender(`stream-stable-v3:${blockSource}`, () =>
							renderMarkdownBlock(blockSource, {
								highlight: false,
								streamingSafe: true,
							}),
						)
					: Promise.resolve(""),
			),
		)
	).join("");

	const tailHtml = !hasTail
		? ""
		: tailIsFence
			? renderPlainCodeBlock(tailSource)
			: tailSource.length > STREAMING_MARKDOWN_TAIL_PLAIN_THRESHOLD
				? renderStreamingPlainTail(tailSource)
				: await renderMarkdownBlock(repairStreamingMarkdown(tailSource), {
						highlight: false,
						streamingSafe: true,
					});

	return { stableHtml, tailHtml };
};
