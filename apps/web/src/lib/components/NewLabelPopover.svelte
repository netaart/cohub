<script lang="ts">
import type { LabelListItem } from "@neta-art/cohub";
import { X } from "lucide-svelte";
import LabelCreateForm from "#lib/components/LabelCreateForm.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { createSpaceLabel } from "#lib/stores/space-labels.ts";

function portal(node: HTMLElement) {
	if (typeof document === "undefined") return {};
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		},
	};
}

const {
	spaceId,
	labels,
	onCreated,
	onClose,
}: {
	spaceId: string;
	labels: LabelListItem[];
	onCreated: () => void;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());

async function createLabel(input: { name: string; parentRef: string | null }) {
	await createSpaceLabel(
		spaceId,
		input.parentRef ? `${input.parentRef}/${input.name}` : input.name,
	);
	onCreated();
	onClose();
}
</script>

<svelte:window onkeydown={(event) => { if (event.key === "Escape") onClose(); }} />

<div use:portal class="fixed inset-0 z-[70] bg-overlay-scrim/20" role="presentation" onclick={onClose}></div>
<div use:portal class="new-label-popover fixed left-3 top-28 z-[71] w-[min(328px,calc(100vw-24px))] overflow-hidden rounded-lg border border-border-subtle bg-bg-primary shadow-xl" role="dialog" aria-label="New label">
	<div class="sheet-handle" aria-hidden="true"></div>
	<div class="flex items-start justify-between border-b border-border-subtle px-3 py-2.5">
		<div class="min-w-0">
			<div class="text-[13px] font-medium text-text-primary">New label</div>
			<div class="mt-0.5 text-[11px] text-text-tertiary">Group chats, files, and checkpoints.</div>
		</div>
		<button type="button" class="close-button" onclick={onClose} aria-label={m.common_close({}, { locale })}>
			<X class="h-3.5 w-3.5" />
		</button>
	</div>
	<div class="px-3 py-3">
		<LabelCreateForm labels={labels} onSubmit={createLabel} onCancel={onClose} autofocus />
	</div>
</div>

<style>
	.close-button {
		display: inline-flex;
		min-height: 28px;
		min-width: 28px;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		color: var(--text-tertiary);
		transition: background-color 120ms ease, color 120ms ease;
	}

	.close-button:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.sheet-handle {
		display: none;
	}

	@media (max-width: 640px) {
		.new-label-popover {
			top: auto;
			right: 8px;
			bottom: 8px;
			left: 8px;
			width: auto;
			max-height: calc(100dvh - 16px);
			border-radius: 14px;
			padding-bottom: env(safe-area-inset-bottom);
		}

		.sheet-handle {
			display: block;
			margin: 8px auto 2px;
			height: 3px;
			width: 36px;
			border-radius: 999px;
			background: var(--border-strong);
			opacity: 0.75;
		}

		.close-button {
			min-height: 44px;
			min-width: 44px;
		}
	}
</style>
