<script lang="ts">
import type { ViewportContext } from "@cohub/protocol";
import type {
	PromptTemplateCatalogEntry,
	SkillCatalogEntry,
	VoiceInputClient,
} from "@neta-art/cohub";
import {
	Check,
	ChevronDown,
	Maximize2,
	Mic,
	Minimize2,
	Plus,
	X,
} from "lucide-svelte";
import { onMount } from "svelte";
import { getCacheUserKey } from "$lib/cache/keys";
import ComposerModelTrigger from "$lib/components/composer/ComposerModelTrigger.svelte";
import ComposerSubmitButton from "$lib/components/composer/ComposerSubmitButton.svelte";
import ComposerSurface from "$lib/components/composer/ComposerSurface.svelte";
import { mediaLightbox } from "$lib/components/media-lightbox.svelte";
import SessionChatQuickActions from "$lib/components/SessionChatQuickActions.svelte";
import SlashCommandMenu, {
	type SlashCommandMenuItem,
} from "$lib/components/SlashCommandMenu.svelte";
import SpaceMentionMenu from "$lib/components/SpaceMentionMenu.svelte";
import UploadProgress from "$lib/components/UploadProgress.svelte";
import ViewportContextBlocks from "$lib/components/ViewportContextBlocks.svelte";
import {
	COMPOSER_ATTACHMENT_ACCEPT,
	type ComposerAttachment,
	type ComposerImageAttachment,
} from "$lib/composer-attachments";
import {
	getComposerKeyAction,
	isMobileComposerInput,
} from "$lib/composer-keyboard";
import { isCreateModeCommand } from "$lib/composer-mode-command";
import type { PromptQuickAction } from "$lib/features/space/modules/prompt-template-controller.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { getCohubAppLinkKey, parseCohubAppUrls } from "$lib/mentions/app";
import { resolveCohubAppLinkMentionLabels } from "$lib/mentions/app-link-resolve";
import {
	type ResourceMentionTextToken,
	replaceCohubResourceUrls,
	tokenizeResourceMentionText,
} from "$lib/mentions/resource";
import type { SpaceMentionSuggestion } from "$lib/mentions/space";
import {
	buildSpaceMentionMarkdown,
	parseCohubSpaceUrls,
} from "$lib/mentions/space";
import {
	getCohubLinkMentionKey,
	resolveCohubLinkMentionLabels,
} from "$lib/mentions/space-link-resolve";
import {
	mergeSpaceMentionSuggestions,
	searchLocalSpaceMentions,
	searchRemoteSpaceMentions,
} from "$lib/mentions/space-search";
import {
	detectSpaceMentionTriggerFromText,
	SPACE_MENTION_TRIGGER_SCAN_LIMIT,
	type SpaceMentionTrigger,
	spaceMentionTriggerKey,
	type TextCaret,
} from "$lib/mentions/space-trigger";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";
import { entriesFromFiles, type LocalUploadEntry } from "$lib/upload-entries";

type SelectedModel = {
	provider: string;
	id: string;
	name?: string;
};

type Props = {
	value: string;
	mode?: "agent" | "create";
	onmodechange?: (mode: "agent" | "create") => void;
	disabled?: boolean;
	sending?: boolean;
	isRunning?: boolean;
	aborting?: boolean;
	streamError?: string;
	showBillingAction?: boolean;
	placeholder?: string;
	attachments?: ComposerAttachment[];
	viewportContexts?: ViewportContext[];
	currentModel?: SelectedModel | null;
	/** Compact thinking level suffix; null/empty hides. */
	thinkingLevelLabel?: string | null;
	/** Compact generation-policy suffix; null/empty hides (Auto). */
	generationPolicyLabel?: string | null;
	/** Quick prompt action chips rendered above the composer surface. */
	quickActions?: PromptQuickAction[];
	onquickaction?: (action: PromptQuickAction) => void;
	promptTemplates?: PromptTemplateCatalogEntry[];
	promptTemplatesLoaded?: boolean;
	skills?: SkillCatalogEntry[];
	skillsLoaded?: boolean;
	currentSpaceId?: string | null;
	mobileAutoFocusOnMount?: boolean;
	onsubmit: () => void;
	onabort?: () => void;
	onpickattachment?: (
		files: FileList | File[] | LocalUploadEntry[] | null,
	) => void;
	onremoveattachment?: (id: string) => void;
	onremoveviewport?: (id: string) => void;
	onModelSelect?: () => void;
};

let {
	value = $bindable(""),
	mode = "agent",
	onmodechange,
	disabled = false,
	sending = false,
	isRunning = false,
	aborting = false,
	streamError = "",
	showBillingAction = false,
	placeholder = "",
	attachments = [],
	viewportContexts = [],
	currentModel = null,
	thinkingLevelLabel = null,
	generationPolicyLabel = null,
	quickActions = [],
	onquickaction,
	promptTemplates = [],
	promptTemplatesLoaded = true,
	skills = [],
	skillsLoaded = true,
	currentSpaceId = null,
	mobileAutoFocusOnMount = false,
	onsubmit,
	onabort,
	onpickattachment,
	onremoveattachment,
	onremoveviewport,
	onModelSelect,
}: Props = $props();

const locale = $derived(getLocale());
const composerPlaceholder = $derived(
	placeholder || m.composer_placeholder({}, { locale }),
);

let textareaEl = $state<HTMLTextAreaElement | null>(null);
let mentionMirrorEl = $state<HTMLDivElement | null>(null);
let fileInputEl = $state<HTMLInputElement | null>(null);
let showPromptSuggestions = $state(false);
let selectedPromptIndex = $state(0);
let showSpaceMentions = $state(false);
let selectedSpaceMentionIndex = $state(0);
let selectedSpaceMentionId = $state<string | null>(null);
let localSpaceMentionItems = $state<SpaceMentionSuggestion[]>([]);
let remoteSpaceMentionItems = $state<SpaceMentionSuggestion[]>([]);
let spaceMentionLocalDone = $state(true);
let spaceMentionRemoteDone = $state(true);
let spaceMentionRemoteError = $state<string | null>(null);
let spaceMentionSearchToken = 0;
let activeSpaceMentionSearchKey: string | null = null;
let spaceMentionLocalController: AbortController | null = null;
let spaceMentionRemoteController: AbortController | null = null;
let spaceMentionDebounceTimer: number | null = null;
let pastedSpaceResolveController: AbortController | null = null;
let pastedAppResolveController: AbortController | null = null;
let spaceMentionTrigger = $state<SpaceMentionTrigger | null>(null);
/** Dismissed trigger key; stays closed until the active @token changes. */
let dismissedSpaceMentionKey: string | null = null;
/** Reactive caret — never read DOM selection inside effects. */
let caret = $state<TextCaret>({ start: 0, end: 0 });
let caretSyncFrame: number | null = null;
let blurCloseTimer: number | null = null;
let selectionChangeBound = false;
let isComposerExpanded = $state(false);
let hasTextareaOverflow = $state(false);
let showModeMenu = $state(false);
let voiceClient: VoiceInputClient | null = null;
let voicePrefix = "";
let voiceSuffix = "";
let voiceCommittedText = "";
let voicePartialText = $state("");
let isVoiceRecording = $state(false);
let isVoiceStarting = $state(false);
let voiceError = $state<string | null>(null);
const composerInsertRanges = new Map<
	string,
	{ start: number; end: number; text: string }
