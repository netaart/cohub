<script lang="ts">
import type { SpacePresenceUser } from "@neta-art/cohub";
import { onMount } from "svelte";
import { floatNear, portal } from "#lib/actions/portal.ts";
import ListRow from "#lib/components/list-page/ListRow.svelte";
import ListRowText from "#lib/components/list-page/ListRowText.svelte";
import { LIST_ROW_AVATAR } from "#lib/components/list-page/list-row.ts";
import ToggleSwitch from "#lib/components/ToggleSwitch.svelte";
import UserAvatar from "#lib/components/UserAvatar.svelte";
import {
	isSpaceDanmakuEnabled,
	setSpaceDanmakuEnabled,
} from "#lib/danmaku-prefs.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { authStore } from "#lib/stores/auth.svelte.ts";
import { displayUserName } from "../space-utils.ts";

type Props = {
	users: SpacePresenceUser[];
	spaceId: string;
	limit?: number;
};

let { users, spaceId, limit = 4 }: Props = $props();

const locale = $derived(getLocale());
const userId = $derived(authStore.userUuid);
const danmakuEnabled = $derived(
	userId !== null && isSpaceDanmakuEnabled(userId, spaceId),
);

let open = $state(false);
let presenceRootEl: HTMLDivElement | null = $state(null);

const visibleUsers = $derived(users.slice(0, limit));
const firstUser = $derived(users[0]);
const overflowCount = $derived(Math.max(0, users.length - visibleUsers.length));
const itemPriority = (item: Record<string, unknown>) => {
	if (item.kind === "session") return 0;
	if (item.kind === "file") return 1;
	return 2;
};

function getPanels(user: SpacePresenceUser) {
	const directPanels = Array.isArray(user.meta?.panels)
		? user.meta.panels.filter((panel): panel is Record<string, unknown> =>
				Boolean(panel && typeof panel === "object" && !Array.isArray(panel)),
			)
		: [];
	const aggregatedPanels = user.metas.flatMap((meta) =>
		Array.isArray(meta?.panels)
			? meta.panels.filter((panel): panel is Record<string, unknown> =>
					Boolean(panel && typeof panel === "object" && !Array.isArray(panel)),
				)
			: [],
	);
	return [...directPanels, ...aggregatedPanels];
}

function locationLabel(item?: Record<string, unknown>) {
	const label = typeof item?.label === "string" ? item.label.trim() : "";
	if (label) return label;
	const options = { locale };
	switch (item?.kind) {
		case "session":
			return m.presence_in_chat({}, options);
		case "file":
			return m.presence_in_file({}, options);
		case "checkpoint":
			return m.presence_in_save({}, options);
		case "task":
			return m.presence_in_task({}, options);
		case "app":
		case "work":
			return m.presence_in_app({}, options);
		case "cronjob":
			return m.presence_in_cronjob({}, options);
		default:
			return m.presence_in_space({}, options);
	}
}

const popoverTitle = $derived(
	m.presence_online_count({ count: users.length }, { locale }),
);
const desktopCountVisible = $derived(overflowCount > 0);
const mobileCountVisible = $derived(users.length > 1);

function toggleOpen() {
	open = !open;
}

onMount(() => {
	const handlePointerDown = (event: PointerEvent) => {
		if (!open || !presenceRootEl) return;
		const target = event.target as Node | null;
		// Portaled popover is outside root; keep open when clicking it.
		if (
			target &&
			(presenceRootEl.contains(target) ||
				(target instanceof Element && target.closest(".presence-popover")))
		)
			return;
		open = false;
	};
	const handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") open = false;
	};
	document.addEventListener("pointerdown", handlePointerDown, true);
	window.addEventListener("keydown", handleKeyDown);
	return () => {
		document.removeEventListener("pointerdown", handlePointerDown, true);
		window.removeEventListener("keydown", handleKeyDown);
	};
});

$effect(() => {
	if (users.length === 0) open = false;
});
</script>

