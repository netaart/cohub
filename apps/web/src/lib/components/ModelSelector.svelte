<script lang="ts">
import type {
	GenerationModelPricing,
	PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import type { ModelStatusEntry } from "@cohub/protocol/model/status";
import { Brain, Check, ChevronDown, Image } from "lucide-svelte";
import Dialog from "$lib/components/Dialog.svelte";
import { getGenerationModelPickerItems } from "$lib/generation-model-catalog";
import { formatCurrency } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import {
	type AvailabilityLevel,
	availabilityLevel,
} from "$lib/model-availability";
import {
	clampThinkingLevel,
	formatThinkingLevelFull,
	formatThinkingLevelShort,
	getModelDefaultThinkingLevel,
	getSupportedThinkingLevels,
	type ModelThinkingLevel,
} from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";

type ModelItem = {
	provider: string;
	id: string;
	model: Record<string, unknown> & { hidden?: boolean };
};

type NumericGenerationConstraint = {
	min?: number;
	max?: number;
};

type BooleanGenerationConstraint = {
	value?: boolean;
};

type Props = {
	open: boolean;
	/** Local catalogs share search/selection, without Cloud generation policy. */
	showGeneration?: boolean;
	title?: string;
	onSelectDefault?: () => void;
	defaultLabel?: string;
	onClose: () => void;
	onSelect: (item: {
		provider: string;
		id: string;
		thinkingLevel?: ModelThinkingLevel;
	}) => void;
	models: ModelItem[];
	currentModel?: { provider: string; id: string } | null;
	/** Model the session thinking level is bound to. Defaults to currentModel. */
	thinkingLevelModel?: { provider: string; id: string } | null;
	currentThinkingLevel?: ModelThinkingLevel | null;
	modelStatus?: Record<string, ModelStatusEntry> | null;
	generationModels?: PublicGenerationDeclaration[];
	generationPolicyMode?: "auto" | "limited";
	selectedGenerationModels?: Set<string>;
	generationEnumSelections?: Record<string, Record<string, Set<string>>>;
	generationNumericConstraints?: Record<
		string,
		Record<string, NumericGenerationConstraint>
	>;
	generationBooleanConstraints?: Record<
		string,
		Record<string, BooleanGenerationConstraint>
	>;
	onGenerationPolicyModeChange?: (mode: "auto" | "limited") => void;
	onGenerationModelToggle?: (model: string, selected: boolean) => void;
	onGenerationEnumValueToggle?: (
		model: string,
		parameter: string,
		value: string,
		selected: boolean,
	) => void;
	onGenerationNumericConstraintChange?: (
		model: string,
		parameter: string,
		constraint: NumericGenerationConstraint,
	) => void;
	onGenerationBooleanConstraintChange?: (
		model: string,
		parameter: string,
		constraint: BooleanGenerationConstraint,
	) => void;
	onGenerationTabOpen?: () => void;
};

const {
	open,
	showGeneration = true,
	title,
	onSelectDefault,
	defaultLabel,
	onClose,
	onSelect,
	models,
	currentModel = null,
	thinkingLevelModel = null,
	currentThinkingLevel = null,
	modelStatus = null,
	generationModels = [],
	generationPolicyMode = "auto",
	selectedGenerationModels = new Set<string>(),
	generationEnumSelections = {},
	generationNumericConstraints = {},
	generationBooleanConstraints = {},
	onGenerationPolicyModeChange,
	onGenerationModelToggle,
	onGenerationEnumValueToggle,
	onGenerationNumericConstraintChange,
	onGenerationBooleanConstraintChange,
	onGenerationTabOpen,
}: Props = $props();

const STATUS_PROVIDER = "cohub";
const locale = $derived(getLocale());

let searchQuery = $state("");
let generationSearchQuery = $state("");
let selectedIndex = $state(0);
let navigationMode: "mouse" | "keyboard" = $state("mouse");
let activeTab: "chat" | "generation" = $state("chat");
let expandedGenerationModels = $state<Set<string>>(new Set());
let expandedGenerationParameters = $state<Set<string>>(new Set());
let containerEl = $state<HTMLElement | null>(null);
let searchInputEl = $state<HTMLInputElement | null>(null);
let thinkingMenuOpenFor = $state<string | null>(null);
let thinkingMenuPos = $state<{ top: number; right: number } | null>(null);
let thinkingMenuTrigger = $state<HTMLElement | null>(null);

function closeThinkingMenu() {
	thinkingMenuOpenFor = null;
	thinkingMenuPos = null;
	thinkingMenuTrigger = null;
}

function positionThinkingMenu(trigger: HTMLElement, menuHeight = 240) {
	const rect = trigger.getBoundingClientRect();
	const menuWidth = 148;
	const gap = 4;
	const viewportPad = 8;
	const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPad;
	const spaceAbove = rect.top - gap - viewportPad;
	const openUpward = spaceBelow < menuHeight && spaceAbove > spaceBelow;
	let top: number;
	if (openUpward) {
		top = Math.max(viewportPad, rect.top - menuHeight - gap);
	} else {
		top = Math.min(
			window.innerHeight -
				Math.min(menuHeight, spaceBelow + viewportPad) -
				viewportPad,
			rect.bottom + gap,
		);
	}
	const right = Math.max(viewportPad, window.innerWidth - rect.right);
	// Keep menu fully on-screen when trigger is near left edge.
	const maxRight = window.innerWidth - menuWidth - viewportPad;
	thinkingMenuPos = {
		top: Math.max(viewportPad, top),
		right: Math.min(right, Math.max(viewportPad, maxRight)),
	};
}

function thinkingMenuAnchor(menuEl: HTMLElement) {
	const trigger = thinkingMenuTrigger;
	if (!trigger) return {};
	const frame = requestAnimationFrame(() => {
		const height = menuEl.getBoundingClientRect().height;
		if (height > 0) positionThinkingMenu(trigger, height);
	});
	return {
		destroy() {
			cancelAnimationFrame(frame);
		},
	};
}

$effect(() => {
	if (!thinkingMenuOpenFor || !open) return;
	const onViewportChange = () => closeThinkingMenu();
	window.addEventListener("resize", onViewportChange);
	// Close when the model list scrolls so the fixed menu doesn't float off the trigger.
	const scrollRoot = containerEl;
	scrollRoot?.addEventListener("scroll", onViewportChange, { passive: true });
	return () => {
		window.removeEventListener("resize", onViewportChange);
		scrollRoot?.removeEventListener("scroll", onViewportChange);
	};
});

// Hover card for model availability detail.
let hoveredModelId = $state<string | null>(null);
let hoverCardEl = $state<HTMLElement | null>(null);
let hoverAnchorRect = $state<DOMRect | null>(null);
let hoverShowTimer: ReturnType<typeof setTimeout> | null = null;
let hoverHideTimer: ReturnType<typeof setTimeout> | null = null;

function getVisibleSearchInput() {
	if (searchInputEl && searchInputEl.getClientRects().length > 0) {
		return searchInputEl;
	}
	return (
		Array.from(
			document.querySelectorAll<HTMLInputElement>(
				'[data-model-selector-search="true"]',
			),
		).find((input) => input.getClientRects().length > 0) ?? null
	);
}

function focusSearchInputSoon() {
	requestAnimationFrame(() => {
		getVisibleSearchInput()?.focus();
	});
}

function getDisplayName(item: ModelItem): string {
	const name = item.model.name;
	return typeof name === "string" && name.trim() ? name : item.id;
}

function hasVision(item: ModelItem): boolean {
	const input = item.model.input as string[] | undefined;
	return input?.includes("image") ?? false;
}

function thinkingLevels(item: ModelItem): ModelThinkingLevel[] {
	return getSupportedThinkingLevels(item as never);
}

function candidateThinkingLevel(item: ModelItem): ModelThinkingLevel {
	// Thinking level follows the model: only the session's recorded model
	// shows the session level; all others show their own default.
	const bound = thinkingLevelModel ?? currentModel;
	const isBound =
		bound !== null && item.provider === bound.provider && item.id === bound.id;
	return clampThinkingLevel(
		item as never,
		isBound
			? (currentThinkingLevel ?? getModelDefaultThinkingLevel(item as never))
			: getModelDefaultThinkingLevel(item as never),
	);
}

function isDefaultLevel(item: ModelItem, level: ModelThinkingLevel): boolean {
	return level === getModelDefaultThinkingLevel(item as never);
}

function thinkingMenuKey(item: ModelItem): string {
	return `${item.provider}/${item.id}`;
}

function toggleThinkingMenu(item: ModelItem, e: MouseEvent) {
	e.stopPropagation();
	e.preventDefault();
	const key = thinkingMenuKey(item);
	if (thinkingMenuOpenFor === key) {
		closeThinkingMenu();
		return;
	}
	const trigger = e.currentTarget as HTMLElement | null;
	thinkingMenuTrigger = trigger;
	if (trigger) positionThinkingMenu(trigger);
	thinkingMenuOpenFor = key;
}

function selectThinkingLevel(item: ModelItem, level: ModelThinkingLevel) {
	closeThinkingMenu();
	onSelect({ provider: item.provider, id: item.id, thinkingLevel: level });
}

function handleModelClick(item: ModelItem) {
	onSelect({ provider: item.provider, id: item.id });
}

function isHiddenModel(item: ModelItem): boolean {
	return item.model.hidden === true;
}

type ModelCost = {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
};

function getModelCost(item: ModelItem): ModelCost | null {
	const cost = item.model.cost;
	return cost && typeof cost === "object" ? (cost as ModelCost) : null;
}

function formatModelCostValue(value: unknown, locale: Locale): string | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value === 0)
		return null;
	const magnitude = Math.abs(value);
	if (magnitude < 0.01)
		return formatCurrency(value, "USD", {
			locale,
			minimumFractionDigits: 4,
			maximumFractionDigits: 4,
		});
	if (magnitude < 1)
		return formatCurrency(value, "USD", {
			locale,
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		});
	// Whole-dollar values drop fractional digits; otherwise keep 2 decimals.
	if (value === Math.floor(value))
		return formatCurrency(value, "USD", {
			locale,
			minimumFractionDigits: 0,
			maximumFractionDigits: 0,
		});
	return formatCurrency(value, "USD", {
		locale,
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function formatModelCost(item: ModelItem, locale: Locale): string {
	const cost = getModelCost(item);
	if (!cost) return "";

	const parts = [
		[cost.input, m.model_cost_input({}, { locale })],
		[cost.output, m.model_cost_output({}, { locale })],
		[cost.cacheRead, m.model_cost_cache_read({}, { locale })],
		[cost.cacheWrite, m.model_cost_cache_write({}, { locale })],
	].flatMap(([value, label]) => {
		const formatted = formatModelCostValue(value, locale);
		return formatted ? [`${formatted}/M ${label}`] : [];
	});

	return parts.join(" · ");
}

function getGenerationPricing(
	model: PublicGenerationDeclaration,
): GenerationModelPricing | null {
	const pricing = model.pricing;
	return pricing && typeof pricing === "object" ? pricing : null;
}

function formatGenerationPrice(
	model: PublicGenerationDeclaration,
	locale: Locale,
): string {
	const pricing = getGenerationPricing(model);
	if (!pricing) return "";

	const unit = {
		image: m.model_price_unit_image({}, { locale }),
		second: m.model_price_unit_second({}, { locale }),
		request: m.model_price_unit_request({}, { locale }),
		"1m_tokens": m.model_price_unit_1m_tokens({}, { locale }),
	}[pricing.unit];

	const format = (value: number | undefined) =>
		value === undefined ? null : formatModelCostValue(value, locale);

	const amount = format(pricing.amount);
	let text = amount ? `${amount} / ${unit}` : "";
	if (!text) {
		const min = format(pricing.min);
		const max = format(pricing.max);
		if (min && max) text = `${min}\u2013${max} / ${unit}`;
		else if (min ?? max)
			text = `${m.model_price_from({}, { locale })} ${min ?? max} / ${unit}`;
	}
	if (!text) return "";
	return pricing.note ? `${text} \u00b7 ${pricing.note}` : text;
}

function getGenerationModelTitle(model: PublicGenerationDeclaration): string {
	return model.title?.trim() || model.model;
}

function getGenerationKind(model: PublicGenerationDeclaration): string {
	const inputTypes = new Set(model.content.input.map((item) => item.type));
	if (inputTypes.has("video")) return m.model_kind_video({}, { locale });
	if (inputTypes.has("image")) return m.model_kind_image({}, { locale });
	return m.model_kind_multimodal({}, { locale });
}

function isEnumParameterSpec(spec: unknown): spec is { enum: unknown[] } {
	return (
		!!spec &&
		typeof spec === "object" &&
		"enum" in spec &&
		Array.isArray(spec.enum) &&
		spec.enum.length > 0
	);
}

function isNumberParameterSpec(spec: unknown): spec is {
	type?: unknown;
	min?: unknown;
	max?: unknown;
} {
	if (!spec || typeof spec !== "object" || isEnumParameterSpec(spec))
		return false;
	const type = "type" in spec ? spec.type : undefined;
	return type === "integer" || type === "number";
}

function isBooleanParameterSpec(spec: unknown): spec is { type?: unknown } {
	if (!spec || typeof spec !== "object" || isEnumParameterSpec(spec))
		return false;
	const type = "type" in spec ? spec.type : undefined;
	return type === "boolean";
}

function getNumberParameterBounds(spec: { min?: unknown; max?: unknown }) {
	const min =
		typeof spec.min === "number" && Number.isFinite(spec.min)
			? spec.min
			: undefined;
	const max =
		typeof spec.max === "number" && Number.isFinite(spec.max)
			? spec.max
			: undefined;
	return { min, max };
}

function getEnumParameters(
	model: PublicGenerationDeclaration,
): Array<{ name: string; values: Array<string | number | boolean> }> {
	return Object.entries(model.parameters ?? {}).flatMap(([name, spec]) => {
		if (!isEnumParameterSpec(spec)) return [];
		const values = spec.enum.filter(
			(value): value is string | number | boolean =>
				typeof value === "string" ||
				typeof value === "number" ||
				typeof value === "boolean",
		);
		return values.length > 0 ? [{ name, values }] : [];
	});
}

function getNumericParameters(model: PublicGenerationDeclaration): Array<{
	name: string;
	kind: "integer" | "number";
	min?: number;
	max?: number;
}> {
	return Object.entries(model.parameters ?? {}).flatMap(([name, spec]) => {
		if (!isNumberParameterSpec(spec)) return [];
		return [
			{
				name,
				kind: spec.type === "integer" ? "integer" : "number",
				...getNumberParameterBounds(spec),
			},
		];
	});
}

function getBooleanParameters(
	model: PublicGenerationDeclaration,
): Array<{ name: string }> {
	return Object.entries(model.parameters ?? {}).flatMap(([name, spec]) =>
		isBooleanParameterSpec(spec) ? [{ name }] : [],
	);
}

function getNumericConstraint(model: string, parameter: string) {
	return generationNumericConstraints[model]?.[parameter] ?? {};
}

function getBooleanConstraint(model: string, parameter: string) {
	return generationBooleanConstraints[model]?.[parameter] ?? {};
}

function getParameterRows(
	model: PublicGenerationDeclaration,
): Array<{ name: string; detail: string }> {
	return Object.entries(model.parameters ?? {}).flatMap(([name, spec]) => {
		if (
			isEnumParameterSpec(spec) ||
			isNumberParameterSpec(spec) ||
			isBooleanParameterSpec(spec)
		) {
			return [];
		}
		return [{ name, detail: m.model_value_auto_detail({}, { locale }) }];
	});
}

function getEnumParameterDetail(
	model: PublicGenerationDeclaration,
	parameter: string,
	values: Array<string | number | boolean>,
): string {
	const selectedCount = getSelectedEnumValues(
		model.model,
		parameter,
		values,
	).size;
	return selectedCount >= values.length
		? m.model_value_all_values({}, { locale })
		: m.model_value_n_values(
				{ count: selectedCount, total: values.length },
				{ locale },
			);
}

function getSelectedEnumValues(
	model: string,
	parameter: string,
	values: unknown[],
): Set<string> {
	return (
		generationEnumSelections[model]?.[parameter] ?? new Set(values.map(String))
	);
}

function isGenerationModelExpanded(model: string): boolean {
	return expandedGenerationModels.has(model);
}

function toggleGenerationModelExpanded(model: string) {
	const next = new Set(expandedGenerationModels);
	if (next.has(model)) next.delete(model);
	else next.add(model);
	expandedGenerationModels = next;
}

function getGenerationParameterKey(model: string, parameter: string): string {
	return `${model}\u0000${parameter}`;
}

function isGenerationParameterExpanded(
	model: string,
	parameter: string,
): boolean {
	return expandedGenerationParameters.has(
		getGenerationParameterKey(model, parameter),
	);
}

function toggleGenerationParameterExpanded(model: string, parameter: string) {
	const key = getGenerationParameterKey(model, parameter);
	const next = new Set(expandedGenerationParameters);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	expandedGenerationParameters = next;
}

function formatNumericConstraintDetail(
	model: string,
	parameter: string,
	bounds: { min?: number; max?: number },
) {
	const constraint = getNumericConstraint(model, parameter);
	const min = constraint.min ?? bounds.min;
	const max = constraint.max ?? bounds.max;
	if (min === undefined && max === undefined)
		return m.model_value_any_value({}, { locale });
	if (min !== undefined && max !== undefined)
		return m.model_value_range({ min, max }, { locale });
	return min !== undefined
		? m.model_value_ge({ min }, { locale })
		: m.model_value_le({ max: max as number }, { locale });
}

function formatBooleanConstraintDetail(model: string, parameter: string) {
	const value = getBooleanConstraint(model, parameter).value;
	if (value === true) return m.model_value_true_only({}, { locale });
	if (value === false) return m.model_value_false_only({}, { locale });
	return m.model_value_any_value({}, { locale });
}

function updateNumericConstraint(
	model: string,
	parameter: string,
	constraint: NumericGenerationConstraint,
) {
	onGenerationNumericConstraintChange?.(model, parameter, constraint);
}

function updateBooleanConstraint(
	model: string,
	parameter: string,
	constraint: BooleanGenerationConstraint,
) {
	onGenerationBooleanConstraintChange?.(model, parameter, constraint);
}

function toggleGenerationEnumValue(
	modelId: string,
	parameter: string,
	value: string,
	selected: boolean,
) {
	if (!selected) {
		const model = generationModels.find((item) => item.model === modelId);
		const enumParam = model
			? getEnumParameters(model).find((item) => item.name === parameter)
			: null;
		const selectedValues = enumParam
			? getSelectedEnumValues(modelId, parameter, enumParam.values)
			: null;
		if (selectedValues?.size === 1 && selectedValues.has(value)) return;
	}
	onGenerationEnumValueToggle?.(modelId, parameter, value, selected);
}

function setGenerationMode(mode: "auto" | "limited") {
	onGenerationPolicyModeChange?.(mode);
}

function toggleGenerationModel(model: string, selected: boolean) {
	if (generationPolicyMode !== "limited") {
		setGenerationMode("limited");
	}
	onGenerationModelToggle?.(model, selected);
}

const filteredModels = $derived.by(() => {
	const queryRaw = searchQuery.trim();
	const isCurrent = (item: ModelItem) =>
		currentModel !== null &&
		item.provider === currentModel.provider &&
		item.id === currentModel.id;
	// Hidden models stay discoverable through an exact id query or while selected.
	const revealedHidden = models.filter(
		(item) => isHiddenModel(item) && (isCurrent(item) || item.id === queryRaw),
	);
	let result =
		revealedHidden.length > 0
			? [...models.filter((item) => !isHiddenModel(item)), ...revealedHidden]
			: models.filter((item) => !isHiddenModel(item));

	if (queryRaw) {
		const query = queryRaw.toLowerCase().replace(/\s+/g, "");
		const scored = result
			.map((item) => {
				const text =
					`${item.provider} ${item.id} ${getDisplayName(item)}`.toLowerCase();
				const score = subsequenceScore(query, text);
				return score > 0 ? { item, score } : null;
			})
			.filter((s): s is { item: ModelItem; score: number } => s !== null);
		scored.sort((a, b) => b.score - a.score);
		result = scored.map((s) => s.item);
	}

	// When not searching, current model first
	if (!queryRaw && currentModel) {
		result = [...result].sort((a, b) => {
			const aIsCurrent =
				a.provider === currentModel.provider && a.id === currentModel.id;
			const bIsCurrent =
				b.provider === currentModel.provider && b.id === currentModel.id;
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider);
		});
	}

	return result;
});

const filteredGenerationModels = $derived(
	getGenerationModelPickerItems(generationModels, {
		query: generationSearchQuery,
		selectedModelIds: selectedGenerationModels,
	}),
);

$effect(() => {
	if (open) {
		searchQuery = "";
		generationSearchQuery = "";
		selectedIndex = 0;
		navigationMode = "mouse";
		closeThinkingMenu();
		// Focus search input after render — skip on mobile to avoid keyboard popup
		const isMobile =
			typeof window !== "undefined" &&
			("ontouchstart" in window ||
				window.matchMedia("(pointer: coarse)").matches ||
				navigator.maxTouchPoints > 0);
		if (!isMobile) {
			focusSearchInputSoon();
		}
	}
});

function moveSelection(delta: number) {
	if (activeTab !== "chat") return;
	if (filteredModels.length === 0) {
		selectedIndex = 0;
		return;
	}
	hideHoverCard();
	navigationMode = "keyboard";
	selectedIndex = Math.min(
		Math.max(selectedIndex + delta, 0),
		filteredModels.length - 1,
	);
	scrollSelectedIntoView();
}

function handleNavigationKeydown(e: KeyboardEvent) {
	if (!open || e.defaultPrevented || isComposingKeyboardEvent(e)) return;
	const key = e.key.toLowerCase();
	if (e.key === "Escape") {
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation?.();
		onClose();
		return;
	}
	if (e.key === "ArrowDown" || (e.ctrlKey && key === "n")) {
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		moveSelection(1);
		return;
	}
	if (e.key === "ArrowUp" || (e.ctrlKey && key === "p")) {
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		moveSelection(-1);
		return;
	}
	if (
		e.key === "Enter" &&
		activeTab === "chat" &&
		filteredModels[selectedIndex]
	) {
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		const selected = filteredModels[selectedIndex];
		onSelect({ provider: selected.provider, id: selected.id });
	}
}

function handleKeyDown(e: KeyboardEvent) {
	handleNavigationKeydown(e);
}

$effect(() => {
	if (selectedIndex >= filteredModels.length) {
		selectedIndex = Math.max(filteredModels.length - 1, 0);
	}
});

function scrollSelectedIntoView() {
	requestAnimationFrame(() => {
		const selected = containerEl?.querySelector(
			`[data-model-item]:nth-child(${selectedIndex + 1})`,
		) as HTMLElement;
		selected?.scrollIntoView({ block: "nearest" });
	});
}

function isCurrentModel(item: ModelItem): boolean {
	return (
		currentModel !== null &&
		item.provider === currentModel.provider &&
		item.id === currentModel.id
	);
}

function subsequenceScore(query: string, text: string): number {
	let qi = 0;
	let ti = 0;
	let gaps = 0;
	let lastMatchIndex = -1;

	while (qi < query.length && ti < text.length) {
		if (query[qi] === text[ti]) {
			if (lastMatchIndex >= 0) {
				gaps += ti - lastMatchIndex - 1;
			}
			lastMatchIndex = ti;
			qi++;
		}
		ti++;
	}

	if (qi < query.length) return 0;
	return query.length / (query.length + gaps);
}

const selectedGenerationCount = $derived(selectedGenerationModels.size);

// ── Availability helpers ─────────────────────────────────────────────────────

function getModelStatusEntry(modelId: string): ModelStatusEntry | null {
	return modelStatus?.[modelId] ?? null;
}

function getAvailabilityLevel(modelId: string): AvailabilityLevel {
	return availabilityLevel(getModelStatusEntry(modelId));
}

function fmtMs(ms: number | null | undefined): string {
	if (typeof ms !== "number" || !ms) return "—";
	const s = ms / 1000;
	if (s < 1) return `${Math.round(s * 1000)}ms`;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
	const m = Math.floor(s / 60);
	const rs = Math.round(s % 60);
	return `${m}m${rs}s`;
}

function fmtAgoSec(s: number): string {
	s = Math.max(0, Math.round(s));
	if (s < 60) return m.model_avail_ago_s({ n: s }, { locale });
	const minutes = Math.floor(s / 60);
	if (minutes < 60) return m.model_avail_ago_m({ n: minutes }, { locale });
	return m.model_avail_ago_h({ n: Math.floor(minutes / 60) }, { locale });
}

function fmtAgo(iso: string | null | undefined): string {
	if (!iso) return "—";
	return fmtAgoSec((Date.now() - new Date(iso).getTime()) / 1000);
}

function fmtAgoMs(ms: number): string {
	return fmtAgoSec(ms / 1000);
}

function availabilityLabel(level: AvailabilityLevel): string {
	switch (level) {
		case "available":
			return m.model_avail_operational({}, { locale });
		case "degraded":
			return m.model_avail_degraded({}, { locale });
		case "outage":
			return m.model_avail_outage({}, { locale });
		default:
			return m.model_avail_unknown({}, { locale });
	}
}

function fmtRate(rate: number | null | undefined): string {
	return typeof rate === "number" ? `${Math.round(rate)}%` : "—";
}

/**
 * Rate-based bar color, matching the router-status observed-traffic scale.
 * Used for hover-card history bars; the selector dot itself stays 3-level.
 */
function rateToBarColor(rate: number | null | undefined): string {
	if (rate == null) return "#94a3b8"; // no samples — gray
	if (rate >= 95) return "#16a34a"; // green
	if (rate >= 90) return "#84cc16"; // yellow-green
	if (rate >= 85) return "#f59e0b"; // yellow-orange
	if (rate >= 80) return "#f97316"; // orange
	if (rate >= 75) return "#c2410c"; // red-orange
	return "#dc2626"; // red
}

// ── Hover card ───────────────────────────────────────────────────────────────

function onDotMouseEnter(modelId: string, e: MouseEvent) {
	const target = e.currentTarget as HTMLElement;
	clearTimeout(hoverHideTimer ?? undefined);
	if (hoveredModelId) {
		hoveredModelId = modelId;
		hoverAnchorRect = target.getBoundingClientRect();
	} else {
		clearTimeout(hoverShowTimer ?? undefined);
		hoverShowTimer = setTimeout(() => {
			hoveredModelId = modelId;
			hoverAnchorRect = target.getBoundingClientRect();
		}, 120);
	}
}

function onDotMouseLeave() {
	clearTimeout(hoverShowTimer ?? undefined);
	hoverHideTimer = setTimeout(() => {
		hoveredModelId = null;
		hoverAnchorRect = null;
	}, 140);
}

function onCardMouseEnter() {
	clearTimeout(hoverHideTimer ?? undefined);
}

function onCardMouseLeave() {
	hoverHideTimer = setTimeout(() => {
		hoveredModelId = null;
		hoverAnchorRect = null;
	}, 140);
}

// Hide the card immediately on keyboard navigation to avoid stale anchoring.
function hideHoverCard() {
	clearTimeout(hoverShowTimer ?? undefined);
	clearTimeout(hoverHideTimer ?? undefined);
	hoveredModelId = null;
	hoverAnchorRect = null;
}

const hoveredEntry = $derived(
	hoveredModelId ? getModelStatusEntry(hoveredModelId) : null,
);
const hoveredLevel = $derived(
	hoveredModelId ? getAvailabilityLevel(hoveredModelId) : "available",
);

/** Bar-chart series (96 buckets): online traffic first, probe history fallback. */
const hoveredHeartbeats = $derived(hoveredEntry?.heartbeats8h ?? []);
/** Total minutes the bar series spans (reported online window / history fallback 1440). */
const hoveredHeartbeatWindowMin = $derived(
	hoveredEntry?.heartbeatsWindowMinutes ?? 480,
);
const hoveredHeartbeatHours = $derived(
	Math.round(hoveredHeartbeatWindowMin / 60),
);
const hoveredHeartbeatPerBucketMin = $derived(
	hoveredHeartbeats.length
		? hoveredHeartbeatWindowMin / hoveredHeartbeats.length
		: 5,
);

// Card width is fixed at 288px (see .model-avail-card). Estimate height for
// flip-above calculation; we don't depend on hoverCardEl here to avoid a
// render cycle: card renders only when hoverCardPos is non-null, but
// hoverCardEl is only bound once the card renders.
const HOVER_CARD_WIDTH = 288;
const HOVER_CARD_EST_HEIGHT = 240;

const hoverCardPos = $derived.by(() => {
	if (!hoverAnchorRect) return null;
	const cw = HOVER_CARD_WIDTH;
	const ch = hoverCardEl?.offsetHeight ?? HOVER_CARD_EST_HEIGHT;
	let left = hoverAnchorRect.left + hoverAnchorRect.width / 2 - cw / 2;
	let top = hoverAnchorRect.bottom + 8;
	if (top + ch > window.innerHeight - 8) top = hoverAnchorRect.top - ch - 8;
	left = Math.max(8, Math.min(left, window.innerWidth - cw - 8));
	return { left, top };
});
</script>

{#snippet availabilityDot(modelId: string)}
	{#if modelStatus}
		<span
			class="avail-dot-target"
			onmouseenter={(e) => onDotMouseEnter(modelId, e)}
			onmouseleave={onDotMouseLeave}
			role="presentation"
		>
			<span class={`avail-dot avail-dot--${getAvailabilityLevel(modelId)}`}></span>
		</span>
	{/if}
{/snippet}

<Dialog {open} {onClose} title={title ?? m.model_selector_title({}, { locale })} maxWidth="540px">
	{#if showGeneration}
	<div class="border-b border-border-subtle/70 px-3 py-2">
		<div class="inline-flex rounded-md bg-bg-subtle/70 p-0.5 text-[12px]">
			<button
				type="button"
				class={`rounded px-3 py-1.5 font-medium transition-colors duration-100 ${activeTab === "chat" ? "bg-bg-surface text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-primary"}`}
				onclick={() => {
					activeTab = "chat";
					focusSearchInputSoon();
				}}
			>
				{m.model_selector_tab_chat({}, { locale })}
			</button>
			<button
				type="button"
				class={`rounded px-3 py-1.5 font-medium transition-colors duration-100 ${activeTab === "generation" ? "bg-bg-surface text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-primary"}`}
				onclick={() => {
					activeTab = "generation";
					onGenerationTabOpen?.();
				}}
			>
				{m.model_selector_tab_generation({}, { locale })}
			</button>
		</div>
	</div>

	{/if}
	{#if activeTab === "chat" || !showGeneration}
		{#if onSelectDefault}
			<button type="button" class="flex min-h-11 w-full items-center justify-between gap-3 border-b border-border-subtle px-4 py-2 text-left text-[13px] text-text-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-brand" onclick={onSelectDefault} aria-pressed={!currentModel}>
				<span>{defaultLabel ?? m.runtime_default_model({}, { locale })}</span>
				{#if !currentModel}<Check class="h-4 w-4 shrink-0 text-brand" />{/if}
			</button>
		{/if}
		<div class="border-b border-border-subtle/70 px-3 py-2">
			<input
				bind:this={searchInputEl}
				data-model-selector-search="true"
				type="text"
				placeholder={m.model_selector_search_placeholder({}, { locale })}
				bind:value={searchQuery}
				onkeydown={handleKeyDown}
				class="w-full rounded-md border-0 bg-bg-input px-3 py-2 text-[13px] text-text-primary outline-none ring-1 ring-border-subtle placeholder:text-text-placeholder transition-shadow duration-100 focus:ring-brand/45"
			/>
		</div>

		<div bind:this={containerEl} class="flex-1 overflow-y-auto py-1">
			{#if filteredModels.length === 0}
				<div class="px-4 py-8 text-center text-[13px] text-text-tertiary">
					{searchQuery
						? m.model_selector_no_matching({}, { locale })
						: m.model_selector_no_models({}, { locale })}
				</div>
			{:else}
				{#each filteredModels as item, index (item.provider + "/" + item.id)}
					{@const costText = formatModelCost(item, locale)}
					{@const tLevels = thinkingLevels(item)}
					{@const showThinking = tLevels.length > 1}
					{@const tMenuKey = thinkingMenuKey(item)}
					{@const activeLevel = candidateThinkingLevel(item)}
					{@const thinkingOpen = thinkingMenuOpenFor === tMenuKey}
					<div
						role="presentation"
						class={`group relative px-4 py-2 transition-colors duration-100 ${
							navigationMode === "mouse" ? "hover:bg-bg-hover" : ""
						} ${index === selectedIndex ? "bg-bg-hover" : ""}`}
						data-model-item
						onmouseenter={() => {
							if (navigationMode === "mouse") {
								selectedIndex = index;
							}
						}}
						data-selected={index === selectedIndex}
					>
						{#if isCurrentModel(item)}
							<span class="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-brand"></span>
						{/if}
						<div class="flex items-start justify-between gap-3">
							<button
								type="button"
								class="min-w-0 flex-1 cursor-pointer text-left"
								aria-pressed={isCurrentModel(item)}
								onclick={() => handleModelClick(item)}
							>
								<div class="flex min-w-0 items-center gap-1.5">
									<span class="truncate text-[13px] font-medium text-text-primary">
										{getDisplayName(item)}
									</span>
									{#if hasVision(item)}
										<Image class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
									{/if}
									{#if item.provider === STATUS_PROVIDER}
										{@render availabilityDot(item.id)}
									{/if}
								</div>
								{#if costText}
									<div class="mt-0.5 truncate text-[11px] tabular-nums text-text-tertiary/75">
										{costText}
									</div>
								{/if}
							</button>

							<div class="flex shrink-0 flex-col items-end">
								<span class="max-w-[7.5rem] truncate text-right text-[11px] leading-4 text-text-tertiary/70">
									{item.provider}
								</span>
								{#if showThinking}
									<div class="relative self-end">
										<button
											type="button"
											class={`inline-flex h-5 items-center justify-end gap-1 rounded border px-1 text-[10px] leading-none transition-colors ${
												thinkingOpen
													? "border-border-subtle bg-bg-surface text-text-secondary"
													: "border-transparent text-text-tertiary hover:border-border-subtle/80 hover:bg-bg-surface hover:text-text-secondary"
											}`}
											title={m.model_selector_thinking_title({ level: formatThinkingLevelFull(activeLevel) }, { locale })}
											aria-label={m.model_selector_thinking_aria({ level: formatThinkingLevelFull(activeLevel) }, { locale })}
											aria-expanded={thinkingOpen}
											aria-haspopup="listbox"
											onclick={(e) => toggleThinkingMenu(item, e)}
										>
											<Brain class="h-3 w-3 opacity-70" />
											<span class="tabular-nums">{formatThinkingLevelShort(activeLevel)}</span>
											<ChevronDown class={`h-2.5 w-2.5 opacity-50 transition-transform ${thinkingOpen ? "rotate-180" : ""}`} />
										</button>
										{#if thinkingOpen && thinkingMenuPos}
											<button
												type="button"
												class="fixed inset-0 z-[120] cursor-default"
												aria-hidden="true"
												tabindex="-1"
												onclick={(e) => {
													e.stopPropagation();
													closeThinkingMenu();
												}}
											></button>
											<div
												class="fixed z-[121] min-w-[8.5rem] overflow-hidden rounded-md border border-border-subtle bg-bg-surface py-0.5 shadow-lg"
												style={`top: ${thinkingMenuPos.top}px; right: ${thinkingMenuPos.right}px;`}
												role="listbox"
												aria-label={m.model_selector_thinking_menu_aria({}, { locale })}
												use:thinkingMenuAnchor
											>
												{#each tLevels as level (level)}
													{@const selected = level === activeLevel}
													<button
														type="button"
														role="option"
														aria-selected={selected}
														class={`flex w-full min-h-[36px] items-center gap-2 px-2.5 text-left text-[12px] transition-colors ${
															selected
																? "bg-bg-hover text-text-primary"
																: "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
														}`}
														onclick={(e) => {
															e.stopPropagation();
															selectThinkingLevel(item, level);
														}}
													>
														<span class="w-3.5 shrink-0">
															{#if selected}
																<Check class="h-3.5 w-3.5 text-brand" />
															{/if}
														</span>
														<span class="min-w-0 flex-1">{formatThinkingLevelFull(level)}</span>
														{#if isDefaultLevel(item, level)}
															<span class="shrink-0 text-[9px] uppercase tracking-wide text-text-placeholder">{m.model_selector_thinking_default({}, { locale })}</span>
														{/if}
													</button>
												{/each}
											</div>
										{/if}
									</div>
								{/if}
							</div>
						</div>
					</div>
				{/each}
			{/if}
		</div>
	{:else}
		<div class="flex-1 overflow-y-auto px-3 py-3">
			<div class="grid grid-cols-2 gap-1 rounded-md bg-bg-subtle/60 p-1">
				<button
					type="button"
					class={`flex items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left transition-colors duration-100 ${generationPolicyMode === "auto" ? "bg-bg-surface text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-primary"}`}
					onclick={() => setGenerationMode("auto")}
				>
					<span class="text-[13px] font-medium">{m.model_selector_generation_auto({}, { locale })}</span>
					{#if generationPolicyMode === "auto"}<span class="h-1.5 w-1.5 rounded-full bg-brand"></span>{/if}
				</button>

				<button
					type="button"
					class={`flex items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left transition-colors duration-100 ${generationPolicyMode === "limited" ? "bg-bg-surface text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-primary"}`}
					onclick={() => setGenerationMode("limited")}
				>
					<span class="text-[13px] font-medium">{m.model_selector_generation_limited({}, { locale })}</span>
					<span class={`text-[11px] ${generationPolicyMode === "limited" ? "text-brand-muted-fg" : "text-text-tertiary"}`}>{selectedGenerationCount}</span>
				</button>
			</div>

			<div class="mt-3">
				<input
					type="text"
					placeholder={m.model_selector_generation_search({}, { locale })}
					aria-label={m.model_selector_generation_search({}, { locale })}
					bind:value={generationSearchQuery}
					class="w-full rounded-md border-0 bg-bg-input px-3 py-2 text-[13px] text-text-primary outline-none ring-1 ring-border-subtle placeholder:text-text-placeholder transition-shadow duration-100 focus:ring-brand/45"
				/>
			</div>

			<div class="mt-3 px-1 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
				{m.model_selector_generation_header({}, { locale })}
			</div>

			{#if filteredGenerationModels.length === 0}
				<div class="mt-2 px-3 py-6 text-center text-[13px] text-text-tertiary">
					{generationSearchQuery
						? m.model_selector_generation_no_matching({}, { locale })
						: m.model_selector_generation_no_models({}, { locale })}
				</div>
			{:else}
				<div class="mt-1.5 -mx-3">
					{#each filteredGenerationModels as model (model.model)}
						{@const priceText = formatGenerationPrice(model, locale)}
						<div class="px-3 py-2 transition-colors duration-100 hover:bg-bg-hover/60">
							<div class="flex items-start gap-2.5">
								<input
									type="checkbox"
									aria-label={m.model_selector_generation_use_aria({ model: getGenerationModelTitle(model) }, { locale })}
									class="mt-1 h-3.5 w-3.5 accent-brand"
									checked={selectedGenerationModels.has(model.model)}
									onchange={(event) => toggleGenerationModel(model.model, event.currentTarget.checked)}
								/>
								<div class="min-w-0 flex-1">
									<div class="flex items-start justify-between gap-2">
										<button
											type="button"
											class="min-w-0 flex-1 text-left"
											onclick={() => toggleGenerationModelExpanded(model.model)}
											aria-expanded={isGenerationModelExpanded(model.model)}
										>
											<div class="flex items-center gap-1.5">
												<ChevronDown class={`h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform duration-100 ${isGenerationModelExpanded(model.model) ? "rotate-0" : "-rotate-90"}`} />
												<span class="truncate text-[13px] font-medium text-text-primary">{getGenerationModelTitle(model)}</span>
												<span class="text-[10px] text-text-tertiary/80">{getGenerationKind(model)}</span>
												{@render availabilityDot(model.model)}
											</div>
											<div class="mt-0.5 flex min-w-0 items-center gap-1.5 pl-5 text-[11px] text-text-tertiary">
												<span class="truncate">{model.model}</span>
												{#if priceText}
													<span class="shrink-0 tabular-nums text-text-tertiary/75">· {priceText}</span>
												{/if}
											</div>
										</button>
										{#if generationPolicyMode === "limited" && selectedGenerationModels.has(model.model)}
											<span class="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-label={m.model_selector_selected({}, { locale })}></span>
										{/if}
									</div>

									{#if isGenerationModelExpanded(model.model)}
										<div class="mt-2 space-y-1 pl-5 text-[11px]">
											{#each getParameterRows(model) as param (param.name)}
												<div class="flex items-center justify-between gap-3 rounded-[5px] px-2 py-1 text-text-secondary">
													<span class="truncate">{param.name}</span>
													<span class="shrink-0 text-text-tertiary">{param.detail}</span>
												</div>
											{/each}

											{#each getBooleanParameters(model) as param (param.name)}
												<div class="rounded-[6px] bg-bg-subtle/45">
													<button type="button" class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] text-text-secondary transition-colors duration-100 hover:text-text-primary" onclick={() => toggleGenerationParameterExpanded(model.model, param.name)} aria-expanded={isGenerationParameterExpanded(model.model, param.name)}>
														<ChevronDown class={`h-3 w-3 shrink-0 text-text-tertiary transition-transform duration-100 ${isGenerationParameterExpanded(model.model, param.name) ? "rotate-0" : "-rotate-90"}`} />
														<span class="min-w-0 flex-1 truncate">{param.name}</span>
														<span class="shrink-0 text-text-tertiary">{formatBooleanConstraintDetail(model.model, param.name)}</span>
													</button>
													{#if isGenerationParameterExpanded(model.model, param.name)}
														<div class="grid grid-cols-3 gap-1 px-2 pb-2 pt-0.5">
															{#each [
									{ label: m.model_value_any({}, { locale }), value: undefined },
									{ label: m.model_value_true({}, { locale }), value: true },
									{ label: m.model_value_false({}, { locale }), value: false },
								] as option (option.label)}
																<button type="button" class={`min-h-7 rounded px-2 text-[11px] transition-colors duration-100 ${getBooleanConstraint(model.model, param.name).value === option.value ? "bg-brand-bg text-brand-muted-fg" : "bg-bg-surface text-text-tertiary hover:text-text-primary"}`} disabled={generationPolicyMode !== "limited" || !selectedGenerationModels.has(model.model)} onclick={() => updateBooleanConstraint(model.model, param.name, { value: option.value })}>{option.label}</button>
															{/each}
														</div>
													{/if}
												</div>
											{/each}

											{#each getNumericParameters(model) as param (param.name)}
												{@const constraint = getNumericConstraint(model.model, param.name)}
												<div class="rounded-[6px] bg-bg-subtle/45">
													<button type="button" class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] text-text-secondary transition-colors duration-100 hover:text-text-primary" onclick={() => toggleGenerationParameterExpanded(model.model, param.name)} aria-expanded={isGenerationParameterExpanded(model.model, param.name)}>
														<ChevronDown class={`h-3 w-3 shrink-0 text-text-tertiary transition-transform duration-100 ${isGenerationParameterExpanded(model.model, param.name) ? "rotate-0" : "-rotate-90"}`} />
														<span class="min-w-0 flex-1 truncate">{param.name}</span>
														<span class="shrink-0 text-text-tertiary">{formatNumericConstraintDetail(model.model, param.name, { min: param.min, max: param.max })}</span>
													</button>
													{#if isGenerationParameterExpanded(model.model, param.name)}
														<div class="grid grid-cols-2 gap-2 px-2 pb-2 pt-0.5">
															<label class="min-w-0 text-[10px] text-text-tertiary"><span>{m.model_value_min({}, { locale })}</span><input type="number" step={param.kind === "integer" ? "1" : "any"} placeholder={param.min === undefined ? m.model_value_any({}, { locale }) : String(param.min)} value={constraint.min ?? ""} disabled={generationPolicyMode !== "limited" || !selectedGenerationModels.has(model.model)} class="mt-1 min-h-7 w-full rounded border border-border-subtle bg-bg-input px-2 text-[11px] text-text-primary outline-none focus:border-brand/45 disabled:opacity-50" oninput={(event) => updateNumericConstraint(model.model, param.name, { ...constraint, min: event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value) })} /></label>
															<label class="min-w-0 text-[10px] text-text-tertiary"><span>{m.model_value_max({}, { locale })}</span><input type="number" step={param.kind === "integer" ? "1" : "any"} placeholder={param.max === undefined ? m.model_value_any({}, { locale }) : String(param.max)} value={constraint.max ?? ""} disabled={generationPolicyMode !== "limited" || !selectedGenerationModels.has(model.model)} class="mt-1 min-h-7 w-full rounded border border-border-subtle bg-bg-input px-2 text-[11px] text-text-primary outline-none focus:border-brand/45 disabled:opacity-50" oninput={(event) => updateNumericConstraint(model.model, param.name, { ...constraint, max: event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value) })} /></label>
														</div>
													{/if}
												</div>
											{/each}

											{#each getEnumParameters(model) as param (param.name)}
												<div class="rounded-[6px] bg-bg-subtle/45">
													<button type="button" class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-[11px] text-text-secondary transition-colors duration-100 hover:text-text-primary" onclick={() => toggleGenerationParameterExpanded(model.model, param.name)} aria-expanded={isGenerationParameterExpanded(model.model, param.name)}>
														<ChevronDown class={`h-3 w-3 shrink-0 text-text-tertiary transition-transform duration-100 ${isGenerationParameterExpanded(model.model, param.name) ? "rotate-0" : "-rotate-90"}`} />
														<span class="min-w-0 flex-1 truncate">{param.name}</span>
														<span class="shrink-0 text-text-tertiary">{getEnumParameterDetail(model, param.name, param.values)}</span>
													</button>
													{#if isGenerationParameterExpanded(model.model, param.name)}
														<div class="flex flex-wrap gap-1 px-2 pb-2 pt-0.5">
															{#each param.values as value (String(value))}
																<label class={`inline-flex min-h-7 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors duration-100 ${selectedGenerationModels.has(model.model) && getSelectedEnumValues(model.model, param.name, param.values).has(String(value)) ? "bg-brand-bg text-brand-muted-fg" : "bg-bg-surface text-text-tertiary hover:text-text-primary"}`}><input type="checkbox" class="h-3 w-3 accent-brand disabled:opacity-35" disabled={generationPolicyMode !== "limited" || !selectedGenerationModels.has(model.model) || (getSelectedEnumValues(model.model, param.name, param.values).size === 1 && getSelectedEnumValues(model.model, param.name, param.values).has(String(value)))} checked={getSelectedEnumValues(model.model, param.name, param.values).has(String(value))} onchange={(event) => toggleGenerationEnumValue(model.model, param.name, String(value), event.currentTarget.checked)} /><span>{String(value)}</span></label>
															{/each}
														</div>
													{/if}
												</div>
											{/each}
										</div>
									{/if}
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
</Dialog>

{#if hoveredModelId && hoverCardPos}
	<div
		bind:this={hoverCardEl}
		class="model-avail-card"
		style={`left:${hoverCardPos.left}px;top:${hoverCardPos.top}px`}
		onmouseenter={onCardMouseEnter}
		onmouseleave={onCardMouseLeave}
		role="tooltip"
	>
		<div class="flex items-center justify-between gap-2">
			<span class="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
				<span class={`avail-dot avail-dot--${hoveredLevel}`}></span>
				{availabilityLabel(hoveredLevel)}
			</span>
			<span class="text-[16px] font-semibold tabular-nums leading-none {`avail-rate--${hoveredLevel}`}">
				{hoveredEntry?.successRate5m != null ? fmtRate(hoveredEntry.successRate5m) : "—"}{#if hoveredEntry?.successRate5m != null}<span class="text-[10px] font-medium text-text-tertiary">{m.model_avail_rate_5m({}, { locale })}</span>{/if}
			</span>
		</div>
		<div class="mt-0.5 font-mono text-[10px] text-text-tertiary">{hoveredModelId}</div>
		<div class="my-2 h-px bg-border-subtle"></div>
		{#if hoveredEntry}
			<div class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{m.model_avail_past_hours({ hours: hoveredHeartbeatHours }, { locale })}</div>
			{#if hoveredHeartbeats.length}
				<div class="flex items-stretch gap-px h-[26px]">
					{#each hoveredHeartbeats as rate, i}
						<i
							class="avail-bar"
							style={`background:${rateToBarColor(rate)}`}
							title={`${fmtAgoMs((hoveredHeartbeats.length - 1 - i) * hoveredHeartbeatPerBucketMin * 60 * 1000)} · ${fmtRate(rate)}`}
						></i>
					{/each}
				</div>
				<div class="mt-1 flex justify-between text-[9px] text-text-tertiary">
					<span>{m.model_avail_hours_ago({ hours: hoveredHeartbeatHours }, { locale })}</span><span>{m.model_avail_now({}, { locale })}</span>
				</div>
			{:else}
				<div class="text-[11px] text-text-tertiary">{m.model_avail_no_history({}, { locale })}</div>
			{/if}
			<div class="mt-1.5 flex gap-3 text-[11px] tabular-nums">
				{#if hoveredEntry.successRate2h != null}
					<span><b class="font-semibold text-text-secondary">{fmtRate(hoveredEntry.successRate2h)}</b> <small class="text-text-tertiary">2h</small></span>
				{/if}
				{#if hoveredEntry.successRate24h != null}
					<span><b class="font-semibold text-text-secondary">{fmtRate(hoveredEntry.successRate24h)}</b> <small class="text-text-tertiary">24h</small></span>
				{/if}
			</div>
			<div class="my-2 h-px bg-border-subtle"></div>
			<dl class="grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5">
				<dt class="text-[11px] text-text-tertiary">{m.model_avail_latency({}, { locale })}</dt>
				<dd class="text-right text-[11px] tabular-nums text-text-secondary">
					{hoveredEntry.latencyAvgMs != null
							? m.model_avail_latency_value(
									{
										avg: fmtMs(hoveredEntry.latencyAvgMs),
										p90: fmtMs(hoveredEntry.latencyP90Ms),
									},
									{ locale },
							  )
							: "—"}
				</dd>
				<dt class="text-[11px] text-text-tertiary">{m.model_avail_checked({}, { locale })}</dt>
				<dd class="text-right text-[11px] text-text-secondary">
					{hoveredEntry.checkedAt ? `${fmtAgo(hoveredEntry.checkedAt)}${hoveredEntry.probeIntervalSeconds ? `${m.model_avail_every_seconds({ s: hoveredEntry.probeIntervalSeconds }, { locale })}` : ''}` : '—'}
				</dd>
			</dl>
		{:else}
			<div class="py-1 text-[11px] text-text-tertiary">{m.model_avail_no_status({}, { locale })}</div>
		{/if}
	</div>
{/if}

<style>
	.avail-dot-target {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 18px;
		width: 18px;
		height: 18px;
		margin: -6px;
		cursor: help;
	}
	.avail-dot-target .avail-dot {
		margin-left: 0;
	}
	.avail-dot {
		display: inline-block;
		flex: 0 0 auto;
		width: 6px;
		height: 6px;
		border-radius: 999px;
		background: var(--neutral-40);
		margin-left: 2px;
		cursor: help;
	}
	.avail-dot--available {
		background: var(--success-500);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--success-500) 14%, transparent);
	}
	.avail-dot--degraded {
		background: var(--warning-500);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning-500) 16%, transparent);
		animation: avail-pulse 1.8s ease-in-out infinite;
	}
	.avail-dot--outage {
		background: var(--error-500);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--error-500) 14%, transparent);
	}
	.avail-dot--unknown {
		background: var(--neutral-40);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--neutral-40) 20%, transparent);
	}
	@keyframes avail-pulse {
		0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--warning-500) 16%, transparent); }
		50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--warning-500) 8%, transparent); }
	}
	@media (prefers-reduced-motion: reduce) {
		.avail-dot--degraded { animation: none; }
	}

	.model-avail-card {
		position: fixed;
		z-index: 300;
		width: 288px;
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-surface);
		box-shadow: 0 12px 32px -8px oklch(0% 0 0 / 0.55);
		padding: 10px 12px;
		font-size: 12px;
		color: var(--text-secondary);
		transition: opacity 0.12s ease, transform 0.12s ease;
	}
	.avail-rate--available { color: var(--success-500); }
	.avail-rate--degraded { color: var(--warning-500); }
	.avail-rate--outage { color: var(--error-500); }
	.avail-rate--unknown { color: var(--text-tertiary); }

	.avail-bar {
		flex: 1 1 0;
		min-width: 1px;
		border-radius: 1px 1px 0 0;
		background: var(--neutral-60);
		opacity: 0.85;
	}
</style>