>();
const SLASH_COMMAND_SCAN_LIMIT = 160;
const SLASH_COMMAND_QUERY_LIMIT = 80;
const COMPOSER_MENTION_MIRROR_TEXT_LIMIT = 50_000;
const BLUR_MENU_CLOSE_MS = 120;
const LOCAL_MENTION_SEARCH_RETRY_MS = 80;

let isTextareaFocused = $state(false);
let resizeFrame: number | null = null;

const hasDraft = $derived(hasVisibleDraftText(value) || attachments.length > 0);
const showAbort = $derived(Boolean(isRunning && !hasDraft));
const submitDisabled = $derived(
	disabled || sending || (!hasDraft && !showAbort),
);
const modelControlLabel = $derived(
	currentModel?.name ?? currentModel?.id ?? m.composer_model({}, { locale }),
);
const modelControlAriaLabel = $derived(
	[
		m.composer_model_label({ model: modelControlLabel }, { locale }),
		thinkingLevelLabel
			? m.composer_thinking_label({ level: thinkingLevelLabel }, { locale })
			: null,
		generationPolicyLabel
			? m.composer_generation_label(
					{ policy: generationPolicyLabel },
					{ locale },
				)
			: null,
	]
		.filter(Boolean)
		.join(", "),
);

function isComposerImageAttachment(
	attachment: ComposerAttachment,
): attachment is ComposerImageAttachment {
	return attachment.kind === "image";
}

function openComposerImagePreview(attachment: ComposerImageAttachment) {
	const imageAttachments = attachments.filter(isComposerImageAttachment);
	const index = Math.max(0, imageAttachments.indexOf(attachment));
	mediaLightbox.show(
		imageAttachments.map((item) => ({
			src: item.previewUrl,
			type: "image" as const,
			alt: item.name,
		})),
		index,
	);
}

function hasVisibleDraftText(text: string) {
	return /\S/.test(text);
}

function getSlashCommandToken(text: string): { query: string } | null {
	const scanned = text.slice(0, SLASH_COMMAND_SCAN_LIMIT + 1);
	const firstNonWhitespace = scanned.search(/\S/);
	if (firstNonWhitespace === -1 || scanned[firstNonWhitespace] !== "/") {
		return null;
	}

	const afterSlash = scanned.slice(firstNonWhitespace + 1);
	const terminatorIndex = afterSlash.search(/\s/);
	if (terminatorIndex !== -1) return null;
	const query = afterSlash;

	if (query.length > SLASH_COMMAND_QUERY_LIMIT) return null;
	if (text.length > scanned.length) return null;
	return { query };
}

const slashCommandToken = $derived.by(() => getSlashCommandToken(value));

const filteredPromptTemplates = $derived.by<SlashCommandMenuItem[]>(() => {
	const query = slashCommandToken?.query.toLowerCase();
	if (query === undefined) return [];
	const scored: SlashCommandMenuItem[] = [];

	for (const item of promptTemplates) {
		const name = item.name.toLowerCase();
		const description = item.description.toLowerCase();
		const category = item.category?.toLowerCase() ?? "";
		let matchScore = 0;
		if (!query) matchScore = 10;
		else if (name.startsWith(query)) matchScore = 100;
		else if (name.includes(query)) matchScore = 80;
		else if (category.includes(query)) matchScore = 64;
		else if (description.includes(query)) matchScore = 48;
		else continue;
		scored.push({
			kind: "prompt",
			name: item.name,
			description: item.description,
			scope: item.scope,
			argumentHint: item.argumentHint,
			category: item.category,
			matchScore,
		});
	}

	for (const item of skills) {
		const label = `skill:${item.name}`;
		const name = item.name.toLowerCase();
		const labelLower = label.toLowerCase();
		const description = item.description.toLowerCase();
		const mountSlug = item.source?.mountSlug.toLowerCase() ?? "";
		let matchScore = 0;
		if (!query) matchScore = 9;
		else if (labelLower.startsWith(query) || name.startsWith(query))
			matchScore = 100;
		else if (labelLower.includes(query) || name.includes(query))
			matchScore = 80;
		else if (mountSlug.includes(query)) matchScore = 64;
		else if (description.includes(query)) matchScore = 48;
		else continue;
		scored.push({
			kind: "skill",
			name: item.name,
			description: item.description,
			scope: item.scope,
			source: item.source,
			matchScore,
		});
	}

	return scored.sort((a, b) => {
		const scoreDelta = (b.matchScore ?? 0) - (a.matchScore ?? 0);
		if (scoreDelta !== 0) return scoreDelta;
		const kindDelta = a.kind.localeCompare(b.kind);
		if (kindDelta !== 0) return kindDelta;
		const categoryDelta = (a.category ?? a.scope).localeCompare(
			b.category ?? b.scope,
		);
		if (categoryDelta !== 0) return categoryDelta;
		return a.name.localeCompare(b.name);
	});
});

const slashCommandQuery = $derived(slashCommandToken?.query ?? "");
const slashCommandActive = $derived(slashCommandToken !== null);
const slashCommandLoading = $derived(
	slashCommandActive && (!promptTemplatesLoaded || !skillsLoaded),
);

const spaceMentionItems = $derived(
	mergeSpaceMentionSuggestions({
		local: localSpaceMentionItems,
		remote: remoteSpaceMentionItems,
		query: spaceMentionTrigger?.query ?? "",
		currentSpaceId,
		viewerUserUuid: getCacheUserKey(),
		limit: 30,
	}),
);
const spaceMentionLoading = $derived(
	!spaceMentionLocalDone || !spaceMentionRemoteDone,
);
const spaceMentionStatus = $derived.by(() => {
	const query = spaceMentionTrigger?.query.trim() ?? "";
	if (!query) return "Mention another space";
	if (spaceMentionRemoteError)
		return `Local results only · ${spaceMentionRemoteError}`;
	if (!spaceMentionRemoteDone)
		return `Local ${localSpaceMentionItems.length} · syncing server…`;
	return `${spaceMentionItems.length} space${spaceMentionItems.length === 1 ? "" : "s"}`;
});
const shouldPrepareComposerMentionMirror = $derived(
	!isTextareaFocused &&
		value.length <= COMPOSER_MENTION_MIRROR_TEXT_LIMIT &&
		value.includes("@[") &&
		(value.includes("](cohub://spaces/") || value.includes("](cohub://apps/")),
);
const composerMentionTokens = $derived.by<ResourceMentionTextToken[]>(() =>
	shouldPrepareComposerMentionMirror ? tokenizeResourceMentionText(value) : [],
);
const composerHasRenderableMentions = $derived(
	composerMentionTokens.some((token) => token.type !== "text"),
);
const shouldRenderComposerMentionMirror = $derived(
	composerHasRenderableMentions,
);

function getViewportHeight(): number {
	if (typeof window === "undefined") return 800;
	return window.visualViewport?.height ?? window.innerHeight;
}

function getTextareaLimits(expanded = isComposerExpanded) {
	const mobile = isMobileComposerInput();
	const viewportHeight = getViewportHeight();
	const min = expanded ? (mobile ? 144 : 168) : 44;
	const max = expanded
		? Math.min(viewportHeight * (mobile ? 0.46 : 0.52), mobile ? 420 : 560)
		: Math.min(viewportHeight * (mobile ? 0.34 : 0.38), mobile ? 220 : 220);

	return {
		min,
		max: Math.max(min, max),
	};
}

