<script lang="ts">
import type { DisplayViewer, SpacePresenceUser } from "@neta-art/cohub";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { authStore } from "$lib/stores/auth.svelte";
import { displayUserName } from "../space-utils";

const {
	viewers = [],
	people = [],
	limit = 3,
}: {
	viewers?: DisplayViewer[];
	people?: SpacePresenceUser[];
	limit?: number;
} = $props();

const locale = $derived(getLocale());
const others = $derived(
	viewers.filter((viewer) => viewer.userId !== authStore.userUuid),
);
const profiles = $derived(
	new Map(people.map((user) => [user.userId, user.profile])),
);
const name = (viewer: DisplayViewer) =>
	displayUserName(profiles.get(viewer.userId), viewer.userId);
const label = $derived.by(() => {
	const list = new Intl.ListFormat(locale, { type: "conjunction" });
	const controlling = others.filter((viewer) => viewer.control);
	const watching = others.filter((viewer) => !viewer.control);
	return [
		controlling.length
			? m.display_controlling(
					{ names: list.format(controlling.map(name)) },
					{ locale },
				)
			: "",
		watching.length
			? m.display_watching(
					{ names: list.format(watching.map(name)) },
					{ locale },
				)
			: "",
	]
		.filter(Boolean)
		.join(" · ");
});
</script>

{#if others.length > 0}
	<span class="display-viewers" role="img" aria-label={label} title={label}>
		{#each others.slice(0, limit) as viewer (viewer.userId)}
			<span class="display-viewer" class:is-control={viewer.control}>
				<UserAvatar size="xxs" name={name(viewer)} avatarUrl={profiles.get(viewer.userId)?.avatarUrl ?? null} />
			</span>
		{/each}
		{#if others.length > limit}<span class="display-viewers-more">+{others.length - limit}</span>{/if}
	</span>
{/if}

<style>
	.display-viewers {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
	}
	.display-viewer {
		display: inline-flex;
		border-radius: 999px;
		box-shadow: 0 0 0 1.5px var(--bg-elevated);
	}
	.display-viewer + .display-viewer {
		margin-left: -4px;
	}
	.display-viewer.is-control {
		box-shadow:
			0 0 0 1.5px var(--bg-elevated),
			0 0 0 3px var(--brand);
	}
	.display-viewers-more {
		margin-left: 4px;
		color: var(--text-tertiary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
</style>
