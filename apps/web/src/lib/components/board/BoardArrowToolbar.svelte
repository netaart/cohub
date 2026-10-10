<script lang="ts">
import {
	BOARD_COLORS,
	type BoardArrowItem,
	type BoardArrowRoute,
	boardColorCssVar,
	resolveSceneArrow,
	type SceneItem,
} from "@neta-art/cohub/board";
import { canTapSelectWithHand } from "@neta-art/cohub/board/editor";
import {
	ArrowLeft,
	ArrowRight,
	ArrowRightLeft,
	CornerDownRight,
	Minus,
	MoveRight,
	Spline,
	Trash2,
} from "lucide-svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const { editor }: { editor: BoardEditor } = $props();

const locale = $derived(getLocale());

const arrow = $derived.by(() => {
	if (
		editor.selection.length !== 1 ||
		(editor.tool !== "select" &&
			!(editor.tool === "hand" && canTapSelectWithHand(editor.pointerType))) ||
		editor.interaction.type !== "idle"
	)
		return null;
	const item = editor.selectedItems[0];
	return item?.type === "arrow" && !item.locked
		? (item as SceneItem<BoardArrowItem>)
		: null;
});

const position = $derived.by(() => {
	if (!arrow) return null;
	const mid = resolveSceneArrow(arrow, editor.scene).mid;
	const camera = editor.camera;
	return {
		left: mid.x * camera.zoom + camera.x,
		top: Math.max(36, mid.y * camera.zoom + camera.y),
	};
});

type Heads = "none" | "end" | "start" | "both";
const heads = $derived<Heads>(
	!arrow
		? "none"
		: arrow.props.arrowStart && arrow.props.arrowEnd
			? "both"
			: arrow.props.arrowEnd
				? "end"
				: arrow.props.arrowStart
					? "start"
					: "none",
);

const HEAD_OPTIONS = $derived<
	Array<{ id: Heads; label: string; icon: typeof Minus }>
>([
	{ id: "none", label: m.board_no_direction({}, { locale }), icon: Minus },
	{
		id: "end",
		label: m.board_direction_source_target({}, { locale }),
		icon: ArrowRight,
	},
	{
		id: "start",
		label: m.board_direction_target_source({}, { locale }),
		icon: ArrowLeft,
	},
	{
		id: "both",
		label: m.board_direction_bidirectional({}, { locale }),
		icon: ArrowRightLeft,
	},
]);

const ROUTE_OPTIONS = $derived<
	Array<{ id: BoardArrowRoute; label: string; icon: typeof Minus }>
>([
	{
		id: "straight",
		label: m.board_route_straight({}, { locale }),
		icon: MoveRight,
	},
	{ id: "curve", label: m.board_route_curve({}, { locale }), icon: Spline },
	{
		id: "orthogonal",
		label: m.board_route_orthogonal({}, { locale }),
		icon: CornerDownRight,
	},
]);

function setHeads(value: Heads) {
	editor.setSelectionProps("arrow", {
		arrowStart: value === "start" || value === "both",
		arrowEnd: value === "end" || value === "both",
	});
}

function setRoute(route: BoardArrowRoute) {
	editor.setSelectionProps("arrow", {
		route,
		...(route === "straight" ? { bend: 0 } : {}),
	});
}

function toggleDash() {
	editor.setSelectionStyle({
		dash: arrow?.style.dash === "dashed" ? "solid" : "dashed",
	});
}
</script>

