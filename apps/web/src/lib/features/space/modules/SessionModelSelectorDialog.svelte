<script lang="ts">
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import type { ModelStatusEntry } from "@cohub/protocol/model/status";
import ModelSelector from "#lib/components/ModelSelector.svelte";
import type {
	ModelCatalogItem,
	ModelThinkingLevel,
} from "#lib/model-catalog.ts";

type SelectedModel = {
	provider: string;
	id: string;
	name?: string;
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
	models: ModelCatalogItem[];
	currentModel: SelectedModel | null;
	/** Model the session thinking level is bound to. Defaults to currentModel. */
	thinkingLevelModel?: SelectedModel | null;
	currentThinkingLevel?: ModelThinkingLevel | null;
	modelStatus?: Record<string, ModelStatusEntry> | null;
	generationModels: PublicGenerationDeclaration[];
	generationPolicyMode: "auto" | "limited";
	selectedGenerationModels: Set<string>;
	generationEnumSelections: Record<string, Record<string, Set<string>>>;
	generationNumericConstraints: Record<
		string,
		Record<string, NumericGenerationConstraint>
	>;
	generationBooleanConstraints: Record<
		string,
		Record<string, BooleanGenerationConstraint>
	>;
	onClose: () => void;
	onSelect: (model: {
		provider: string;
		id: string;
		thinkingLevel?: ModelThinkingLevel;
	}) => void;
	onGenerationTabOpen: () => void | Promise<void>;
	onGenerationPolicyModeChange: (mode: "auto" | "limited") => void;
	onGenerationModelToggle: (modelId: string, selected: boolean) => void;
	onGenerationEnumValueToggle: (
		modelId: string,
		parameter: string,
		value: string,
		selected: boolean,
	) => void;
	onGenerationNumericConstraintChange: (
		modelId: string,
		parameter: string,
		constraint: NumericGenerationConstraint,
	) => void;
	onGenerationBooleanConstraintChange: (
		modelId: string,
		parameter: string,
		constraint: BooleanGenerationConstraint,
	) => void;
};

let {
	open,
	models,
	currentModel,
	thinkingLevelModel = null,
	currentThinkingLevel = null,
	modelStatus = null,
	generationModels,
	generationPolicyMode,
	selectedGenerationModels,
	generationEnumSelections,
	generationNumericConstraints,
	generationBooleanConstraints,
	onClose,
	onSelect,
	onGenerationTabOpen,
	onGenerationPolicyModeChange,
	onGenerationModelToggle,
	onGenerationEnumValueToggle,
	onGenerationNumericConstraintChange,
	onGenerationBooleanConstraintChange,
}: Props = $props();
</script>

<ModelSelector
	{open}
	{onClose}
	{onSelect}
	{models}
	{currentModel}
	{thinkingLevelModel}
	{currentThinkingLevel}
	{modelStatus}
	{generationModels}
	{generationPolicyMode}
	{selectedGenerationModels}
	{generationEnumSelections}
	{generationNumericConstraints}
	{generationBooleanConstraints}
	onGenerationTabOpen={() => void onGenerationTabOpen()}
	{onGenerationPolicyModeChange}
	{onGenerationModelToggle}
	{onGenerationEnumValueToggle}
	{onGenerationNumericConstraintChange}
	{onGenerationBooleanConstraintChange}
/>
