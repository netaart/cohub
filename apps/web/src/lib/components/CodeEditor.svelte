<script lang="ts">
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
} from "@codemirror/commands";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
	Annotation,
	Compartment,
	EditorState,
	type Extension,
	Transaction,
} from "@codemirror/state";
import {
	crosshairCursor,
	drawSelection,
	dropCursor,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import { onDestroy, onMount } from "svelte";
import {
	getCodeEditorTheme,
	withLanguageHighlights,
} from "#lib/code-editor-highlight.ts";
import {
	isDarkTheme,
	isResolvedTheme,
	type ResolvedTheme,
} from "#lib/theme-registry.ts";
import type { WorkspaceFilePosition } from "#lib/workspace-file-links.ts";

const {
	value = "",
	language = "plaintext",
	readonly = false,
	allowDrawerSwipe = false,
	initialPosition = null,
	onInput,
	onVisibleLinesChange,
}: {
	value: string;
	language?: string;
	readonly?: boolean;
	/** Allow the mobile workspace drawer gesture to start from this editor. */
	allowDrawerSwipe?: boolean;
	initialPosition?: WorkspaceFilePosition | null;
	onInput?: (v: string) => void;
	onVisibleLinesChange?: (range: { start: number; end: number } | null) => void;
} = $props();

let container: HTMLDivElement | undefined = $state();
let view: EditorView | undefined = $state();
let lastVisibleLinesKey = "";

function reportVisibleLines(nextView = view) {
	if (!nextView) {
		if (lastVisibleLinesKey !== "") {
			lastVisibleLinesKey = "";
			onVisibleLinesChange?.(null);
		}
		return;
	}
	const { from, to } = nextView.viewport;
	if (nextView.state.doc.length === 0) {
		const key = "1:1";
		if (key === lastVisibleLinesKey) return;
		lastVisibleLinesKey = key;
		onVisibleLinesChange?.({ start: 1, end: 1 });
		return;
	}
	const start = nextView.state.doc.lineAt(from).number;
	const end = nextView.state.doc.lineAt(Math.max(from, to - 1)).number;
	const key = `${start}:${end}`;
	if (key === lastVisibleLinesKey) return;
	lastVisibleLinesKey = key;
	onVisibleLinesChange?.({ start, end });
}

// Compartments for dynamic reconfiguration
const langConf = new Compartment();
const themeConf = new Compartment();
const readOnlyConf = new Compartment();
let languageLoadId = 0;
let appliedInitialPositionKey = "";

async function getLanguageExtension(lang: string): Promise<Extension> {
	const l = lang.toLowerCase();
	const map: Record<string, () => Promise<Extension>> = {
		js: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: false,
				jsx: false,
			}),
		javascript: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: false,
				jsx: false,
			}),
		ts: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: true,
				jsx: false,
			}),
		typescript: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: true,
				jsx: false,
			}),
		jsx: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: false,
				jsx: true,
			}),
		tsx: async () =>
			(await import("@codemirror/lang-javascript")).javascript({
				typescript: true,
				jsx: true,
			}),
		py: async () => (await import("@codemirror/lang-python")).python(),
		python: async () => (await import("@codemirror/lang-python")).python(),
		json: async () => (await import("@codemirror/lang-json")).json(),
		jsonc: async () => (await import("@codemirror/lang-json")).json(),
		html: async () => (await import("@codemirror/lang-html")).html(),
		htm: async () => (await import("@codemirror/lang-html")).html(),
		svelte: async () => (await import("@codemirror/lang-html")).html(),
		css: async () => (await import("@codemirror/lang-css")).css(),
		scss: async () => (await import("@codemirror/lang-css")).css(),
		md: async () => (await import("@codemirror/lang-markdown")).markdown(),
		markdown: async () =>
			(await import("@codemirror/lang-markdown")).markdown(),
		yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
		yml: async () => (await import("@codemirror/lang-yaml")).yaml(),
		xml: async () => (await import("@codemirror/lang-xml")).xml(),
		svg: async () => (await import("@codemirror/lang-xml")).xml(),
	};
	return (await map[l]?.()) ?? [];
}

async function reconfigureLanguage(lang: string) {
	if (!view) return;
	const loadId = ++languageLoadId;
	const extension = await getLanguageExtension(lang);
	if (!view || loadId !== languageLoadId) return;
	view.dispatch({
		effects: langConf.reconfigure(withLanguageHighlights(lang, extension)),
	});
}

function isMobile(): boolean {
	if (typeof window === "undefined") return false;
	return window.innerWidth < 640;
}

function getEditorFont(): string {
	return isMobile() ? "15px" : "13px";
}

function resolveTheme(): ResolvedTheme {
	if (typeof document === "undefined") return "dark";
	const attr = document.documentElement.getAttribute("data-theme");
	return isResolvedTheme(attr) ? attr : "dark";
}

// Only the light/dark flag lives in JS now; colors are CSS variables, so a
// theme switch needs no palette rebuild unless the light/dark mode flips.
function syncEditorTheme() {
	if (!view) return;
	const dark = isDarkTheme(resolveTheme());
	if (dark === currentDark) return;
	currentDark = dark;
	view.dispatch({
		effects: themeConf.reconfigure(
			getCodeEditorTheme({ dark, fontSize: getEditorFont() }),
		),
	});
}