{#if users.length > 0}
	<div class="presence-root" bind:this={presenceRootEl}>
		<button
			type="button"
			class="presence-stack"
			onclick={toggleOpen}
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-label={popoverTitle}
		>
			<div class="presence-avatars" aria-hidden="true">
				{#each visibleUsers as user (user.userId)}
					<UserAvatar
						name={displayUserName(user.profile, user.userId)}
						avatarUrl={user.profile.avatarUrl}
						seed={user.userId}
						size="xxs"
						class="presence-avatar"
					/>
				{/each}
				{#if overflowCount > 0}
					<span class="presence-overflow">+{overflowCount}</span>
				{/if}
			</div>
			<div class="presence-mobile-avatar" aria-hidden="true">
				{#if firstUser}
					<UserAvatar
						name={displayUserName(firstUser.profile, firstUser.userId)}
						avatarUrl={firstUser.profile.avatarUrl}
						seed={firstUser.userId}
						size="xxs"
						class="border-bg-elevated"
					/>
				{/if}
			</div>
			{#if desktopCountVisible}
				<span class="presence-count presence-count-desktop">{users.length}</span>
			{/if}
			{#if mobileCountVisible}
				<span class="presence-count presence-count-mobile">{users.length}</span>
			{/if}
		</button>

		{#if open}
			<div class="presence-backdrop" aria-hidden="true" use:portal onclick={() => (open = false)}></div>
			<div
				class="presence-popover"
				role="dialog"
				aria-label={popoverTitle}
				use:floatNear={{
					getAnchor: () => presenceRootEl,
					placement: "bottom-end",
					gap: 8,
					width: 280,
					zIndex: 90,
				}}
			>
				<div class="presence-popover-header">
					<span class="presence-popover-title">{m.presence_online({}, { locale })}</span>
					<span class="presence-popover-meta">{users.length}</span>
				</div>
				<div class="presence-popover-list" role="list">
					{#each users as user (user.userId)}
						{@const panels = getPanels(user)}
						{@const primaryPanel = panels.sort((a, b) => itemPriority(a) - itemPriority(b))[0]}
						{@const userName = displayUserName(user.profile, user.userId)}
						<ListRow density="compact" role="listitem">
							{#snippet leading()}
								<UserAvatar name={userName} avatarUrl={user.profile.avatarUrl} seed={user.userId} size={LIST_ROW_AVATAR.compact} />
							{/snippet}
							<ListRowText title={userName} tooltip={userName}>
								{#snippet subtitle()}
									{locationLabel(primaryPanel)}{#if panels.length > 1}<span class="ml-1.5">· {m.presence_panels({ count: panels.length }, { locale })}</span>{/if}
								{/snippet}
							</ListRowText>
						</ListRow>
					{/each}
				</div>
				{#if userId}
					<div class="presence-popover-footer">
						<span class="presence-popover-footer-label">{m.presence_danmaku({}, { locale })}</span>
						<ToggleSwitch
							checked={danmakuEnabled}
							label={m.presence_danmaku({}, { locale })}
							onchange={(enabled) => {
								if (userId) setSpaceDanmakuEnabled(userId, spaceId, enabled);
							}}
						/>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.presence-root {
		position: relative;
		flex: 0 0 auto;
	}

	.presence-stack {
		display: inline-flex;
		height: 24px;
		align-items: center;
		gap: 4px;
		border-radius: 999px;
		border: 0;
		background: transparent;
		padding: 0 5px 0 1px;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, transform 120ms ease;
	}

	.presence-stack:hover,
	.presence-stack[aria-expanded="true"] {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.presence-stack:active {
		transform: translateY(0.5px);
	}

	.presence-stack:focus-visible {
		outline: 2px solid color-mix(in srgb, var(--brand) 38%, transparent);
		outline-offset: 1px;
	}

	.presence-avatars {
		display: inline-flex;
		align-items: center;
		padding-left: 2px;
	}

	:global(.presence-avatar) {
		margin-left: -3px;
		border-color: var(--bg-elevated);
		box-shadow: 0 0 0 1px var(--bg-elevated);
	}

	:global(.presence-avatar:first-child) {
		margin-left: 0;
	}

	.presence-overflow {
		margin-left: -3px;
		display: inline-flex;
		height: 16px;
		min-width: 16px;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		border: 1px solid var(--bg-elevated);
		background: var(--bg-hover-strong);
		padding: 0 4px;
		font-size: 8px;
		font-weight: 650;
		line-height: 1;
		color: var(--text-tertiary);
		box-shadow: 0 0 0 1px var(--bg-elevated);
	}

	.presence-mobile-avatar {
		display: none;
		align-items: center;
	}

	.presence-count {
		font-size: 11px;
		font-weight: 550;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}

	.presence-count-mobile {
		display: none;
	}

	.presence-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-workspace-popover);
		background: transparent;
	}

	.presence-popover {
		width: min(280px, calc(100vw - 24px));
		overflow: hidden;
		border: 1px solid var(--border-subtle);
		border-radius: 14px;
		background: var(--bg-elevated);
		box-shadow: 0 18px 32px color-mix(in srgb, var(--overlay-scrim-strong) 12%, transparent);
	}

	.presence-popover-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		border-bottom: 1px solid var(--border-subtle);
		padding: 8px 10px 7px;
	}

	.presence-popover-title {
		font-size: 11px;
		font-weight: 650;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--text-secondary);
	}

	.presence-popover-meta {
		font-size: 11px;
		color: var(--text-tertiary);
		font-variant-numeric: tabular-nums;
	}

	.presence-popover-list {
		max-height: min(280px, calc(100vh - 140px));
		overflow: auto;
		padding: 4px;
	}

	.presence-popover-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		border-top: 1px solid var(--border-subtle);
		padding: 8px 10px;
	}

	.presence-popover-footer-label {
		font-size: 12px;
		color: var(--text-secondary);
	}

	@media (max-width: 640px) {
		.presence-stack {
			gap: 4px;
			padding: 0 5px 0 3px;
		}

		.presence-avatars {
			display: none;
		}

		.presence-mobile-avatar {
			display: inline-flex;
		}

		.presence-count-desktop {
			display: none;
		}

		.presence-count-mobile {
			display: inline-flex;
		}

		.presence-backdrop {
			position: fixed;
			inset: 0;
			z-index: var(--z-workspace-popover-open);
			display: block;
			background: var(--overlay-scrim);
		}

		.presence-popover {
			position: fixed;
			left: 8px;
			right: 8px;
			top: auto;
			bottom: 8px;
			width: auto;
			max-width: none;
			border-radius: 18px 18px 14px 14px;
		}

		.presence-popover-header {
			padding: 10px 12px 8px;
		}

		.presence-popover-list {
			max-height: min(52vh, calc(100vh - 92px));
			padding: 6px;
		}
	}
</style>
