<script lang="ts">
import { ExternalLink, X } from "lucide-svelte";
import type { BoardAssetSource } from "$lib/board/board-asset-source";
import { boardModelSource } from "$lib/board/board-model";
import type { BoardEditor } from "$lib/board/editor.svelte";
import Spinner from "$lib/components/Spinner.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { createLazyModuleLoader, pending } from "$lib/lazy-module";
import { m } from "$lib/paraglide/messages.js";

const loadModelPreview = createLazyModuleLoader(() =>
	import.meta.env.SSR
		? pending()
		: import("$lib/components/ModelPreview.svelte"),
);

const {
	editor,
	assetSource,
	itemId,
	isMobile = false,
	onOpenFile,
	onClose,
}: {
	editor: BoardEditor;
	assetSource: BoardAssetSource;
	itemId: string;
	isMobile?: boolean;
	onOpenFile?: (src: string) => void;
	onClose: () => void;
} = $props();

const MIN_EDGE = 280;

const locale = $derived(getLocale());
const item = $derived(editor.itemById(itemId));
const source = $derived(boardModelSource(item, assetSource));
let attempt = $state(0);
const modulePromise = $derived.by(() => {
	attempt;
	return loadModelPreview();
});

const layout = $derived.by(() => {
	if (!item) return null;
	const { x, y, zoom } = editor.camera;
	const { frame } = item;
	const width = Math.max(MIN_EDGE, frame.width * zoom);
	const height = Math.max(MIN_EDGE, frame.height * zoom);
	return {
		left: (frame.x + frame.width / 2) * zoom + x - width / 2,
		top: (frame.y + frame.height / 2) * zoom + y - height / 2,
		width,
		height,
	};
});

$effect(() => {
	if (!source) onClose();
});

const openLabel = $derived(
	item?.type === "file" && /^https?:/i.test(item.props.src)
		? m.board_open_source({}, { locale })
		: m.board_open_file({}, { locale }),
);

function stop(event: Event) {
	event.stopPropagation();
}

function stopMenu(event: Event) {
	event.preventDefault();
	event.stopPropagation();
}
</script>

{#if item && source && layout}
	<div
		class="board-model-viewer"
		role="dialog"
		tabindex="-1"
		aria-label={source.name}
		style:left="{layout.left}px"
		style:top="{layout.top}px"
		style:width="{layout.width}px"
		style:height="{layout.height}px"
		onpointerdown={stop}
		onwheel={stop}
		oncontextmenu={stopMenu}
		data-drawer-swipe-ignore
	>
		<div class="board-model-header">
			<div class="board-model-title" title={source.name}>{source.name}</div>
			{#if onOpenFile && item.type === "file"}
				{@const src = item.props.src}
				<button
					type="button"
					class="board-model-action"
					title={openLabel}
					aria-label={openLabel}
					onclick={() => onOpenFile(src)}
				>
					<ExternalLink size={14} strokeWidth={2} />
				</button>
			{/if}
			<button
				type="button"
				class="board-model-action"
				title={m.common_close({}, { locale })}
				aria-label={m.common_close({}, { locale })}
				onclick={onClose}
			>
				<X size={14} strokeWidth={2} />
			</button>
		</div>
		<div class="board-model-body">
			{#await modulePromise}
				<div class="board-model-status"><Spinner /></div>
			{:then module}
				{@const ModelPreview = module.default}
				<ModelPreview {source} {isMobile} />
			{:catch}
				<div class="board-model-status">
					<span>{m.model3d_preview_failed({}, { locale })}</span>
					<button type="button" class="action-btn" onclick={() => (attempt += 1)}>
						{m.common_retry({}, { locale })}
					</button>
				</div>
			{/await}
		</div>
	</div>
{/if}

<style>
	.board-model-viewer {
		position: absolute;
		z-index: 28;
		display: flex;
		overflow: hidden;
		border: 1.5px solid var(--brand-border);
		border-radius: 6px;
		background: var(--bg-primary);
		box-shadow: 0 10px 28px color-mix(in srgb, var(--overlay-scrim-strong) 20%, transparent);
		animation: board-model-in 160ms ease-out;
	}

	.board-model-header {
		position: absolute;
		top: 0;
		right: 0;
		left: 0;
		z-index: 11;
		display: flex;
		height: 40px;
		align-items: center;
		gap: 2px;
		padding: 4px 4px 4px 9px;
		background: linear-gradient(
			var(--bg-primary) 30%,
			color-mix(in srgb, var(--bg-primary) 0%, transparent)
		);
	}

	.board-model-title {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		color: var(--text-secondary);
		font-size: 11px;
		font-weight: 500;
		line-height: 1.2;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.board-model-action {
		display: inline-flex;
		width: 32px;
		height: 32px;
		flex: none;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.board-model-action:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.board-model-action:focus-visible {
		outline: 2px solid var(--brand-border);
		outline-offset: -2px;
	}

	.board-model-body {
		position: relative;
		display: flex;
		min-width: 0;
		flex: 1;
	}

	.board-model-status {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		color: var(--text-tertiary);
		font-size: 12px;
	}

	@keyframes board-model-in {
		from {
			opacity: 0;
			transform: scale(0.98);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.board-model-viewer {
			animation: none;
		}
	}
</style>