let currentLanguage = $derived(language);
let currentDark = $state(isDarkTheme(resolveTheme()));

$effect(() => {
	if (!view) return;
	void reconfigureLanguage(currentLanguage);
});

$effect(() => {
	if (!view) return;
	syncEditorTheme();
});

$effect(() => {
	if (!view) return;
	view.dispatch({
		effects: readOnlyConf.reconfigure([
			EditorView.editable.of(!readonly),
			EditorState.readOnly.of(readonly),
		]),
	});
});

function focusPosition(position: WorkspaceFilePosition | null | undefined) {
	if (!view || !position) return;
	const lineNumber = Math.max(1, Math.floor(position.line));
	const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines));
	const column = position.column ? Math.max(1, Math.floor(position.column)) : 1;
	const offset = Math.min(line.to, line.from + column - 1);
	view.dispatch({
		selection: { anchor: offset },
		effects: EditorView.scrollIntoView(offset, { y: "center" }),
	});
}

$effect(() => {
	const position = initialPosition;
	if (!view || !position) return;
	const key = `${position.line}:${position.column ?? 1}:${value.length}`;
	if (key === appliedInitialPositionKey) return;
	appliedInitialPositionKey = key;
	queueMicrotask(() => focusPosition(position));
});

// Sync external value changes into the editor (but not while typing)
let syncing = $state(false);
let lastExternal = $state("");
const externalSync = Annotation.define<boolean>();

$effect(() => {
	const v = value;
	if (syncing || !view || v === lastExternal) return;
	lastExternal = v;
	const current = view.state.doc.toString();
	if (v !== current) {
		const anchor = Math.min(view.state.selection.main.anchor, v.length);
		const head = Math.min(view.state.selection.main.head, v.length);
		const scrollTop = view.scrollDOM.scrollTop;
		const scrollLeft = view.scrollDOM.scrollLeft;
		view.dispatch({
			changes: { from: 0, to: current.length, insert: v },
			selection: { anchor, head },
			annotations: [externalSync.of(true), Transaction.addToHistory.of(false)],
		});
		requestAnimationFrame(() => {
			if (!view) return;
			view.scrollDOM.scrollTop = scrollTop;
			view.scrollDOM.scrollLeft = scrollLeft;
		});
	}
});

onMount(() => {
	if (!container) return;

	currentDark = isDarkTheme(resolveTheme());
	lastExternal = value;
	syncing = true;

	view = new EditorView({
		state: EditorState.create({
			doc: value,
			extensions: [
				lineNumbers(),
				highlightActiveLineGutter(),
				highlightSpecialChars(),
				history(),
				foldGutter(),
				drawSelection(),
				dropCursor(),
				EditorState.allowMultipleSelections.of(true),
				indentOnInput(),
				bracketMatching(),
				closeBrackets(),
				rectangularSelection(),
				crosshairCursor(),
				highlightActiveLine(),
				highlightSelectionMatches(),
				keymap.of([
					...closeBracketsKeymap,
					...defaultKeymap,
					...searchKeymap,
					...historyKeymap,
					...foldKeymap,
					indentWithTab,
				]),
				langConf.of([]),
				themeConf.of(
					getCodeEditorTheme({ dark: currentDark, fontSize: getEditorFont() }),
				),
				readOnlyConf.of([
					EditorView.editable.of(!readonly),
					EditorState.readOnly.of(readonly),
				]),
				EditorView.lineWrapping,
				EditorView.updateListener.of((update) => {
					const programmatic = update.transactions.some((transaction) =>
						transaction.annotation(externalSync),
					);
					if (update.docChanged && !programmatic) {
						syncing = false;
						lastExternal = update.state.doc.toString();
						onInput?.(lastExternal);
					}
					if (
						update.docChanged ||
						update.geometryChanged ||
						update.viewportChanged
					) {
						reportVisibleLines(update.view);
					}
				}),
			],
		}),
		parent: container,
	});
	queueMicrotask(() => reportVisibleLines(view));
	void reconfigureLanguage(language);

	const themeObserver = new MutationObserver(() => syncEditorTheme());
	themeObserver.observe(document.documentElement, {
		attributeFilter: ["data-theme"],
	});

	syncing = false;

	return () => {
		themeObserver.disconnect();
	};
});

onDestroy(() => {
	view?.destroy();
	view = undefined;
	if (lastVisibleLinesKey !== "") {
		lastVisibleLinesKey = "";
		onVisibleLinesChange?.(null);
	}
});
</script>

<!--
  Interactive embeds keep native horizontal touch handling. Workspace file
  editing opts into drawer swipes; wrapped lines keep vertical scrolling as
  the editor's primary touch action in that mode.
-->
<div
  bind:this={container}
  class="cm-wrapper"
  class:cm-wrapper--drawer-swipe={allowDrawerSwipe}
  data-drawer-swipe-ignore={allowDrawerSwipe ? undefined : ""}
></div>

<style>
  .cm-wrapper {
    height: 100%;
    min-height: 0;
    overflow: hidden;
    touch-action: pan-x pan-y;
  }
  .cm-wrapper--drawer-swipe {
    touch-action: pan-y;
  }
  .cm-wrapper :global(.cm-editor) {
    height: 100%;
  }
  .cm-wrapper :global(.cm-scroller) {
    font-family: var(--font-mono, monospace);
  }
</style>
