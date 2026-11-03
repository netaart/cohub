<script lang="ts" module>
export const DISPLAY_KEY_BAR_HEIGHT = 44;
</script>

<script lang="ts">
import {
	DISPLAY_MODIFIER_KEYS,
	type DisplayInputEvent,
	type DisplayModifierKey,
	type DisplayPlatform,
} from "@cohub/protocol/display";
import { ChevronDown, ClipboardPaste } from "lucide-svelte";
import { onDestroy } from "svelte";
import { portal } from "$lib/actions/portal";
import { holdHostKeys } from "$lib/host-tabs";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { m } from "$lib/paraglide/messages.js";
import { eventModifiers, isNamedKey, keyboardInput, textBatches } from "./display-input";
import { diffText } from "./display-text";

type Props = {
	desktop: boolean;
	platform: DisplayPlatform | undefined;
	meta: DisplayModifierKey;
	password: boolean;
	send: (events: DisplayInputEvent[], held?: readonly DisplayModifierKey[]) => void;
	onKeyUp: (event: KeyboardEvent) => void;
	onOpenChange: (open: boolean) => void;
};

const { desktop, platform, meta, password, send, onKeyUp, onOpenChange }: Props = $props();

const SENTINEL = " ";
const MAX_BUFFER = 256;
const KEYBOARD_MIN = 120;
const VERIFY_MS = 600;

type Latch = "once" | "locked";

