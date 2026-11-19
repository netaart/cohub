import {
	createHighlighterCore,
	type HighlighterCore,
	type LanguageRegistration,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { RESOLVED_THEMES, THEME_REGISTRY } from "#lib/theme-registry.ts";

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

type ShikiLanguage = keyof typeof shikiLanguageLoaders;

const shikiLanguageAliases = new Map<string, ShikiLanguage>([
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

const SHIKI_THEMES = {
	light: "github-light",
	dark: "github-dark",
	"solarized-light": "solarized-light",
	"solarized-dark": "solarized-dark",
} as const;

type CodeTheme = keyof typeof SHIKI_THEMES;

const CODE_THEME_BY_SHIKI = Object.fromEntries(
	Object.entries(SHIKI_THEMES).map(([key, theme]) => [theme, key]),
) as Record<(typeof SHIKI_THEMES)[CodeTheme], CodeTheme>;

function activeCodeTheme(): CodeTheme {
	const theme = document.documentElement.getAttribute("data-theme");
	const resolved = RESOLVED_THEMES.find((name) => name === theme) ?? "light";
	return CODE_THEME_BY_SHIKI[THEME_REGISTRY[resolved].shikiTheme];
}

const HIGHLIGHT_CACHE_LIMIT = 256;
const HIGHLIGHT_SLICE_MS = 8;

let highlighterPromise: Promise<HighlighterCore> | null = null;
let highlighter: HighlighterCore | null = null;
const loadedLanguages = new Set<ShikiLanguage>();
const languageLoads = new Map<ShikiLanguage, Promise<void>>();
const highlightCache = new Map<string, string>();

function getHighlighter() {
	highlighterPromise ??= createHighlighterCore({
		engine: createJavaScriptRegexEngine(),
		themes: [
			import("@shikijs/themes/github-light"),
			import("@shikijs/themes/github-dark"),
			import("@shikijs/themes/solarized-light"),
			import("@shikijs/themes/solarized-dark"),
		],
		langs: [],
	}).then(
		(instance) => (highlighter = instance),
		(error) => {
			highlighterPromise = null;
			throw error;
		},
	);
	return highlighterPromise;
}

function loadLanguage(lang: ShikiLanguage) {
	let load = languageLoads.get(lang);
	if (!load) {
		load = Promise.all([getHighlighter(), shikiLanguageLoaders[lang]()]).then(
			async ([instance, module]) => {
				await instance.loadLanguage(...module.default);
				loadedLanguages.add(lang);
			},
			(error) => {
				languageLoads.delete(lang);
				throw error;
			},
		);
		languageLoads.set(lang, load);
	}
	return load;
}

function resolveLanguage(info: string | null | undefined) {
	const raw = info?.split(/\s/)[0]?.toLowerCase();
	return raw ? (shikiLanguageAliases.get(raw) ?? null) : null;
}

type HighlightThemes = CodeTheme | "all";

const cacheKey = (code: string, lang: ShikiLanguage, themes: HighlightThemes) =>
	`${themes}\0${lang}\0${code}`;

function highlightSync(
	code: string,
	lang: ShikiLanguage,
	themes: HighlightThemes,
) {
	const key = cacheKey(code, lang, themes);
	const cached = highlightCache.get(key);
	if (cached !== undefined) return cached;
	if (!highlighter || !loadedLanguages.has(lang)) return null;

	const html = highlighter.codeToHtml(code, {
		lang,
		themes:
			themes === "all" ? SHIKI_THEMES : { [themes]: SHIKI_THEMES[themes] },
		defaultColor: false,
	});
	highlightCache.set(key, html);
	if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
		const oldest = highlightCache.keys().next().value;
		if (oldest !== undefined) highlightCache.delete(oldest);
	}
	return html;
}

const CODE_BLOCK_PATTERN =
	/<pre><code class="language-([^"\s]+)">([\s\S]*?)<\/code><\/pre>/g;

function decodeHtml(source: string) {
	return source
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&#039;", "'")
		.replaceAll("&amp;", "&");
}

function stripFinalNewline(code: string) {
	return code.endsWith("\n") ? code.slice(0, -1) : code;
}

export async function highlightCodeHtml(html: string) {
	const languages = new Set<ShikiLanguage>();
	for (const match of html.matchAll(CODE_BLOCK_PATTERN)) {
		const lang = resolveLanguage(match[1]);
		if (lang) languages.add(lang);
	}
	if (languages.size === 0) return html;
	await Promise.all([...languages].map(loadLanguage));

	return html.replace(CODE_BLOCK_PATTERN, (block, info: string, body) => {
		const lang = resolveLanguage(info);
		if (!lang) return block;
		try {
			return (
				highlightSync(stripFinalNewline(decodeHtml(body)), lang, "all") ?? block
			);
		} catch {
			return block;
		}
	});
}

