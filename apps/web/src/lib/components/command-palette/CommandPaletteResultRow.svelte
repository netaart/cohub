<script lang="ts">
import { FolderKanban, MessageSquare, Pin, Plus, Tag } from "lucide-svelte";
import { settingsCommandSection } from "$lib/command-palette/commands";
import type { CommandPaletteItem } from "$lib/command-palette/types";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import { SETTINGS_SECTION_ICONS } from "$lib/components/settings-section";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import HighlightedText from "./HighlightedText.svelte";

const {
	item,
	active,
	pinnable,
	onActivate,
	onHover,
	onTogglePin,
}: {
	item: CommandPaletteItem;
	active: boolean;
	pinnable: boolean;
	onActivate: () => void;
	onHover: () => void;
	onTogglePin: () => void;
} = $props();

const locale = $derived(getLocale());

const TYPE_META = {
	chat: { className: "chat", icon: MessageSquare },
	label: { className: "label", icon: Tag },
	command: { className: "command", icon: Plus },
	space: { className: "space", icon: FolderKanban },
} as const;

const meta = $derived(TYPE_META[item.type]);
const section = $derived(settingsCommandSection(item));
const Icon = $derived(section ? SETTINGS_SECTION_ICONS[section] : meta.icon);
const profile = $derived(
	item.type === "space" &&
		item.ownerProfile?.userUuid &&
		item.ownerProfile.displayName
		? item.ownerProfile
		: null,
);
const showsSpaceAvatar = $derived(
	item.type === "space" || item.type === "chat",
);
const title = $derived(
	item.type === "chat" && !item.title
		? m.sidebar_new_chat({}, { locale })
		: item.title,
);
const context = $derived.by(() => {
	if (item.type === "command")
		return item.excerpt ?? m.command_ctx_command({}, { locale });
	if (item.type === "space")
		return item.excerpt ?? m.command_ctx_space({}, { locale });
	if (item.type === "label")
		return `${m.command_ctx_label({ label: item.labelRef ?? item.labelName ?? "Label" }, { locale })}${item.spaceName ? ` · ${item.spaceName}` : ""}`;
	return item.spaceName ?? m.command_ctx_space({}, { locale });
});
const matchCount = $derived(
	item.type === "chat" && (item.matchCount ?? 0) > 1 ? item.matchCount : null,
);
const timestamp = $derived.by(() => {
	if (!item.updatedAt) return null;
	const date = new Date(item.updatedAt);
	if (!Number.isFinite(date.getTime())) return null;

	const now = new Date();
	const isSameLocalDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	const pad = (value: number) => String(value).padStart(2, "0");
	const dateLabel = `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
	const timeLabel = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const timezoneLabel = new Intl.DateTimeFormat(undefined, {
		timeZoneName: "short",
	})
		.formatToParts(date)
		.find((part) => part.type === "timeZoneName")?.value;

	return {
		label: isSameLocalDay ? timeLabel : dateLabel,
		title: `${dateLabel} ${timeLabel}${timezoneLabel ? ` ${timezoneLabel}` : ""}`,
	};
});
</script>

<div
	class:active
	class="command-result"
	onpointermove={onHover}
	role="option"
	aria-selected={active}
	tabindex="-1"
>
	<button type="button" class="command-result-main" onclick={onActivate}>
		{#if showsSpaceAvatar}
			<SpaceAvatar name={item.spaceName || item.title || item.spaceId} profile={item.spaceProfile} seed={item.spaceId} size="sm" />
		{:else}
			<div class={`command-type-mark ${meta.className}`} aria-label={item.type}>
				<Icon class="h-3.5 w-3.5" />
			</div>
		{/if}
		<div class="min-w-0 flex-1 text-left">
			<div class="flex min-w-0 items-center gap-2">
				<span class="truncate text-[13px] font-medium text-text-primary" title={title}><HighlightedText text={title} ranges={item.titleHighlights} /></span>
				{#if matchCount}
					<span class="command-match-count">{m.command_match_count({ count: matchCount }, { locale })}</span>
				{/if}
			</div>
			<div class="command-context-row">
				{#if profile}
					<span class="command-profile" title={profile.displayName}>
						<UserAvatar name={profile.displayName} avatarUrl={profile.avatarUrl} seed={profile.userUuid} size="xxs" class="border-0" />
						<span class="truncate">{profile.displayName}</span>
					</span>
					<span class="command-context-separator">·</span>
				{/if}
				{#if item.type === "chat" && item.hit}
					{#if item.spaceName}
						<span class="command-space-name" title={item.spaceName}>{item.spaceName}</span>
						<span class="command-context-separator">·</span>
					{/if}
					<span class="command-context" title={item.hit.excerpt}><HighlightedText text={item.hit.excerpt} ranges={item.hit.highlights} /></span>
				{:else}
					<span class="command-context" title={context}>{context}</span>
				{/if}
				{#if timestamp}
					<span class="command-context-separator">·</span>
					<time class="command-time" datetime={item.updatedAt ?? undefined} title={timestamp.title}>{timestamp.label}</time>
				{/if}
			</div>
		</div>
		<div class="command-enter">↵</div>
	</button>
	{#if pinnable}
		<button
			type="button"
			class="command-pin-btn"
			class:pinned={item.isPinned}
			title={item.isPinned ? m.command_unpin({}, { locale }) : m.command_pin({}, { locale })}
			aria-label={item.isPinned ? m.command_unpin_item({ title: item.title }, { locale }) : m.command_pin_item({ title: item.title }, { locale })}
			onclick={(event) => {
				event.stopPropagation();
				onTogglePin();
			}}
		>
			<Pin class="h-3.5 w-3.5" />
		</button>
	{/if}
</div>

<style>
	.command-result {
		position: relative;
		display: flex;
		width: 100%;
		align-items: center;
		gap: 4px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		padding: 6px 6px;
		color: inherit;
		transition: background-color 90ms cubic-bezier(0.25, 1, 0.5, 1), transform 90ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.command-result-main {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
		flex: 1;
		border: 0;
		background: transparent;
		color: inherit;
		padding: 4px 4px;
		border-radius: 7px;
		cursor: pointer;
	}

	.command-result-main:focus-visible {
		outline: 2px solid color-mix(in oklch, var(--brand) 42%, transparent);
		outline-offset: -2px;
	}

	.command-pin-btn {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-tertiary);
		opacity: 0;
		cursor: pointer;
		transition: opacity 90ms cubic-bezier(0.25, 1, 0.5, 1), background-color 90ms cubic-bezier(0.25, 1, 0.5, 1), color 90ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.command-pin-btn:focus-visible {
		opacity: 1;
		outline: 2px solid color-mix(in oklch, var(--brand) 42%, transparent);
		outline-offset: -2px;
	}

	.command-pin-btn.pinned {
		opacity: 1;
		color: var(--brand);
	}

	.command-pin-btn:hover {
		opacity: 1;
		background: var(--bg-hover);
		color: var(--brand);
	}

	.command-pin-btn:active {
		transform: scale(0.92);
	}

	.command-result.active .command-pin-btn { opacity: 1; }
	.command-result.active .command-pin-btn:not(.pinned) { color: var(--text-tertiary); }

	.command-result::before {
		content: "";
		position: absolute;
		left: 0;
		top: 8px;
		bottom: 8px;
		width: 2px;
		border-radius: 999px;
		background: transparent;
	}

	.command-result.active { background: color-mix(in oklch, var(--brand-bg) 56%, var(--bg-hover) 44%); }
	.command-result.active::before { background: var(--brand); }
	.command-result.active .command-enter {
		opacity: 1;
	}
	.command-result.active .command-time { color: var(--text-secondary); }
	.command-result.active .command-type-mark { border-color: color-mix(in oklch, currentColor 36%, transparent); }

	.command-type-mark {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border: 1px solid color-mix(in oklch, currentColor 18%, transparent);
		border-radius: 7px;
		background: color-mix(in oklch, currentColor 10%, var(--bg-primary) 90%);
		color: var(--text-tertiary);
	}

	.command-type-mark.space {
		color: var(--brand);
		background: color-mix(in oklch, var(--brand) 12%, var(--bg-primary) 88%);
	}

	.command-type-mark.label {
		color: color-mix(in oklch, var(--brand) 76%, var(--text-secondary) 24%);
		background: color-mix(in oklch, var(--brand) 9%, var(--bg-primary) 91%);
	}

	.command-type-mark.command {
		color: var(--brand);
		background: color-mix(in oklch, var(--brand) 10%, var(--bg-primary) 90%);
	}

	.command-context-row {
		margin-top: 2px;
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 6px;
		color: var(--text-tertiary);
		font-size: 12px;
		line-height: 1.35;
	}

	.command-profile {
		display: inline-flex;
		min-width: 0;
		max-width: min(190px, 42%);
		flex-shrink: 0;
		align-items: center;
		gap: 5px;
		color: color-mix(in oklch, var(--text-secondary) 86%, var(--brand) 14%);
	}

	.command-space-name {
		min-width: 0;
		max-width: min(160px, 40%);
		flex: 0 0 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-secondary);
	}

	.command-match-count {
		flex: 0 0 auto;
		margin-left: auto;
		color: var(--text-placeholder);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.command-context {
		min-width: 0;
		flex: 0 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-context-separator {
		flex: 0 0 auto;
		color: var(--text-placeholder);
	}

	.command-time {
		flex: 0 0 auto;
		color: var(--text-placeholder);
		font-family: var(--font-mono);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
		line-height: 1;
		white-space: nowrap;
	}

	.command-enter {
		width: 12px;
		flex: 0 0 auto;
		opacity: 0;
		color: var(--brand);
		font-family: var(--font-mono);
		font-size: 13px;
		letter-spacing: 0.02em;
		line-height: 1;
		text-align: right;
	}

	@media (max-width: 640px) {
		.command-result {
			min-height: 58px;
			gap: 6px;
			padding: 8px 8px;
		}

		.command-enter {
			display: none;
		}

		.command-space-name {
			max-width: 30%;
		}

		.command-type-mark {
			width: 32px;
			height: 32px;
		}

		.command-pin-btn,
		.command-pin-btn:not(.pinned) {
			width: 44px;
			height: 44px;
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.command-result {
			transition: none;
		}
	}
</style>