const MODIFIER_LABELS: Record<"macos" | "windows" | "other", Record<DisplayModifierKey, string>> = {
	macos: { Meta: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" },
	windows: { Control: "Ctrl", Alt: "Alt", Meta: "Win", Shift: "Shift" },
	other: { Control: "Ctrl", Alt: "Alt", Meta: "Super", Shift: "Shift" },
};

const locale = $derived(getLocale());
const modifierLabels = $derived(
	MODIFIER_LABELS[platform === "macos" || platform === "windows" ? platform : "other"],
);
const keys = $derived<Array<{ key: string; label: string; title?: string }>>([
	{ key: "Escape", label: "Esc" },
	{ key: "Tab", label: "Tab" },
	{ key: "ArrowLeft", label: "←", title: m.display_key_left({}, { locale }) },
	{ key: "ArrowUp", label: "↑", title: m.display_key_up({}, { locale }) },
	{ key: "ArrowDown", label: "↓", title: m.display_key_down({}, { locale }) },
	{ key: "ArrowRight", label: "→", title: m.display_key_right({}, { locale }) },
	{ key: "Home", label: "Home" },
	{ key: "End", label: "End" },
	{ key: "PageUp", label: "PgUp" },
	{ key: "PageDown", label: "PgDn" },
	{ key: "Delete", label: "Del" },
	...Array.from({ length: 12 }, (_, index) => ({ key: `F${index + 1}`, label: `F${index + 1}` })),
]);

let field = $state<HTMLInputElement | null>(null);
let open = $state(false);
let composing = $state(false);
let preview = $state("");
let latches = $state<Partial<Record<DisplayModifierKey, Latch>>>({});
let viewport = $state({ left: 0, top: 0, width: 0, height: 0 });
let typed = SENTINEL;
let verifyTimer: ReturnType<typeof setTimeout> | null = null;

const modifierOrder = $derived<DisplayModifierKey[]>(
	platform === "macos" ? ["Meta", "Control", "Alt", "Shift"] : ["Control", "Alt", "Meta", "Shift"],
);

$effect(() => {
	if (!open) return;
	const visual = window.visualViewport;
	const update = () => {
		viewport = visual
			? { left: visual.offsetLeft, top: visual.offsetTop, width: visual.width, height: visual.height }
			: { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
	};
	const keepCaret = () => {
		if (!composing && document.activeElement === field) caretToEnd();
	};
	update();
	visual?.addEventListener("resize", update);
	visual?.addEventListener("scroll", update);
	window.addEventListener("resize", update);
	document.addEventListener("selectionchange", keepCaret);
	return () => {
		visual?.removeEventListener("resize", update);
		visual?.removeEventListener("scroll", update);
		window.removeEventListener("resize", update);
		document.removeEventListener("selectionchange", keepCaret);
	};
});

let releaseKeys: (() => void) | null = null;

onDestroy(() => {
	if (verifyTimer) clearTimeout(verifyTimer);
	releaseKeys?.();
});

export function show(verify = false) {
	if (!field) return;
	const before = window.visualViewport?.height ?? window.innerHeight;
	resetBuffer();
	field.focus({ preventScroll: true });
	if (verifyTimer) clearTimeout(verifyTimer);
	verifyTimer = null;
	if (!verify) return;
	verifyTimer = setTimeout(() => {
		verifyTimer = null;
		const after = window.visualViewport?.height ?? window.innerHeight;
		const virtual = (navigator as Navigator & { virtualKeyboard?: { boundingRect: DOMRect } }).virtualKeyboard;
		if (before - after < KEYBOARD_MIN && !virtual?.boundingRect.height) hide();
	}, VERIFY_MS);
}

export function hide() {
	field?.blur();
}

export function modifiers(): DisplayModifierKey[] {
	return held();
}

export function consume() {
	const kept = Object.entries(latches).filter(([, latch]) => latch === "locked");
	if (kept.length !== Object.keys(latches).length) latches = Object.fromEntries(kept);
}

export function reset() {
	if (!composing) resetBuffer();
}

function caretToEnd() {
	if (!field) return;
	const end = field.value.length;
	if (field.selectionStart !== end || field.selectionEnd !== end) field.setSelectionRange(end, end);
}

function resetBuffer() {
	typed = SENTINEL;
	if (!field) return;
	field.value = SENTINEL;
	caretToEnd();
}

function held(extra: readonly DisplayModifierKey[] = []): DisplayModifierKey[] {
	return DISPLAY_MODIFIER_KEYS.filter((key) => latches[key] || extra.includes(key));
}

function toggle(key: DisplayModifierKey) {
	const next: Latch | undefined = latches[key] === undefined ? "once" : latches[key] === "once" ? "locked" : undefined;
	const { [key]: _, ...rest } = latches;
	latches = next ? { ...rest, [key]: next } : rest;
}

function press(key: string, own: readonly DisplayModifierKey[] = []) {
	const printable = [...key].length === 1;
	send([{ type: "key", action: "press", key: desktop && printable ? key.toLowerCase() : key }], held(own));
	send([], []);
	consume();
	reset();
}

function onKeyDown(event: KeyboardEvent) {
	if (isComposingKeyboardEvent(event)) return;
	const printable = [...event.key].length === 1;
	if (desktop && held().length && (printable || isNamedKey(event.key))) {
		event.preventDefault();
		press(event.key, eventModifiers(event, meta));
		return;
	}
	const input = keyboardInput(event, desktop, meta);
	if (!input || input.events.some((item) => item.type === "text")) return;
	event.preventDefault();
	send(input.events, input.held);
	reset();
}

function onBeforeInput(event: InputEvent) {
	if (event.inputType !== "insertLineBreak" && event.inputType !== "insertParagraph") return;
	event.preventDefault();
	press("Enter");
}

function sync() {
	if (!field) return;
	const value = field.value;
	const { erase, text } = diffText(typed, value);
	typed = value;
	if (desktop && held().length && (erase === 1 ? !text : !erase && [...text].length === 1)) {
		press(text || "Backspace");
	} else if (erase || text) {
		const backspaces = Array.from({ length: erase }, (): DisplayInputEvent => ({ type: "key", action: "press", key: "Backspace" }));
		const [first = [], ...rest] = textBatches(text);
		send([...backspaces, ...first], []);
		for (const batch of rest) send(batch, []);
	}
	if (!value.startsWith(SENTINEL) || value.length > MAX_BUFFER) resetBuffer();
	else caretToEnd();
}

function onFocus() {
	releaseKeys ??= holdHostKeys();
	open = true;
	onOpenChange(true);
}

function onBlur() {
	releaseKeys?.();
	releaseKeys = null;
	if (verifyTimer) clearTimeout(verifyTimer);
	verifyTimer = null;
	open = false;
	composing = false;
	preview = "";
	latches = {};
	resetBuffer();
	onOpenChange(false);
}

async function pasteClipboard() {
	const text = await navigator.clipboard?.readText().catch(() => "");
	if (!text) return;
	for (const batch of textBatches(text)) send(batch, []);
	reset();
}

function keepFocus(event: PointerEvent) {
	event.preventDefault();
}
</script>

<input
	bind:this={field}
	class="display-keyboard-field"
	type={password ? "password" : "text"}
	value={SENTINEL}
	tabindex="-1"
	autocomplete="off"
	autocapitalize="off"
	autocorrect="off"
	spellcheck="false"
	enterkeyhint="enter"
	aria-label={m.display_keyboard_field({}, { locale })}
	onfocus={onFocus}
	onblur={onBlur}
	onkeydown={onKeyDown}
	onkeyup={onKeyUp}
	onbeforeinput={onBeforeInput}
	oninput={() => {
		if (!composing) sync();
	}}
	oncompositionstart={() => {
		composing = true;
	}}
	oncompositionupdate={(event) => {
		preview = password ? "" : event.data;
	}}
	oncompositionend={() => {
		composing = false;
		preview = "";
		sync();
	}}
/>

{#if open}
	<div
		use:portal
		class="display-keybar"
		role="toolbar"
		tabindex="-1"
		aria-label={m.display_keys({}, { locale })}
		style:left="{viewport.left}px"
		style:top="{viewport.top + viewport.height - DISPLAY_KEY_BAR_HEIGHT}px"
		style:width="{viewport.width}px"
		style:height="{DISPLAY_KEY_BAR_HEIGHT}px"
		onpointerdown={keepFocus}
	>
		<div class="display-keybar-keys">
			{#if preview}<span class="display-keybar-preview">{preview}</span>{/if}
			{#if desktop}
				{#each modifierOrder as key (key)}
					<button
						type="button"
						class="display-key"
						class:is-once={latches[key] === "once"}
						class:is-locked={latches[key] === "locked"}
						aria-pressed={latches[key] !== undefined}
						title={key}
						onclick={() => toggle(key)}
					>{modifierLabels[key]}</button>
				{/each}
				{#each keys as { key, label, title } (key)}
					<button type="button" class="display-key" title={title ?? key} aria-label={title} onclick={() => press(key)}>{label}</button>
				{/each}
			{/if}
			<button
				type="button"
				class="display-key"
				title={m.display_paste({}, { locale })}
				aria-label={m.display_paste({}, { locale })}
				onclick={pasteClipboard}
			><ClipboardPaste class="h-4 w-4" /></button>
		</div>
		<button
			type="button"
			class="display-key display-keybar-hide"
			title={m.display_keyboard_hide({}, { locale })}
			aria-label={m.display_keyboard_hide({}, { locale })}
			onclick={hide}
		><ChevronDown class="h-4 w-4" /></button>
	</div>
{/if}

<style>
	.display-keyboard-field {
		position: absolute;
		top: 0;
		left: 0;
		width: 1px;
		height: 1px;
		padding: 0;
		border: 0;
		opacity: 0;
		/* Below 16px, iOS zooms the page to the field. */
		font-size: 16px;
		caret-color: transparent;
		pointer-events: none;
	}
	.display-keybar {
		position: fixed;
		z-index: 120;
		display: flex;
		align-items: stretch;
		border-top: 1px solid var(--border-subtle);
		background: var(--bg-elevated);
		user-select: none;
		-webkit-user-select: none;
		touch-action: pan-x;
	}
	.display-keybar-keys {
		display: flex;
		flex: 1 1 auto;
		align-items: center;
		gap: 4px;
		min-width: 0;
		padding: 0 6px;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
	}
	.display-keybar-keys::-webkit-scrollbar {
		display: none;
	}
	.display-keybar-preview {
		flex: 0 0 auto;
		max-width: 40vw;
		overflow: hidden;
		padding: 0 6px;
		color: var(--text-primary);
		font-size: 14px;
		text-decoration: underline;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.display-key {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		min-width: 40px;
		height: 32px;
		padding: 0 8px;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-surface);
		color: var(--text-secondary);
		font: inherit;
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}
	.display-key:active {
		background: var(--bg-hover);
	}
	.display-key.is-once {
		border-color: var(--brand-border);
		background: var(--brand-muted);
		color: var(--brand);
	}
	.display-key.is-locked {
		border-color: var(--brand);
		background: var(--brand);
		color: var(--brand-contrast-fg);
	}
	.display-keybar-hide {
		align-self: center;
		margin: 0 6px;
	}
</style>
