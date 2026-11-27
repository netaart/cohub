import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import type { ModelStatusEntry } from "@cohub/protocol/model/status";
import {
	APPROVAL_MODES,
	type ApprovalMode,
	type HarnessKind,
	type LocalHarness,
} from "@cohub/protocol/runtime";
import type { RuntimeCapabilities } from "@neta-art/cohub";
import type {
	LocalModelSelection,
	ModelCatalogItem,
	ModelThinkingLevel,
} from "#lib/model-catalog.ts";

type NumericConstraint = { min?: number; max?: number };
type BooleanConstraint = { value?: boolean };

/** Props the shared model list reads; local and Cloud catalogs both fill them. */
export type ModelListProps = {
	models: ModelCatalogItem[];
	currentModel?: { provider: string; id: string } | null;
	thinkingLevelModel?: { provider: string; id: string } | null;
	currentThinkingLevel?: ModelThinkingLevel | null;
	currentServiceTier?: string | null;
	modelStatus?: Record<string, ModelStatusEntry> | null;
	showGeneration?: boolean;
	generationModels?: PublicGenerationDeclaration[];
	generationPolicyMode?: "auto" | "limited";
	selectedGenerationModels?: Set<string>;
	generationEnumSelections?: Record<string, Record<string, Set<string>>>;
	generationNumericConstraints?: Record<
		string,
		Record<string, NumericConstraint>
	>;
	generationBooleanConstraints?: Record<
		string,
		Record<string, BooleanConstraint>
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
		constraint: NumericConstraint,
	) => void;
	onGenerationBooleanConstraintChange?: (
		model: string,
		parameter: string,
		constraint: BooleanConstraint,
	) => void;
	onGenerationTabOpen?: () => void;
	emptyText?: string;
	emptyAction?: { label: string; onclick: () => void };
};

/** The Cloud catalog and the facts its chip shows. */
export type CloudModels = {
	list: ModelListProps;
	onOpen?: () => void;
	label: string;
	ariaLabel?: string;
	meta: Array<string | { text: string; brand?: boolean }>;
};

export type ComposerRuntime = {
	readonly harness: HarnessKind;
	readonly model: LocalModelSelection | null;
	readonly approvalMode: ApprovalMode | null;
	readonly local: boolean;
	readonly online: boolean;
	readonly harnesses: readonly LocalHarness[];
	readonly models: RuntimeCapabilities["models"];
	modelFor(harness: LocalHarness): LocalModelSelection | null;
	approvalFor(harness: LocalHarness): {
		modes: readonly ApprovalMode[];
		mode: ApprovalMode | null;
	};
	refresh(harness: LocalHarness): void;
	select(harness: HarnessKind, model?: LocalModelSelection): void;
	setApproval(harness: LocalHarness, mode: ApprovalMode): void;
};

/** Every mode is listed; one the Runtime does not enforce stays disabled, except `inherit`. */
export const approvalMenuOptions = (
	offered: readonly ApprovalMode[],
	selected: ApprovalMode,
) =>
	APPROVAL_MODES.map((mode) => ({
		mode,
		checked: mode === selected,
		disabled: mode !== "inherit" && !offered.includes(mode),
	}));
