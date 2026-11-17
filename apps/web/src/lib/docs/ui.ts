import type { DocsLocale } from "./types.ts";

export type DocsUiCopy = {
	docsLabel: string;
	docsTagline: string;
	menu: string;
	closeMenu: string;
	searchButton: string;
	searchPlaceholder: string;
	searchEmpty: string;
	searchNoResults: (query: string) => string;
	searchPopular: string;
	searchAria: string;
	closeSearch: string;
	onThisPage: string;
	previous: string;
	next: string;
	pager: string;
	language: string;
	english: string;
	chinese: string;
	pageOutline: string;
	copyMarkdown: string;
	copied: string;
};

const UI: Record<DocsLocale, DocsUiCopy> = {
	en: {
		docsLabel: "Docs",
		docsTagline: "How to use Cohub.",
		menu: "Menu",
		closeMenu: "Close menu",
		searchButton: "Search docs",
		searchPlaceholder: "Search documentation",
		searchEmpty: "Search by concept, page title, or product term.",
		searchNoResults: (query) => `No matches for “${query}”.`,
		searchPopular: "Popular",
		searchAria: "Search documentation",
		closeSearch: "Close search",
		onThisPage: "On this page",
		previous: "Previous",
		next: "Next",
		pager: "Pager",
		language: "Language",
		english: "EN",
		chinese: "中文",
		pageOutline: "Page outline",
		copyMarkdown: "Copy markdown",
		copied: "Copied",
	},
	zh: {
		docsLabel: "文档",
		docsTagline: "了解如何使用 Cohub。",
		menu: "目录",
		closeMenu: "关闭目录",
		searchButton: "搜索文档",
		searchPlaceholder: "搜索文档",
		searchEmpty: "可按概念、页面标题或产品术语搜索。",
		searchNoResults: (query) => `没有找到与「${query}」相关的内容。`,
		searchPopular: "热门页面",
		searchAria: "搜索文档",
		closeSearch: "关闭搜索",
		onThisPage: "本页目录",
		previous: "上一页",
		next: "下一页",
		pager: "翻页",
		language: "语言",
		english: "EN",
		chinese: "中文",
		pageOutline: "页面大纲",
		copyMarkdown: "复制 Markdown",
		copied: "已复制",
	},
};

export function getDocsUi(locale: DocsLocale): DocsUiCopy {
	return UI[locale];
}