function readTextareaCaret(): TextCaret | null {
	if (!textareaEl) return null;
	return {
		start: textareaEl.selectionStart ?? 0,
		end: textareaEl.selectionEnd ?? 0,
	};
}

function setCaretState(next: TextCaret) {
	if (caret.start === next.start && caret.end === next.end) return;
	caret = next;
}

/** Sync reactive caret from the DOM. Safe to call often. */
function syncCaretFromDom() {
	const next = readTextareaCaret();
	if (!next) return;
	setCaretState(next);
}

function setTextareaSelection(start: number, end = start) {
	if (!textareaEl) return;
	textareaEl.setSelectionRange(start, end);
	setCaretState({ start, end });
}

function cancelScheduledCaretSync() {
	if (caretSyncFrame === null || typeof window === "undefined") return;
	window.cancelAnimationFrame(caretSyncFrame);
	caretSyncFrame = null;
}

/**
 * Safari often updates selectionStart one frame after input/value bind.
 * Coalesce to rAF so detection always sees the settled caret.
 */
function scheduleCaretSyncAndRefresh(options?: { forceOpen?: boolean }) {
	if (typeof window === "undefined") {
		syncCaretFromDom();
		refreshMentionState(options);
		return;
	}
	if (caretSyncFrame !== null) return;
	caretSyncFrame = window.requestAnimationFrame(() => {
		caretSyncFrame = null;
		syncCaretFromDom();
		refreshMentionState(options);
	});
}

function resizeTextarea() {
	resizeFrame = null;
	if (!textareaEl) return;
	if (!hasVisibleDraftText(value) && isComposerExpanded) {
		isComposerExpanded = false;
	}
	const selection = readTextareaCaret();
	const scrollTop = textareaEl.scrollTop;
	// 1px (not 0): still allows shrink measurement, less likely to clobber Safari selection.
	textareaEl.style.height = "1px";
	const scrollHeight = textareaEl.scrollHeight;
	const { min, max } = getTextareaLimits();
	const nextHeight = Math.min(scrollHeight, max);
	textareaEl.style.height = `${Math.max(nextHeight, min)}px`;
	hasTextareaOverflow = scrollHeight > textareaEl.clientHeight + 1;
	if (selection) {
		const maxPos = textareaEl.value.length;
		const start = Math.min(selection.start, maxPos);
		const end = Math.min(selection.end, maxPos);
		if (
			textareaEl.selectionStart !== start ||
			textareaEl.selectionEnd !== end
		) {
			textareaEl.setSelectionRange(start, end);
		}
		setCaretState({ start, end });
	}
	textareaEl.scrollTop = Math.min(
		scrollTop,
		Math.max(0, textareaEl.scrollHeight - textareaEl.clientHeight),
	);
	syncMentionMirrorScroll();
}

function scheduleResizeTextarea() {
	if (typeof window === "undefined") {
		resizeTextarea();
		return;
	}
	if (resizeFrame !== null) return;
	resizeFrame = window.requestAnimationFrame(resizeTextarea);
}

function cancelScheduledResize() {
	if (resizeFrame === null || typeof window === "undefined") return;
	window.cancelAnimationFrame(resizeFrame);
	resizeFrame = null;
}

function syncMentionMirrorScroll() {
	if (!textareaEl || !mentionMirrorEl) return;
	mentionMirrorEl.scrollTop = textareaEl.scrollTop;
	mentionMirrorEl.scrollLeft = textareaEl.scrollLeft;
}

function setComposerExpanded(expanded: boolean) {
	if (expanded === isComposerExpanded || !textareaEl) return;
	const selection = readTextareaCaret() ?? caret;
	const scrollTop = textareaEl.scrollTop;
	const shouldRestoreFocus = document.activeElement === textareaEl;
	isComposerExpanded = expanded;
	scheduleResizeTextarea();
	requestAnimationFrame(() => {
		if (!textareaEl) return;
		setTextareaSelection(selection.start, selection.end);
		textareaEl.scrollTop = Math.min(
			scrollTop,
			Math.max(0, textareaEl.scrollHeight - textareaEl.clientHeight),
		);
		if (shouldRestoreFocus) textareaEl.focus({ preventScroll: true });
		syncMentionMirrorScroll();
		refreshMentionState();
	});
}

function collapseComposer() {
	setComposerExpanded(false);
}

function toggleComposerExpansion() {
	setComposerExpanded(!isComposerExpanded);
}

function submitDraft() {
	if (submitDisabled || !hasDraft) return;
	closeVoiceInput();
	if (mode !== "create" && onmodechange && isCreateModeCommand(value)) {
		value = "";
		showModeMenu = false;
		onmodechange("create");
		requestAnimationFrame(() => {
			textareaEl?.focus();
			setTextareaSelection(0);
			resizeTextarea();
			refreshMentionState();
		});
		return;
	}
	onsubmit();
	textareaEl?.blur();
	collapseComposer();
}

function applyVoiceText(partialText = "") {
	value = voicePrefix + voiceCommittedText + partialText + voiceSuffix;
	requestAnimationFrame(() => {
		const cursor =
			voicePrefix.length + voiceCommittedText.length + partialText.length;
		setTextareaSelection(cursor);
		resizeTextarea();
		refreshMentionState();
	});
}

async function startVoiceInput() {
	if (disabled || sending || isVoiceRecording || isVoiceStarting) return;
	voiceError = null;
	isVoiceStarting = true;
	syncCaretFromDom();
	const start = caret.start;
	const end = caret.end;
	voicePrefix = value.slice(0, start);
	voiceSuffix = value.slice(end);
	voiceCommittedText = "";
	voicePartialText = "";
	const client = sdk.voice.createInputClient({
		onPartial: (text) => {
			if (voiceClient !== client) return;
			voicePartialText = text;
			applyVoiceText(text);
		},
		onFinal: (text) => {
			if (voiceClient !== client) return;
			voiceCommittedText += text;
			voicePartialText = "";
			applyVoiceText();
		},
		onError: (message) => {
			if (voiceClient !== client) return;
			voiceError = message;
		},
		onDone: () => {
			if (voiceClient !== client) return;
			isVoiceRecording = false;
			isVoiceStarting = false;
			voiceClient = null;
			client.close();
		},
	});
	voiceClient = client;
	try {
		await client.start();
		if (voiceClient !== client) return;
		isVoiceRecording = true;
	} catch (error) {
		if (voiceClient !== client) return;
		voiceError = error instanceof Error ? error.message : "Voice input failed";
		isVoiceStarting = false;
		isVoiceRecording = false;
		voiceClient = null;
		client.close();
	} finally {
		if (voiceClient === client) isVoiceStarting = false;
	}
}

function toggleVoiceInput() {
	if (isVoiceRecording) {
		stopVoiceInput();
		return;
	}
	void startVoiceInput();
}

function stopVoiceInput() {
	if (!isVoiceRecording) return;
	isVoiceRecording = false;
	voiceClient?.stop();
}

function closeVoiceInput() {
	const client = voiceClient;
	voiceClient = null;
	isVoiceRecording = false;
	isVoiceStarting = false;
	client?.close();
}

