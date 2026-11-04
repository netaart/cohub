<script lang="ts">
import type {
	BoardAutomationActivity,
	BoardPresence,
	BoardPresenceAction,
	BoardPresenceActivity,
} from "@neta-art/cohub/board/presence";
import { Bot, Check, Scan, Smartphone, Terminal } from "lucide-svelte";
import { createSubscriber } from "svelte/reactivity";
import { identityColor } from "$lib/avatar-identity";
import type { BoardCollaboratorProfile } from "$lib/board/board-collaborator";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { getModelDisplayName } from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";

type Props = {
	presence: BoardPresence;
	profiles: ReadonlyMap<string, BoardCollaboratorProfile>;
	onOpenActivity?: (activity: BoardAutomationActivity) => void;
};

let { presence, profiles, onOpenActivity }: Props = $props();

const locale = $derived(getLocale());
const LABEL_WIDTH = 148;
const changes = createSubscriber((update) => presence.subscribe(update));

function displayName(actorId: string, fallback: string) {
	return profiles.get(actorId)?.displayName ?? fallback;
}

function avatarUrl(actorId: string) {
	return profiles.get(actorId)?.avatarUrl ?? null;
}

function actionLabel(action: BoardPresenceAction | null): string | null {
	switch (action) {
		case "drawing":
			return m.collab_drawing({}, { locale });
		case "connecting":
			return m.collab_connecting({}, { locale });
		case "creating":
			return m.collab_creating({}, { locale });
		case "moving":
			return m.collab_moving({}, { locale });
		case "resizing":
			return m.collab_resizing({}, { locale });
		case "rotating":
			return m.collab_rotating({}, { locale });
		case "adjusting":
			return m.collab_adjusting({}, { locale });
		case "editing":
			return m.collab_editing({}, { locale });
		case "viewing":
			return m.collab_viewing({}, { locale });
		default:
			return null;
	}
}

let width = $state(0);

const cursors = $derived.by(() => {
	changes();
	return presence.cursors.map((cursor) => ({
		...cursor,
		name: displayName(cursor.actorId, cursor.actorName),
		label: actionLabel(cursor.action),
		avatar: avatarUrl(cursor.actorId),
		color: identityColor(cursor.actorId),
		flip: cursor.x > width - LABEL_WIDTH,
	}));
});

const activities = $derived.by(() => {
	changes();
	return presence.activities.map((activity) => {
		const name = displayName(activity.actorId, "Someone");
		const actionable =
			activity.kind === "agent" && Boolean(activity.source.sessionId);
		const modelName = activity.model
			? getModelDisplayName(modelsCatalogStore.items, {
					provider: activity.model.provider,
					model: activity.model.id,
				})
			: "";
		const label =
			activity.kind === "agent"
				? modelName
					? `${modelName} · ${name}`
					: `${name}'s agent`
				: `${name} · CLI`;
		return {
			activity,
			label,
			title: actionable
				? `${label} \u2014 ${m.collab_open_chat({}, { locale })}`
				: label,
			color: identityColor(activity.actorId),
			avatar: avatarUrl(activity.actorId),
			name,
			actionable,
		};
	});
});

$effect(() => {
	if (
		!activities.some(
			({ activity }) => activity.kind === "agent" && activity.model,
		)
	)
		return;
	void modelsCatalogStore.load().catch(() => undefined);
});
</script>

