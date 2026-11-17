<script lang="ts">
import ToolCallItem from "#lib/components/ToolCallItem.svelte";
import { toolStateToViewModel } from "#lib/components/tool-call-format.ts";
import type { ToolState } from "#lib/session-tree.ts";
import type { OpenWorkspaceFileTarget } from "#lib/workspace-file-links.ts";

type Props = {
	tool: ToolState;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
};

const { tool, onOpenFile }: Props = $props();
const viewModel = $derived(toolStateToViewModel(tool));
</script>

<ToolCallItem tool={viewModel} {onOpenFile} />