function applyPromptTemplate(item: SlashCommandMenuItem) {
	const trimmedStart = value.trimStart();
	const leadingWhitespace = value.slice(0, value.length - trimmedStart.length);
	const firstSpace = trimmedStart.indexOf(" ");
	const suffix = firstSpace === -1 ? "" : trimmedStart.slice(firstSpace);
	const command =
		item.kind === "skill" ? `/skill:${item.name}` : `/${item.name}`;
	value = `${leadingWhitespace}${command}${suffix || " "}`;
	showPromptSuggestions = false;
	selectedPromptIndex = 0;
	dismissedSpaceMentionKey = null;
	requestAnimationFrame(() => {
		textareaEl?.focus();
		setTextareaSelection(value.length);
		resizeTextarea();
		refreshMentionState();
	});
}

function detectSpaceMentionTrigger() {
	return detectSpaceMentionTriggerFromText(value, caret, {
		scanLimit: SPACE_MENTION_TRIGGER_SCAN_LIMIT,
	});
}

/**
 * Single entry for mention open/search state.
 * - `trigger` is derived from reactive caret + value
 * - `open` can be dismissed without losing trigger identity
 * - never force-open a dismissed key until the @token changes
 */
function sameSpaceMentionTrigger(
	a: SpaceMentionTrigger | null,
	b: SpaceMentionTrigger | null,
) {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.start === b.start && a.end === b.end && a.query === b.query;
}

function refreshMentionState(options?: { forceOpen?: boolean }) {
	const trigger = detectSpaceMentionTrigger();
	if (!sameSpaceMentionTrigger(spaceMentionTrigger, trigger)) {
		spaceMentionTrigger = trigger;
	}
	const activeTrigger = trigger && !slashCommandActive ? trigger : null;

	if (!activeTrigger) {
		dismissedSpaceMentionKey = null;
		if (showSpaceMentions) showSpaceMentions = false;
		scheduleSpaceMentionSearch(null);
		return;
	}

	const key = spaceMentionTriggerKey(activeTrigger);
	if (options?.forceOpen) dismissedSpaceMentionKey = null;

	const shouldOpen = isTextareaFocused && dismissedSpaceMentionKey !== key;
	if (showSpaceMentions !== shouldOpen) showSpaceMentions = shouldOpen;
	scheduleSpaceMentionSearch(activeTrigger);
}

function dismissSpaceMentions() {
	if (spaceMentionTrigger) {
		dismissedSpaceMentionKey = spaceMentionTriggerKey(spaceMentionTrigger);
	}
	showSpaceMentions = false;
}

function handleComposerInput() {
	scheduleResizeTextarea();
	// Input path: wait a frame so Safari caret is settled before detect.
	scheduleCaretSyncAndRefresh();
}

function handleComposerSelect() {
	// Coalesce with input/selectionchange in the same frame.
	scheduleCaretSyncAndRefresh();
}

function handleComposerClick() {
	scheduleCaretSyncAndRefresh();
}

function handleComposerKeyup(event: KeyboardEvent) {
	// Navigation keys move caret without changing value; rAF-merge held-key repeats.
	if (
		event.key === "ArrowLeft" ||
		event.key === "ArrowRight" ||
		event.key === "ArrowUp" ||
		event.key === "ArrowDown" ||
		event.key === "Home" ||
		event.key === "End" ||
		event.key === "PageUp" ||
		event.key === "PageDown"
	) {
		scheduleCaretSyncAndRefresh();
		return;
	}
	// IME composition end / process keys can leave caret lagging on Safari.
	if (event.key === "Process" || event.isComposing) return;
	scheduleCaretSyncAndRefresh();
}

function handleComposerCompositionEnd() {
	scheduleCaretSyncAndRefresh();
}

function bindSelectionChangeListener() {
	if (selectionChangeBound || typeof document === "undefined") return;
	document.addEventListener("selectionchange", handleDocumentSelectionChange);
	selectionChangeBound = true;
}

function unbindSelectionChangeListener() {
	if (!selectionChangeBound || typeof document === "undefined") return;
	document.removeEventListener(
		"selectionchange",
		handleDocumentSelectionChange,
	);
	selectionChangeBound = false;
}

function handleComposerFocus() {
	if (blurCloseTimer != null) {
		window.clearTimeout(blurCloseTimer);
		blurCloseTimer = null;
	}
	isTextareaFocused = true;
	bindSelectionChangeListener();
	syncCaretFromDom();
	refreshMentionState();
	if (
		slashCommandActive &&
		(filteredPromptTemplates.length > 0 || slashCommandLoading)
	) {
		showPromptSuggestions = true;
	}
}

function handleComposerBlur() {
	isTextareaFocused = false;
	unbindSelectionChangeListener();
	if (blurCloseTimer != null) window.clearTimeout(blurCloseTimer);
	blurCloseTimer = window.setTimeout(() => {
		blurCloseTimer = null;
		if (isTextareaFocused) return;
		// Close menus only — keep trigger/search so a false Safari blur can recover on refocus.
		showPromptSuggestions = false;
		showSpaceMentions = false;
	}, BLUR_MENU_CLOSE_MS);
}

function handleDocumentSelectionChange() {
	if (!isTextareaFocused || document.activeElement !== textareaEl) return;
	// selectionchange can fire in bursts; fold into the same rAF as input/caret paths.
	scheduleCaretSyncAndRefresh();
}

function abortSpaceMentionSearch() {
	spaceMentionSearchToken += 1;
	spaceMentionLocalController?.abort();
	spaceMentionRemoteController?.abort();
	spaceMentionLocalController = null;
	spaceMentionRemoteController = null;
	if (spaceMentionDebounceTimer != null) {
		window.clearTimeout(spaceMentionDebounceTimer);
		spaceMentionDebounceTimer = null;
	}
}

function resetSpaceMentionSearch() {
	abortSpaceMentionSearch();
	activeSpaceMentionSearchKey = null;
	localSpaceMentionItems = [];
	remoteSpaceMentionItems = [];
	spaceMentionLocalDone = true;
	spaceMentionRemoteDone = true;
	spaceMentionRemoteError = null;
	selectedSpaceMentionIndex = 0;
	selectedSpaceMentionId = null;
}

function selectSpaceMentionIndex(index: number) {
	selectedSpaceMentionIndex = index;
	selectedSpaceMentionId = spaceMentionItems[index]?.spaceId ?? null;
}