{#snippet ActivityBody(marker: {
	activity: BoardPresenceActivity;
	label: string;
	name: string;
	avatar: string | null;
})}
	<span class="collab-activity-icon">
		{#if marker.activity.kind === "agent"}
			<Bot class="h-3 w-3" />
			<span class="collab-activity-corner">
				{#if marker.activity.status === "settled"}
					<Check class="h-2 w-2" />
				{:else}
					<Terminal class="h-1.5 w-1.5" />
				{/if}
			</span>
		{:else}
			<Terminal class="h-3 w-3" />
		{/if}
	</span>
	<span class="collab-activity-label">{marker.label}</span>
	<UserAvatar name={marker.name} avatarUrl={marker.avatar} seed={marker.activity.actorId} size="xxs" class="collab-activity-avatar" />
{/snippet}

<div class="collab-overlay" bind:clientWidth={width}>
	{#each cursors as cursor (cursor.connectionId)}
		<div
			class="collab-cursor"
			class:collab-cursor--flip={cursor.flip}
			class:collab-cursor--edge={cursor.offscreen}
			style:--collab-color={cursor.color}
			style:transform={`translate3d(${cursor.x}px, ${cursor.y}px, 0)`}
			style:opacity={cursor.fading ? 0 : 1}
			aria-hidden="true"
		>
			{#if cursor.pointerType === null}
				<span class="collab-view-focus"><Scan class="h-3 w-3" /></span>
			{:else if cursor.pointerType === "touch"}
				<span class="collab-touch-ring" class:collab-touch-ring--released={cursor.released}></span>
			{:else if cursor.pointerType === "pen"}
				<span class="collab-pen-dot"></span>
			{:else}
				<svg class="collab-arrow" viewBox="0 0 14 18" width="14" height="18" focusable="false">
					<path
						d="M0 0 L1.5 16 L5.5 12 L9 18 L12 16 L8.5 10 L14 9 Z"
						fill="var(--collab-color)"
						stroke="var(--bg-primary)"
						stroke-width="1.2"
						stroke-linejoin="round"
					/>
				</svg>
			{/if}

			<span class="collab-tag">
				<span class="collab-avatar-wrap">
					<UserAvatar name={cursor.name} avatarUrl={cursor.avatar} seed={cursor.actorId} size="xs" class="collab-avatar" />
					{#if cursor.mobile}
						<span class="collab-badge"><Smartphone class="h-2 w-2" /></span>
					{/if}
				</span>
				{#if cursor.labelled}
					<span class="collab-name">
						{cursor.name}{cursor.label ? ` · ${cursor.label}` : ""}
					</span>
				{/if}
			</span>
		</div>
	{/each}

	{#each activities as marker (marker.activity.id)}
		<div
			class="collab-activity"
			class:collab-activity--settled={marker.activity.status === "settled"}
			style:--collab-color={marker.color}
			style:transform={`translate3d(${marker.activity.x}px, ${marker.activity.y}px, 0)`}
		>
			{#if marker.actionable}
				<button
					type="button"
					class="collab-activity-chip collab-activity-chip--actionable"
					title={marker.title}
					onclick={() => onOpenActivity?.(marker.activity)}
				>
					{@render ActivityBody(marker)}
				</button>
			{:else}
				<span class="collab-activity-chip" title={marker.title}>
					{@render ActivityBody(marker)}
				</span>
			{/if}
		</div>
	{/each}
</div>

<style>
	.collab-overlay {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		z-index: 12;
	}

	.collab-cursor,
	.collab-activity {
		position: absolute;
		top: 0;
		left: 0;
		display: flex;
		align-items: flex-start;
		gap: 6px;
		will-change: transform;
	}

	.collab-cursor {
		transition: transform 90ms linear, opacity 250ms ease-out;
	}

	.collab-cursor--flip {
		flex-direction: row-reverse;
		transform-origin: top right;
	}

	.collab-cursor--edge .collab-arrow,
	.collab-cursor--edge .collab-touch-ring,
	.collab-cursor--edge .collab-pen-dot,
	.collab-cursor--edge .collab-view-focus {
		opacity: 0.35;
	}

	.collab-arrow {
		display: block;
		flex-shrink: 0;
		filter: drop-shadow(0 1px 2px var(--shadow-medium));
	}

	.collab-touch-ring {
		position: relative;
		display: block;
		margin: -13px 0 0 -13px;
		height: 26px;
		width: 26px;
		flex-shrink: 0;
		border: 2px solid var(--collab-color);
		border-radius: 9999px;
		background: color-mix(in srgb, var(--collab-color) 12%, transparent);
	}

	.collab-touch-ring::after {
		content: "";
		position: absolute;
		top: 50%;
		left: 50%;
		height: 4px;
		width: 4px;
		transform: translate(-50%, -50%);
		border-radius: 9999px;
		background: var(--collab-color);
	}

	.collab-touch-ring--released::after {
		opacity: 0;
	}

	.collab-view-focus {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 20px;
		width: 20px;
		flex-shrink: 0;
		margin: -10px 0 0 -10px;
		border: 1px solid color-mix(in srgb, var(--collab-color) 70%, transparent);
		border-radius: 4px;
		background: var(--bg-elevated);
		color: var(--collab-color);
		box-shadow: 0 1px 3px var(--shadow-subtle);
	}

	.collab-pen-dot {
		display: block;
		height: 10px;
		width: 10px;
		flex-shrink: 0;
		margin: -5px 0 0 -5px;
		border-radius: 9999px;
		background: var(--collab-color);
		box-shadow: 0 0 0 2px var(--bg-primary);
	}

	.collab-tag {
		display: flex;
		align-items: center;
		gap: 5px;
		margin-top: 12px;
		max-width: 160px;
	}

	.collab-avatar-wrap {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
	}

	:global(.collab-avatar) {
		box-shadow: 0 0 0 1.5px var(--collab-color);
	}

	.collab-badge {
		position: absolute;
		right: -3px;
		bottom: -3px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 10px;
		width: 10px;
		border-radius: 9999px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		box-shadow: 0 0 0 1px var(--border-subtle);
	}

	.collab-name {
		max-width: 128px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		border-radius: 4px;
		padding: 1px 5px;
		background: var(--collab-color);
		color: var(--brand-contrast-fg);
		font-size: 11px;
		font-weight: 600;
		line-height: 1.5;
	}

	.collab-activity {
		transition:
			transform 280ms cubic-bezier(0.22, 1, 0.36, 1),
			opacity 180ms ease-out;
		animation: collab-activity-in 120ms ease-out both;
	}

	.collab-activity--settled {
		opacity: 0.58;
	}

	.collab-activity-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		border: 1px solid color-mix(in srgb, var(--collab-color) 45%, transparent);
		border-radius: 6px;
		padding: 2px 5px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: 11px;
		font-weight: 500;
		line-height: 1.5;
		box-shadow: 0 2px 6px var(--shadow-subtle);
	}

	.collab-activity-chip--actionable {
		pointer-events: auto;
		cursor: pointer;
		transition: background-color 100ms ease-out, border-color 100ms ease-out;
	}

	.collab-activity-chip--actionable:hover {
		background: var(--bg-hover);
		border-color: var(--collab-color);
	}

	.collab-activity-chip--actionable:focus-visible {
		outline: 2px solid var(--brand-ring);
		outline-offset: 1px;
	}

	.collab-activity-icon {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		color: var(--collab-color);
	}

	.collab-activity-corner {
		position: absolute;
		right: -3px;
		bottom: -3px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 8px;
		width: 8px;
		border-radius: 2px;
		background: var(--bg-elevated);
		color: var(--text-tertiary);
	}

	.collab-activity-label {
		max-width: min(220px, calc(100vw - 96px));
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	:global(.collab-activity-avatar) {
		box-shadow: 0 0 0 1px var(--collab-color);
	}

	@keyframes collab-activity-in {
		from {
			opacity: 0;
			scale: 0.96;
		}
		to {
			opacity: 1;
			scale: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.collab-cursor,
		.collab-activity {
			transition: none;
			animation: none;
		}
	}
</style>