type CodeBlock = {
	code: string;
	lang: ShikiLanguage;
	theme: CodeTheme | null;
	visible: boolean;
};

const VISIBILITY_MARGIN = "1200px 0px";

const blocks = new Map<HTMLPreElement, CodeBlock>();
let codeTheme: CodeTheme = "light";
let visibility: IntersectionObserver | null = null;
let themeObserver: MutationObserver | null = null;
let queued: HTMLPreElement[] = [];
let draining = false;

const template =
	typeof document === "undefined" ? null : document.createElement("template");

function apply(pre: HTMLPreElement, block: CodeBlock, html: string) {
	if (!template) return;
	template.innerHTML = html;
	const next = template.content.firstElementChild;
	if (!(next instanceof HTMLPreElement)) return;
	for (const { name, value } of next.attributes) pre.setAttribute(name, value);
	pre.replaceChildren(...next.childNodes);
	block.theme = codeTheme;
}

function refresh(pre: HTMLPreElement, block: CodeBlock, compute: boolean) {
	const html = compute
		? highlightSync(block.code, block.lang, codeTheme)
		: (highlightCache.get(cacheKey(block.code, block.lang, codeTheme)) ?? null);
	if (html !== null) apply(pre, block, html);
	return html !== null;
}

function forget(pre: HTMLPreElement) {
	blocks.delete(pre);
	visibility?.unobserve(pre);
}

const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));

async function drain() {
	if (draining) return;
	draining = true;
	try {
		let sliceStart = performance.now();
		while (queued.length > 0) {
			const batch = queued;
			queued = [];
			const languages = new Set<ShikiLanguage>();
			for (const pre of batch) {
				const block = blocks.get(pre);
				if (block) languages.add(block.lang);
			}
			try {
				await Promise.all([...languages].map(loadLanguage));
			} catch {
				for (const pre of batch) forget(pre);
				continue;
			}
			for (const pre of batch) {
				if (performance.now() - sliceStart > HIGHLIGHT_SLICE_MS) {
					await yieldToMain();
					sliceStart = performance.now();
				}
				const block = blocks.get(pre);
				if (!block || !pre.isConnected || block.theme === codeTheme) continue;
				try {
					refresh(pre, block, true);
				} catch {
					forget(pre);
				}
			}
		}
	} finally {
		draining = false;
	}
}

function onVisibilityChange(entries: IntersectionObserverEntry[]) {
	for (const { target, isIntersecting } of entries) {
		const pre = target as HTMLPreElement;
		const block = blocks.get(pre);
		if (!block) continue;
		if (!pre.isConnected) {
			forget(pre);
			continue;
		}
		block.visible = isIntersecting;
		if (isIntersecting && block.theme !== codeTheme) queued.push(pre);
	}
	if (queued.length > 0) void drain();
}

function onThemeChange() {
	const next = activeCodeTheme();
	if (next === codeTheme) return;
	codeTheme = next;
	for (const [pre, block] of blocks) {
		if (!pre.isConnected) forget(pre);
		else if (block.visible && block.theme !== null) {
			try {
				refresh(pre, block, true);
			} catch {
				forget(pre);
			}
		}
	}
}

function observe(pre: HTMLPreElement, block: CodeBlock) {
	if (!themeObserver) {
		codeTheme = activeCodeTheme();
		themeObserver = new MutationObserver(onThemeChange);
		themeObserver.observe(document.documentElement, {
			attributeFilter: ["data-theme"],
		});
	}
	blocks.set(pre, block);
	if (typeof IntersectionObserver === "undefined") {
		queued.push(pre);
		void drain();
		return;
	}
	visibility ??= new IntersectionObserver(onVisibilityChange, {
		rootMargin: VISIBILITY_MARGIN,
		scrollMargin: VISIBILITY_MARGIN,
	} as IntersectionObserverInit);
	visibility.observe(pre);
}

export function highlightCodeBlocks(
	root: ParentNode,
	include: (pre: HTMLPreElement) => boolean = () => true,
) {
	for (const [pre] of blocks) if (!pre.isConnected) forget(pre);
	for (const code of root.querySelectorAll<HTMLElement>(
		'pre:not([data-highlight]) > code[class^="language-"]',
	)) {
		const pre = code.parentElement as HTMLPreElement;
		if (!include(pre)) continue;
		const lang = resolveLanguage(code.className.slice("language-".length));
		pre.dataset.highlight = lang ? "on" : "none";
		if (!lang) continue;

		const block: CodeBlock = {
			code: stripFinalNewline(code.textContent ?? ""),
			lang,
			theme: null,
			visible: false,
		};
		observe(pre, block);
		refresh(pre, block, false);
	}
}