function scheduleSpaceMentionSearch(
	trigger: {
		start: number;
		query: string;
	} | null,
) {
	if (!trigger) {
		if (activeSpaceMentionSearchKey != null) resetSpaceMentionSearch();
		return;
	}

	const q = trigger.query.trim();
	const searchKey = `${trigger.start}:${currentSpaceId ?? ""}:${q}`;
	if (searchKey === activeSpaceMentionSearchKey) return;

	abortSpaceMentionSearch();
	activeSpaceMentionSearchKey = searchKey;
	spaceMentionLocalDone = false;
	spaceMentionRemoteDone = q.length < 2;
	spaceMentionRemoteError = null;
	const token = spaceMentionSearchToken;
	spaceMentionLocalController = new AbortController();
	void searchLocalSpaceMentions(q, {
		signal: spaceMentionLocalController.signal,
		currentSpaceId,
	})
		.then((items) => {
			if (token !== spaceMentionSearchToken) return;
			localSpaceMentionItems = items;
		})
		.catch(async (error) => {
			if (error?.name === "AbortError") return;
			console.warn("[space-mentions] local search failed", error);
			// Safari may drop IDB after backgrounding; one delayed soft retry is enough.
			const signal = spaceMentionLocalController?.signal;
			if (signal?.aborted) return;
			await new Promise<void>((resolve) => {
				window.setTimeout(resolve, LOCAL_MENTION_SEARCH_RETRY_MS);
			});
			if (token !== spaceMentionSearchToken || signal?.aborted) return;
			try {
				const items = await searchLocalSpaceMentions(q, {
					signal,
					currentSpaceId,
				});
				if (token !== spaceMentionSearchToken) return;
				localSpaceMentionItems = items;
			} catch (retryError) {
				if ((retryError as { name?: string })?.name !== "AbortError") {
					console.warn(
						"[space-mentions] local search retry failed",
						retryError,
					);
				}
			}
		})
		.finally(() => {
			if (token === spaceMentionSearchToken) spaceMentionLocalDone = true;
		});
	if (q.length < 2) {
		remoteSpaceMentionItems = [];
		return;
	}
	spaceMentionRemoteController = new AbortController();
	spaceMentionDebounceTimer = window.setTimeout(() => {
		void searchRemoteSpaceMentions(q, {
			signal: spaceMentionRemoteController?.signal,
			currentSpaceId,
		})
			.then((items) => {
				if (token !== spaceMentionSearchToken) return;
				remoteSpaceMentionItems = items;
				spaceMentionRemoteError = null;
			})
			.catch((error) => {
				if (token !== spaceMentionSearchToken || error?.name === "AbortError")
					return;
				spaceMentionRemoteError =
					error instanceof Error ? error.message : "server unavailable";
			})
			.finally(() => {
				if (token === spaceMentionSearchToken) spaceMentionRemoteDone = true;
			});
	}, 180);
}

function applySpaceMention(item: SpaceMentionSuggestion) {
	const trigger = spaceMentionTrigger;
	if (!trigger) return;
	const snippet = `${buildSpaceMentionMarkdown({ spaceId: item.spaceId, label: item.name })} `;
	value = value.slice(0, trigger.start) + snippet + value.slice(trigger.end);
	showSpaceMentions = false;
	spaceMentionTrigger = null;
	dismissedSpaceMentionKey = null;
	selectedSpaceMentionIndex = 0;
	selectedSpaceMentionId = null;
	requestAnimationFrame(() => {
		const pos = trigger.start + snippet.length;
		textareaEl?.focus();
		setTextareaSelection(pos);
		resizeTextarea();
		refreshMentionState();
	});
}

function insertSnippet(
	snippet: string,
	options: { focus?: boolean; replacementKey?: string } = {},
) {
	const replacement = options.replacementKey
		? composerInsertRanges.get(options.replacementKey)
		: null;
	const canReplace = Boolean(
		replacement &&
			value.slice(replacement.start, replacement.end) === replacement.text,
	);
	if (!canReplace) syncCaretFromDom();
	const start = canReplace ? (replacement?.start ?? value.length) : caret.start;
	const end = canReplace ? (replacement?.end ?? start) : caret.end;

	value = value.slice(0, start) + snippet + value.slice(end);
	const range = { start, end: start + snippet.length, text: snippet };
	if (options.replacementKey) {
		if (snippet) composerInsertRanges.set(options.replacementKey, range);
		else composerInsertRanges.delete(options.replacementKey);
	}

	requestAnimationFrame(() => {
		const pos = start + snippet.length;
		setTextareaSelection(pos);
		if (options.focus !== false) textareaEl?.focus();
		resizeTextarea();
		refreshMentionState();
	});
	return range;
}

function focusComposer() {
	requestAnimationFrame(() => {
		textareaEl?.focus();
	});
}

function handlePaste(event: ClipboardEvent) {
	const clipboardText = event.clipboardData?.getData("text/plain") ?? "";
	if (clipboardText) {
		pastedSpaceResolveController?.abort();
		pastedSpaceResolveController = null;
		pastedAppResolveController?.abort();
		pastedAppResolveController = null;
	}

	const pastedSpaceLinks = clipboardText
		? parseCohubSpaceUrls(clipboardText)
		: [];
	const pastedAppLinks = clipboardText ? parseCohubAppUrls(clipboardText) : [];
	if (pastedSpaceLinks.length > 0 || pastedAppLinks.length > 0) {
		event.preventDefault();
		const spaceLabels = new Map<string, string>();
		const appLabels = new Map<string, string>();
		const knownSpaces = new Map<string, SpaceMentionSuggestion>();
		for (const item of spaceMentionItems) knownSpaces.set(item.spaceId, item);
		for (const link of pastedSpaceLinks) {
			const label = link.sessionId ? null : knownSpaces.get(link.spaceId)?.name;
			if (label) spaceLabels.set(getCohubLinkMentionKey(link), label);
		}

		const renderSegment = () =>
			replaceCohubResourceUrls(clipboardText, {
				space: (link) => spaceLabels.get(getCohubLinkMentionKey(link)),
				app: (link) => appLabels.get(getCohubAppLinkKey(link)),
			});
		let renderedSegment = renderSegment();
		const inserted = insertSnippet(renderedSegment);
		const applyResolvedLabels = () => {
			if (value.slice(inserted.start, inserted.end) !== renderedSegment) return;
			const nextSegment = renderSegment();
			if (nextSegment === renderedSegment) return;
			value =
				value.slice(0, inserted.start) +
				nextSegment +
				value.slice(inserted.end);
			inserted.end = inserted.start + nextSegment.length;
			renderedSegment = nextSegment;
			scheduleResizeTextarea();
			scheduleCaretSyncAndRefresh();
		};

		const unresolvedSpaces = pastedSpaceLinks.filter(
			(link) => !spaceLabels.has(getCohubLinkMentionKey(link)),
		);
		if (unresolvedSpaces.length > 0) {
			const controller = new AbortController();
			pastedSpaceResolveController = controller;
			void resolveCohubLinkMentionLabels(unresolvedSpaces, {
				signal: controller.signal,
			})
				.then((labels) => {
					if (controller.signal.aborted || labels.size === 0) return;
					for (const [key, label] of labels) spaceLabels.set(key, label);
					applyResolvedLabels();
				})
				.catch((error) => {
					if (error?.name !== "AbortError")
						console.warn("[space-mentions] pasted link resolve failed", error);
				});
		}

		if (pastedAppLinks.length > 0) {
			const controller = new AbortController();
			pastedAppResolveController = controller;
			void resolveCohubAppLinkMentionLabels(pastedAppLinks, {
				signal: controller.signal,
			})
				.then((labels) => {
					if (controller.signal.aborted || labels.size === 0) return;
					for (const [key, label] of labels) appLabels.set(key, label);
					applyResolvedLabels();
				})
				.catch((error) => {
					if (error?.name !== "AbortError")
						console.warn("[work-mentions] pasted link resolve failed", error);
				});
		}
		return;
	}

	const files = Array.from(event.clipboardData?.items ?? [])
		.filter((item) => item.kind === "file")
		.map((item) => item.getAsFile())
		.filter((file): file is File => file instanceof File);

	if (files.length === 0) return;
	event.preventDefault();
	onpickattachment?.(entriesFromFiles(files));
}

