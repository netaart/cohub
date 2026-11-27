import {
	APPROVAL_MODES,
	type ApprovalMode,
	type HarnessKind,
	type LocalHarness,
} from "@cohub/protocol/runtime";
import type { RuntimeCapabilities } from "@neta-art/cohub";
import type { ComponentProps } from "svelte";
import type ModelSelector from "#lib/components/ModelSelector.svelte";
import type { LocalModelSelection } from "#lib/model-catalog.ts";

export type ModelListProps = Omit<
	ComponentProps<typeof ModelSelector>,
	"open" | "onClose" | "onSelect" | "title" | "header" | "footer" | "catalogKey"
>;

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
