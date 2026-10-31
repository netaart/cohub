<script lang="ts" module>
import { SvelteSet } from "svelte/reactivity";

const unreadableImages = new SvelteSet<string>();
</script>

<script lang="ts">
import type {
	AppDetailResponse,
	AppRuntimeShellContext,
} from "@neta-art/cohub";
import type { BoardItemViewContext } from "@neta-art/cohub/board/stage";
import { LoaderCircle, Play } from "lucide-svelte";
import { appCoverUrl, appThemeColor } from "$lib/app-page-meta";
import { avatarInitials } from "$lib/avatar-initials";
import type {
	AppNavigationHandler,
	BoardAppDetails,
	BoardAppMeta,
} from "$lib/board/board-app";
import Avatar from "$lib/components/Avatar.svelte";
import AppSurface from "$lib/components/app/AppSurface.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	meta,
	context,
	details,
	live,
	onRun,
	shell,
	onNavigationOpen,
}: {
	meta: BoardAppMeta;
	context: BoardItemViewContext;
	details: BoardAppDetails;
	live: boolean;
	onRun: () => void;
	shell?: AppRuntimeShellContext;
	onNavigationOpen?: AppNavigationHandler;
} = $props();

const locale = $derived(getLocale());
const appId = $derived(meta.appId);
const detailed = $derived(context.detailed);
const running = $derived(live && detailed);

let loaded = $state.raw<{
	appId: string;
	detail: AppDetailResponse | null;
} | null>(null);
const settled = $derived(loaded?.appId === appId);
const detail = $derived(
	settled ? (loaded?.detail ?? null) : details.peek(appId),
);

$effect(() => {
	const id = appId;
	if (!detailed) return;
	let current = true;
	void details.load(id).then((value) => {
		if (current) loaded = { appId: id, detail: value };
	});
	return () => {
		current = false;
	};
});

const cover = $derived(
	(detail && appCoverUrl(detail.app.meta, detail.content?.url)) || meta.cover,
);
const tint = $derived.by(() => {
	const color = appThemeColor(detail?.app.meta) ?? meta.themeColor;
	return color && CSS.supports("color", color) ? color : undefined;
});
const description = $derived(detail?.app.meta?.description?.trim() || null);
const unavailable = $derived(settled && !detail);

let shownCover = $state<string | null>(null);

const readable = $derived(
	![meta.icon, cover, shownCover].some(
		(src) => src && unreadableImages.has(src),
	),
);
const drawable = $derived(!live && readable);
const cors = $derived(
	drawable && context.canDraw ? ("anonymous" as const) : undefined,
);
$effect.pre(() => context.setDrawable(drawable));

function unreadable(src: string | null | undefined) {
	if (cors && src) unreadableImages.add(src);
}
</script>

<div
	class="board-app-node"
	class:selected={context.selected}
	class:entered={context.entered}