onMount(() => {
	if (mobileAutoFocusOnMount || !isMobileComposerInput()) focusComposer();
	const handleComposerInsert = (event: Event) => {
		const custom = event as CustomEvent<{
			snippet?: string;
			focus?: boolean;
			replacementKey?: string;
		}>;
		const snippet = custom.detail?.snippet;
		if (snippet === undefined) return;
		insertSnippet(snippet, {
			focus: custom.detail.focus,
			replacementKey: custom.detail.replacementKey,
		});
	};
	const handleFocusComposer = () => focusComposer();
	const handleViewportResize = () => scheduleResizeTextarea();
	const handleComposerAttachFiles = (event: Event) => {
		const custom = event as CustomEvent<{ files?: File[] }>;
		const files = custom.detail?.files;
		if (!files || files.length === 0) return;
		onpickattachment?.(files);
		focusComposer();
	};
	window.addEventListener("cohub:composer-focus", handleFocusComposer);
	window.addEventListener("cohub:composer-insert", handleComposerInsert);
	window.addEventListener(
		"cohub:composer-attach-files",
		handleComposerAttachFiles,
	);
	window.addEventListener("resize", handleViewportResize);
	window.visualViewport?.addEventListener("resize", handleViewportResize);
	return () => {
		window.removeEventListener("cohub:composer-focus", handleFocusComposer);
		window.removeEventListener("cohub:composer-insert", handleComposerInsert);
		window.removeEventListener(
			"cohub:composer-attach-files",
			handleComposerAttachFiles,
		);
		window.removeEventListener("resize", handleViewportResize);
		window.visualViewport?.removeEventListener("resize", handleViewportResize);
		unbindSelectionChangeListener();
		spaceMentionLocalController?.abort();
		spaceMentionRemoteController?.abort();
		pastedSpaceResolveController?.abort();
		pastedAppResolveController?.abort();
		closeVoiceInput();
		cancelScheduledResize();
		cancelScheduledCaretSync();
		if (spaceMentionDebounceTimer != null)
			window.clearTimeout(spaceMentionDebounceTimer);
		if (blurCloseTimer != null) window.clearTimeout(blurCloseTimer);
	};
});

$effect(() => {
	value;
	attachments.length;
	isComposerExpanded;
	scheduleResizeTextarea();
});

$effect(() => {
	const shouldShow =
		slashCommandActive &&
		!showSpaceMentions &&
		(filteredPromptTemplates.length > 0 || slashCommandLoading);
	showPromptSuggestions = shouldShow;
	if (!shouldShow) {
		selectedPromptIndex = 0;
		return;
	}
	selectedPromptIndex = Math.min(
		selectedPromptIndex,
		Math.max(filteredPromptTemplates.length - 1, 0),
	);
});

// Fallback for external value changes (draft restore, parent bind, etc.).
// Input/caret paths also refresh; rAF coalescing keeps this cheap.
$effect(() => {
	value;
	slashCommandActive;
	scheduleCaretSyncAndRefresh();
});

$effect(() => {
	if (spaceMentionItems.length === 0) {
		selectedSpaceMentionIndex = 0;
		selectedSpaceMentionId = null;
		return;
	}

	if (selectedSpaceMentionId) {
		const index = spaceMentionItems.findIndex(
			(item) => item.spaceId === selectedSpaceMentionId,
		);
		if (index !== -1) {
			selectedSpaceMentionIndex = index;
			return;
		}
	}

	selectedSpaceMentionIndex = Math.min(
		selectedSpaceMentionIndex,
		spaceMentionItems.length - 1,
	);
	selectedSpaceMentionId =
		spaceMentionItems[selectedSpaceMentionIndex]?.spaceId ?? null;
});
</script>

