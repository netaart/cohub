<script lang="ts">
import { readSessionStats, type SessionStats } from "@cohub/protocol/model";
import type { SessionRecord } from "@neta-art/cohub";
import { onMount } from "svelte";
import StatsContent from "$lib/components/StatsContent.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { sessionStore } from "$lib/stores/session-store";

let { session }: { session: SessionRecord } = $props();
const locale = $derived(getLocale());
let fresh = $state<SessionStats | null>(null);
let loading = $state(false);
let failed = $state(false);
const cached = $derived(readSessionStats(session.meta));
const stats = $derived(
	fresh && (!cached || fresh.revision > cached.revision) ? fresh : cached,
);
let request: AbortController | undefined;
async function refresh() {
	request?.abort();
	const controller = new AbortController();
	request = controller;
	const current = session;
	loading = true;
	failed = false;
	try {
		const localStats = readSessionStats(sessionStore.get(current.id)?.meta);
		if (localStats && (!stats || localStats.revision > stats.revision))
			fresh = localStats;
		const { stats: received } = await sdk
			.space(current.spaceId)
			.session(current.id)
			.stats({ signal: controller.signal });
		if (controller.signal.aborted || session.id !== current.id) return;
		fresh = received;
		const known = sessionStore.get(current.id) ?? current;
		sessionStore.merge({
			...known,
			meta: { ...known.meta, stats: received },
		});
	} catch {
		if (!controller.signal.aborted) failed = true;
	} finally {
		if (!controller.signal.aborted) loading = false;
	}
}
onMount(() => {
	void refresh();
	return () => request?.abort();
});
</script>

{#if stats}
  <StatsContent stats={stats.own} scope="session" />
  {#if stats.inherited.turns || stats.inherited.compactions}
    <details class="mt-3 border-t border-border-subtle pt-3">
      <summary class="cursor-pointer text-text-secondary">{m.stats_inherited({}, { locale })}</summary>
      <div class="mt-3"><StatsContent stats={stats.inherited} scope="session" /></div>
    </details>
  {/if}
{:else if loading}
  <p class="py-3 text-text-tertiary" role="status">{m.stats_loading({}, { locale })}</p>
{/if}
{#if failed}
  <div class="mt-3 flex items-center justify-between gap-2 text-[11px] text-text-tertiary">
    <span>{m.stats_unavailable({}, { locale })}</span>
    <button type="button" class="min-h-9 rounded px-2 text-text-secondary hover:bg-bg-hover disabled:opacity-50" disabled={loading} onclick={() => void refresh()}>{m.common_retry({}, { locale })}</button>
  </div>
{/if}