>
	<div class="board-app-bar">
		{#if meta.icon}
			<img src={meta.icon} alt="" crossorigin={cors} onerror={() => unreadable(meta.icon)} />
		{/if}
		<span>{meta.name}</span>
		{#if live}<i class="board-app-live" aria-hidden="true"></i>{/if}
	</div>
	<div class="board-app-content">
		{#if running && detail}
			<AppSurface
				mode="app"
				app={detail.app}
				space={detail.space}
				owner={detail.owner}
				content={detail.content}
				{shell}
				{onNavigationOpen}
			/>
		{:else}
			<div class="board-app-face" style:--app-tint={tint}>
				<div class="board-app-fallback">
					<Avatar
						src={meta.icon}
						seed={appId}
						mark={avatarInitials(meta.name, "A")}
						shape="tile"
						size="lg"
						crossorigin={cors}
					/>
					{#if detailed}
						<strong>{meta.name}</strong>
						{#if description}<p>{description}</p>{/if}
					{/if}
				</div>
				{#if shownCover && shownCover !== cover}
					<img
						class="board-app-cover shown"
						src={shownCover}
						alt=""
						draggable="false"
						crossorigin={cors}
						onerror={() => unreadable(shownCover)}
					/>
				{/if}
				{#if cover}
					<img
						class="board-app-cover"
						class:shown={shownCover === cover}
						src={cover}
						alt=""
						decoding="async"
						draggable="false"
						crossorigin={cors}
						onload={() => {
							shownCover = cover ?? null;
						}}
						onerror={() => unreadable(cover)}
					/>
				{/if}
				{#if unavailable}
					<span class="board-app-pill board-app-unavailable">
						{m.board_app_unavailable({}, { locale })}
					</span>
				{:else if running}
					<div class="board-app-loading">
						<LoaderCircle class="h-5 w-5 animate-spin" />
					</div>
				{:else if detailed}
					<button
						type="button"
						class="board-app-pill board-app-run"
						title={m.board_app_run({}, { locale })}
						onclick={onRun}
					>
						<Play class="h-3.5 w-3.5" fill="currentColor" />
						{m.board_app_run({}, { locale })}
					</button>
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.board-app-node {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		pointer-events: none;
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-primary);
		box-shadow: 0 8px 24px color-mix(in srgb, var(--text-primary) 12%, transparent);
		transition: border-color 120ms ease, box-shadow 120ms ease;
	}
	.board-app-node.selected {
		border-color: var(--brand-border);
	}
	.board-app-node.entered {
		border-color: var(--brand-border);
		box-shadow: 0 0 0 2px var(--brand-border), 0 8px 24px color-mix(in srgb, var(--text-primary) 12%, transparent);
	}
	.board-app-node.entered .board-app-content {
		pointer-events: auto;
	}
	.board-app-bar {
		display: flex;
		height: 28px;
		flex-shrink: 0;
		align-items: center;
		gap: 6px;
		padding: 0 8px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: 11px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
	}
	.board-app-bar img {
		width: 16px;
		height: 16px;
		border-radius: 4px;
		object-fit: cover;
	}
	.board-app-bar span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.board-app-live {
		width: 6px;
		height: 6px;
		flex-shrink: 0;
		margin-left: auto;
		border-radius: 50%;
		background: var(--brand);
	}
	.board-app-content {
		position: relative;
		flex: 1;
		min-height: 0;
		margin: 8px;
		border-radius: 4px;
		overflow: hidden;
	}
	.board-app-face {
		position: absolute;
		inset: 0;
		background:
			radial-gradient(120% 90% at 20% 0%, color-mix(in srgb, var(--app-tint, var(--brand)) 26%, transparent), transparent 70%),
			var(--bg-elevated);
	}
	.board-app-fallback {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 16px;
		text-align: center;
	}
	.board-app-fallback strong {
		max-width: 100%;
		overflow: hidden;
		color: var(--text-primary);
		font-size: 14px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.board-app-fallback p {
		display: -webkit-box;
		max-width: 32ch;
		overflow: hidden;
		color: var(--text-tertiary);
		font-size: 12px;
		line-height: 1.45;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
	}
	.board-app-cover {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: center top;
		opacity: 0;
		transition: opacity 160ms ease;
	}
	.board-app-cover.shown {
		opacity: 1;
	}
	.board-app-pill {
		position: absolute;
		right: 10px;
		bottom: 10px;
		display: inline-flex;
		height: 28px;
		align-items: center;
		gap: 6px;
		padding: 0 12px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
		box-shadow: 0 0 0 1px var(--border-subtle), 0 4px 12px color-mix(in srgb, var(--text-primary) 14%, transparent);
		color: var(--text-primary);
		font-size: 12px;
		font-weight: 500;
		backdrop-filter: blur(8px);
	}
	.board-app-run {
		pointer-events: auto;
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease;
	}
	.board-app-run:hover {
		background: var(--brand);
		color: var(--brand-contrast-fg);
	}
	.board-app-unavailable {
		color: var(--text-tertiary);
	}
	.board-app-loading {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: color-mix(in srgb, var(--bg-primary) 40%, transparent);
		color: var(--text-tertiary);
	}
</style>