{#if arrow && position}
	<div
		class="board-connection-toolbar"
		style:left="{position.left}px"
		style:top="{position.top}px"
		role="toolbar"
		aria-label={m.board_arrow_actions({}, { locale })}
	>
		<div class="group" role="group" aria-label={m.board_direction_label({}, { locale })}>
			{#each HEAD_OPTIONS as option (option.id)}
				<button
					type="button"
					class="conn-btn"
					class:conn-btn--active={heads === option.id}
					title={option.label}
					aria-label={option.label}
					aria-pressed={heads === option.id}
					onclick={() => setHeads(option.id)}
				>
					<option.icon class="h-3.5 w-3.5" />
				</button>
			{/each}
		</div>

		<div class="divider"></div>

		<div class="group" role="group" aria-label={m.board_route_label({}, { locale })}>
			{#each ROUTE_OPTIONS as option (option.id)}
				<button
					type="button"
					class="conn-btn"
					class:conn-btn--active={arrow.props.route === option.id}
					title={option.label}
					aria-label={option.label}
					aria-pressed={arrow.props.route === option.id}
					onclick={() => setRoute(option.id)}
				>
					<option.icon class="h-3.5 w-3.5" />
				</button>
			{/each}
			<button
				type="button"
				class="conn-btn"
				class:conn-btn--active={arrow.style.dash === "dashed"}
				title={m.board_line_dashed({}, { locale })}
				aria-label={m.board_line_dashed({}, { locale })}
				aria-pressed={arrow.style.dash === "dashed"}
				onclick={toggleDash}
			>
				<span class="dash-glyph" aria-hidden="true"></span>
			</button>
		</div>

		<div class="divider"></div>

		<div class="color-list" role="group" aria-label={m.board_color({}, { locale })}>
			{#each BOARD_COLORS as color (color.id)}
				<button
					type="button"
					class="swatch"
					class:swatch--active={(arrow.style.stroke ?? "brand") === color.id}
					title={color.label}
					aria-label={color.label}
					style:--swatch-color="var({boardColorCssVar(color.id, 'stroke')})"
					onclick={() => editor.setSelectionColor(color.id)}
				></button>
			{/each}
		</div>

		<div class="divider"></div>

		<button
			type="button"
			class="conn-btn conn-btn--danger"
			title={m.board_delete_arrow({}, { locale })}
			aria-label={m.board_delete_arrow({}, { locale })}
			onclick={() => editor.deleteSelection()}
		>
			<Trash2 class="h-3.5 w-3.5" />
		</button>
	</div>
{/if}

<style>
	.board-connection-toolbar {
		position: absolute;
		z-index: 24;
		display: flex;
		align-items: center;
		gap: 2px;
		transform: translate(-50%, calc(-100% - 14px));
		border-radius: 9px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
		padding: 4px;
		box-shadow: 0 8px 20px color-mix(in srgb, var(--overlay-scrim-strong) 14%, transparent);
		backdrop-filter: blur(12px);
		white-space: nowrap;
		max-width: calc(100% - 16px);
		overflow-x: auto;
		scrollbar-width: none;
	}
	.board-connection-toolbar::-webkit-scrollbar { display: none; }

	.group {
		display: flex;
		align-items: center;
		gap: 1px;
	}

	.conn-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		border-radius: 6px;
		color: var(--text-secondary);
		cursor: pointer;
		transition: background-color 100ms ease, color 100ms ease;
		flex-shrink: 0;
	}
	.conn-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
	.conn-btn--active {
		background: var(--brand-bg);
		color: var(--brand-muted-fg);
	}
	.conn-btn--danger:hover { background: var(--error-bg); color: var(--error-700); }

	.color-list {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 0 2px;
	}

	.swatch {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 1.5px solid var(--border-subtle);
		background: var(--swatch-color);
		cursor: pointer;
		transition: transform 100ms ease, border-color 100ms ease;
		flex-shrink: 0;
	}
	.swatch:hover { transform: scale(1.18); }
	.swatch--active {
		border-color: var(--text-primary);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--swatch-color) 40%, transparent);
	}

	.dash-glyph {
		width: 14px;
		border-top: 2px dashed currentColor;
	}

	.divider {
		width: 1px;
		height: 16px;
		margin: 0 3px;
		background: var(--border-subtle);
		flex-shrink: 0;
	}

	@media (pointer: coarse) {
		.board-connection-toolbar {
			max-width: calc(100% - 20px);
		}
		.conn-btn { width: 36px; height: 36px; flex-shrink: 0; }
		.swatch { width: 22px; height: 22px; flex-shrink: 0; }
	}
</style>
