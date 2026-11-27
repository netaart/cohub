import {
	APPROVAL_MODES,
	type ApprovalMode,
	type HarnessKind,
	type LocalHarness,
} from "@cohub/protocol/runtime";
import type { RuntimeCapabilities } from "@neta-art/cohub";
import type { LocalModelSelection } from "#lib/model-catalog.ts";

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