<div class="px-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-2 sm:px-4 sm:pb-4">
	<div class={`relative mx-auto transition-[max-width] duration-200 ${isComposerExpanded ? 'max-w-[var(--chat-composer-expanded-max-width)]' : 'max-w-[var(--chat-composer-max-width)]'}`}>
		{#if quickActions.length > 0}
			<div class="mb-2">
				<SessionChatQuickActions
					actions={quickActions}
					disabled={disabled || sending}
					onsend={(action) => {
						onquickaction?.(action);
					}}
				/>
			</div>
		{/if}
		{#if streamError}
			{#if showBillingAction}
				<button type="button" class="mb-3 flex w-full cursor-pointer items-center justify-between gap-3 rounded-2xl border border-error-soft/25 bg-error-bg px-3 py-2 text-left text-[11px] text-error-soft transition-colors hover:border-error-soft/40 hover:bg-error-bg/80 focus:outline-none focus:ring-1 focus:ring-error-soft/40" onclick={() => billingConversion.openFallbackHard()}>
					<span class="min-w-0 break-words">{streamError}</span>
				</button>
			{:else}
				<div class="mb-3 rounded-2xl border border-error-soft/25 bg-error-bg px-3 py-2 text-[11px] text-error-soft">
					{streamError}
				</div>
			{/if}
		{/if}

		<ComposerSurface onsubmit={submitDraft}>
			{#if viewportContexts.length > 0}
				<div class="mb-1.5 px-3 pt-1" data-drawer-swipe-ignore>
					<ViewportContextBlocks
						contexts={viewportContexts}
						removable
						onRemove={onremoveviewport}
					/>
				</div>
			{/if}

			{#if attachments.length > 0}
				<div
					class={`mb-2 flex flex-wrap gap-2 overflow-y-auto px-3 pb-1 ${isComposerExpanded ? 'max-h-36' : 'max-h-24'}`}
					data-drawer-swipe-ignore
				>
					{#each attachments as attachment (attachment.id)}
						<div class={`group relative shrink-0 overflow-hidden rounded-2xl border border-border-subtle bg-bg-content transition-colors hover:border-border-strong ${attachment.kind === 'image' ? 'h-20 w-20 bg-bg-hover/45' : 'flex h-20 w-40 items-center px-3 py-2'}`}>
							{#if attachment.kind === 'image'}
								<button
									type="button"
									class="h-full w-full cursor-zoom-in p-0"
									onclick={() => openComposerImagePreview(attachment)}
									title={m.composer_preview_image({}, { locale })}
									aria-label={m.composer_preview_named_image({ name: attachment.name }, { locale })}
								>
									<img src={attachment.previewUrl} alt={attachment.name} class="h-full w-full object-contain transition-transform duration-200 group-hover:scale-[1.02]" />
								</button>
							{:else}
								<div class="min-w-0 flex-1 pr-4">
									<div class="truncate text-[12px] font-medium leading-4 text-text-primary" title={attachment.kind === 'file' ? attachment.relativePath : attachment.name}>{attachment.kind === 'file' ? attachment.relativePath : attachment.name}</div>
									<div class="mt-0.5 flex items-center gap-1.5 text-[10px] leading-3 text-text-tertiary">
										<span>{attachment.kind === 'file' ? 'File' : 'Text'}</span>
										<span aria-hidden="true">·</span>
										<span>{Math.ceil(attachment.size / 1024)} KB</span>
										{#if attachment.kind === 'file'}
											<span aria-hidden="true">·</span>
											<span class="min-w-0 truncate">{attachment.status === 'uploading' ? `Uploading ${Math.round(attachment.progress ?? 0)}%` : attachment.status === 'finalizing' ? 'Finalizing' : attachment.status === 'failed' ? 'Failed' : 'Ready'}</span>
										{/if}
									</div>
								</div>
							{/if}
							{#if (attachment.kind === 'file' || attachment.kind === 'image') && (attachment.status === 'uploading' || attachment.status === 'finalizing')}
								<UploadProgress class="absolute inset-x-0 bottom-0 z-10" value={attachment.status === 'uploading' ? attachment.progress ?? 0 : null} label={`Upload ${attachment.name}`} />
							{/if}
							<button
								type="button"
								class="absolute right-1.5 top-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full bg-bg-elevated/90 text-text-tertiary opacity-0 shadow-sm ring-1 ring-border-subtle transition-all hover:text-text-primary group-hover:opacity-100"
								onclick={() => onremoveattachment?.(attachment.id)}
								title={m.composer_remove_attachment({}, { locale })}
							>
								<X class="h-3.5 w-3.5" />
							</button>
						</div>
					{/each}
				</div>
			{/if}

			<div class="flex items-end gap-2">
				<div class="relative min-w-0 flex-1 rounded-[22px] bg-transparent px-3 py-1.5 ring-1 ring-transparent transition-colors focus-within:bg-transparent focus-within:ring-transparent">
					<input
						bind:this={fileInputEl}
						type="file"
						accept={COMPOSER_ATTACHMENT_ACCEPT}
						multiple
						class="hidden"
						onchange={(event) => {
							const files = Array.from((event.currentTarget as HTMLInputElement).files ?? []);
							onpickattachment?.(entriesFromFiles(files));
							(event.currentTarget as HTMLInputElement).value = "";
						}}
					/>

					<div class="composer-input-shell relative min-h-[44px]">
						{#if shouldRenderComposerMentionMirror}
							<div
								bind:this={mentionMirrorEl}
								class="composer-mention-mirror pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-[14px] leading-6 text-text-primary"
								aria-hidden="true"
							>
								{#each composerMentionTokens as token}
									{#if token.type !== 'text'}<span
										class="composer-space-mention"
										data-space-id={token.type === 'spaceMention' ? token.spaceId : undefined}
										data-work-ref={token.type === 'appMention' ? `${token.username}/${token.spaceSlug}/${token.appSlug}` : undefined}
									>@{token.label}</span>{:else}{token.text}{/if}
								{/each}
							</div>
						{/if}

						<textarea
							bind:this={textareaEl}
							bind:value
							rows="1"
							placeholder={composerPlaceholder}
							class={`relative z-[1] block min-h-[44px] w-full resize-none overflow-y-auto overscroll-contain bg-transparent px-0 py-0 text-[14px] leading-6 outline-none placeholder:text-text-placeholder ${shouldRenderComposerMentionMirror ? 'text-transparent caret-text-primary selection:bg-brand/22' : 'text-text-primary'}`}
							onpointerdown={() => {
								isTextareaFocused = true;
							}}
							oninput={handleComposerInput}
							onscroll={syncMentionMirrorScroll}
							onselect={handleComposerSelect}
							onclick={handleComposerClick}
							onkeyup={handleComposerKeyup}
							oncompositionend={handleComposerCompositionEnd}
							onpaste={handlePaste}
							onblur={handleComposerBlur}
							onfocus={handleComposerFocus}
						onkeydown={(event) => {
							if (event.key === 'Escape' && showSpaceMentions) {
								event.preventDefault();
								dismissSpaceMentions();
								return;
							}

							if (showSpaceMentions) {
								const key = event.key.toLowerCase();
								const isEmacsNext = event.ctrlKey && !event.metaKey && !event.altKey && key === 'n';
								const isEmacsPrevious = event.ctrlKey && !event.metaKey && !event.altKey && key === 'p';
								if (spaceMentionItems.length > 0 && (event.key === 'ArrowDown' || isEmacsNext)) {
									event.preventDefault();
									selectSpaceMentionIndex(Math.min(selectedSpaceMentionIndex + 1, spaceMentionItems.length - 1));
									return;
								}
								if (spaceMentionItems.length > 0 && (event.key === 'ArrowUp' || isEmacsPrevious)) {
									event.preventDefault();
									selectSpaceMentionIndex(Math.max(selectedSpaceMentionIndex - 1, 0));
									return;
								}
								if (spaceMentionItems.length > 0 && event.key === 'Home') {
									event.preventDefault();
									selectSpaceMentionIndex(0);
									return;
								}
								if (spaceMentionItems.length > 0 && event.key === 'End') {
									event.preventDefault();
									selectSpaceMentionIndex(spaceMentionItems.length - 1);
									return;
								}
								if (
									spaceMentionItems.length > 0 &&
									(event.key === 'Tab' ||
										(event.key === 'Enter' && !isComposingKeyboardEvent(event)))
								) {
									if (!(event.key === 'Enter' && event.shiftKey)) {
										event.preventDefault();
										const selected = spaceMentionItems[selectedSpaceMentionIndex];
										if (selected) applySpaceMention(selected);
										return;
									}
								}
							}

							if (event.key === 'Escape' && showPromptSuggestions) {
								event.preventDefault();
								showPromptSuggestions = false;
								return;
							}

							if (showPromptSuggestions && (filteredPromptTemplates.length > 0 || slashCommandLoading)) {
								const key = event.key.toLowerCase();
								const isEmacsNext = event.ctrlKey && !event.metaKey && !event.altKey && key === 'n';
								const isEmacsPrevious = event.ctrlKey && !event.metaKey && !event.altKey && key === 'p';

								if (filteredPromptTemplates.length > 0 && (event.key === 'ArrowDown' || isEmacsNext)) {
									event.preventDefault();
									selectedPromptIndex = Math.min(selectedPromptIndex + 1, filteredPromptTemplates.length - 1);
									return;
								}
								if (filteredPromptTemplates.length > 0 && (event.key === 'ArrowUp' || isEmacsPrevious)) {
									event.preventDefault();
									selectedPromptIndex = Math.max(selectedPromptIndex - 1, 0);
									return;
								}
								if (filteredPromptTemplates.length > 0 && event.key === 'Home') {
									event.preventDefault();
									selectedPromptIndex = 0;
									return;
								}
								if (filteredPromptTemplates.length > 0 && event.key === 'End') {
									event.preventDefault();
									selectedPromptIndex = filteredPromptTemplates.length - 1;
									return;
								}
								if (
									filteredPromptTemplates.length > 0 &&
									(event.key === 'Tab' ||
										(event.key === 'Enter' && !isComposingKeyboardEvent(event)))
								) {
									if (!(event.key === 'Enter' && event.shiftKey)) {
										event.preventDefault();
										const selected = filteredPromptTemplates[selectedPromptIndex];
										if (selected) applyPromptTemplate(selected);
										return;
									}
								}
								if (event.key === 'Escape') {
									showPromptSuggestions = false;
									return;
								}
							}

							if (event.key === 'Escape') {
								event.preventDefault();
								if (isComposerExpanded) {
									isComposerExpanded = false;
									scheduleResizeTextarea();
									return;
								}
								textareaEl?.blur();
								return;
							}

							if (
								getComposerKeyAction(event, {
									mobile: isMobileComposerInput(),
								}) === 'submit'
							) {
								event.preventDefault();
								submitDraft();
							}
						}}
						></textarea>
					</div>

					<SlashCommandMenu
						open={showPromptSuggestions}
						items={filteredPromptTemplates}
						query={slashCommandQuery}
						selectedIndex={selectedPromptIndex}
						loading={slashCommandLoading}
						onhighlight={(index) => {
							selectedPromptIndex = index;
						}}
						onselect={applyPromptTemplate}
					/>

					<SpaceMentionMenu
						open={showSpaceMentions}
						items={spaceMentionItems}
						query={spaceMentionTrigger?.query ?? ""}
						selectedIndex={selectedSpaceMentionIndex}
						loading={spaceMentionLoading}
						status={spaceMentionStatus}
						onhighlight={(index) => {
							selectSpaceMentionIndex(index);
						}}
						onselect={applySpaceMention}
					/>

					<div class="mt-1.5 flex items-center justify-between gap-2">
						<div class="flex min-w-0 items-center gap-1">
							{#if onpickattachment}
								<button
									type="button"
									class="-ml-2 flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
									onclick={() => fileInputEl?.click()}
									disabled={disabled || sending}
									title={m.composer_add_attachment({}, { locale })}
									aria-label={m.composer_add_attachment({}, { locale })}
								>
									<Plus class="h-[17px] w-[17px]" />
								</button>
							{/if}

							{#if onmodechange && mode === "create"}
								<div class="relative shrink-0">
									<button
										type="button"
										class="flex h-7 items-center gap-1 rounded-full border border-border-subtle px-2 text-[11px] leading-none text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
										disabled={disabled || sending}
										aria-label="Mode Create"
										aria-expanded={showModeMenu}
										aria-haspopup="menu"
										onclick={() => {
											showModeMenu = !showModeMenu;
										}}
										onkeydown={(event) => {
											if (event.key === "Escape") showModeMenu = false;
										}}
									>
										<span>Create</span>
										<ChevronDown class="h-3 w-3 opacity-45" />
									</button>
									{#if showModeMenu}
										<button type="button" class="fixed inset-0 z-30 cursor-default" aria-hidden="true" tabindex="-1" onclick={() => { showModeMenu = false; }}></button>
										<div
											class="absolute bottom-full left-0 z-40 mb-1.5 w-36 overflow-hidden rounded-md border border-border-subtle bg-bg-primary p-1 shadow-lg"
											role="menu"
											tabindex="-1"
											aria-label="Composer mode"
											onkeydown={(event) => {
												if (event.key === "Escape") showModeMenu = false;
											}}
										>
											{#each ["agent", "create"] as item}
												<button
													type="button"
													class={`flex min-h-10 w-full items-center gap-2 rounded px-2 text-left text-[12px] transition-colors hover:bg-bg-hover ${mode === item ? "text-text-primary" : "text-text-secondary"}`}
													role="menuitemradio"
													aria-checked={mode === item}
													onclick={() => {
														onmodechange?.(item as "agent" | "create");
														showModeMenu = false;
													}}
												>
													<span class="flex-1">{item === "agent" ? m.composer_agent({}, { locale }) : m.composer_create({}, { locale })}</span>
													{#if mode === item}<Check class="h-3.5 w-3.5 text-brand" />{/if}
												</button>
											{/each}
										</div>
									{/if}
								</div>
							{/if}

							{#if onModelSelect}
								<ComposerModelTrigger
									label={modelControlLabel}
									meta={[thinkingLevelLabel, generationPolicyLabel].filter(
										(value): value is string => Boolean(value),
									)}
									ariaLabel={modelControlAriaLabel}
									disabled={disabled || sending}
									onclick={() => onModelSelect?.()}
								/>
							{/if}
						</div>

						<div class="flex items-center gap-2">
							{#if isVoiceStarting || isVoiceRecording || voiceError}
								<span class={`max-w-[160px] truncate text-[11px] leading-none ${voiceError ? 'text-error-soft' : 'text-text-placeholder'}`}>
									{voiceError ?? (isVoiceStarting ? 'Starting…' : 'Listening')}
								</span>
							{/if}
							{#if hasTextareaOverflow || isComposerExpanded}
								<button
									type="button"
									class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
									title={isComposerExpanded ? m.composer_collapse({}, { locale }) : m.composer_expand({}, { locale })}
									aria-label={isComposerExpanded ? m.composer_collapse({}, { locale }) : m.composer_expand({}, { locale })}
									aria-expanded={isComposerExpanded}
									onpointerdown={(event) => event.preventDefault()}
									onclick={toggleComposerExpansion}
								>
									{#if isComposerExpanded}
										<Minimize2 class="h-4 w-4" />
									{:else}
										<Maximize2 class="h-4 w-4" />
									{/if}
								</button>
							{/if}
							<button
								type="button"
								class={`voice-record-button relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-all disabled:cursor-not-allowed disabled:opacity-50 ${isVoiceRecording ? 'border-brand/45 bg-brand text-brand-contrast-fg shadow-sm' : isVoiceStarting ? 'border-border-subtle bg-bg-hover-strong text-text-secondary' : 'border-transparent text-text-tertiary hover:bg-bg-hover hover:text-text-primary'}`}
								disabled={disabled || sending || isVoiceStarting}
								title={isVoiceRecording ? m.composer_stop_voice({}, { locale }) : m.composer_start_voice({}, { locale })}
								aria-label={isVoiceRecording ? m.composer_stop_voice({}, { locale }) : m.composer_start_voice({}, { locale })}
								aria-pressed={isVoiceRecording}
								oncontextmenu={(event) => event.preventDefault()}
								onclick={toggleVoiceInput}
							>
								<Mic class="h-4 w-4" />
							</button>
							<ComposerSubmitButton
								label={showAbort ? "Stop generation" : "Send"}
								stop={showAbort}
								disabled={showAbort ? disabled || aborting : submitDisabled}
								onclick={showAbort ? () => onabort?.() : undefined}
							/>
						</div>
					</div>
				</div>
			</div>
		</ComposerSurface>
	</div>
</div>

<style>
	.voice-record-button {
		touch-action: manipulation;
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
	}

	.composer-input-shell textarea,
	.composer-mention-mirror {
		font: inherit;
		font-size: 14px;
		line-height: 1.5rem;
		letter-spacing: inherit;
		tab-size: 4;
	}

	.composer-mention-mirror {
		min-height: 44px;
		overflow-wrap: anywhere;
		word-break: break-word;
	}

	.composer-space-mention {
		display: inline;
		box-decoration-break: clone;
		-webkit-box-decoration-break: clone;
		border: 1px solid color-mix(in srgb, var(--brand) 24%, transparent);
		border-radius: 999px;
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--brand) 13%, transparent),
				color-mix(in srgb, var(--brand) 8%, transparent)
			),
			var(--bg-content);
		color: var(--brand);
		font-weight: 520;
		padding: 0.03rem 0.42rem 0.08rem;
		text-shadow: 0 0 0 color-mix(in srgb, var(--brand) 44%, transparent);
		white-space: pre-wrap;
	}

	:global([data-theme="light"]) .composer-space-mention {
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--brand) 10%, white),
				color-mix(in srgb, var(--brand) 5%, white)
			),
			var(--bg-content);
	}
</style>
