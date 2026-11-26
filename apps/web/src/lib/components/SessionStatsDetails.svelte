<script lang="ts">
import { readSessionStats, type SessionStats } from "@cohub/protocol/model";
import type { SessionRecord, SessionTurnRecord } from "@neta-art/cohub";
import { ChevronDown } from "lucide-svelte";
import { onMount } from "svelte";
import {
	type SessionTurnsSnapshot,
	sessionTurnsRepo,
} from "#lib/cache/repositories/session-turns-repo.ts";
import StatsContent from "#lib/components/StatsContent.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";
import { buildSessionTimeline } from "#lib/stats-view-model.ts";
import { sessionStore } from "#lib/stores/session-store.ts";

let { session }: { session: SessionRecord } = $props();
const locale = $derived(getLocale());
let fresh = $state<SessionStats | null>(null);
let loading = $state(false);
let failed = $state(false);
let turns = $state.raw<SessionTurnRecord[]>([]);
const timeline = $derived(
	buildSessionTimeline(
		turns.filter((turn) => (turn.sourceSessionId ?? session.id) === session.id),
		locale,
	),
);
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
const tail = (snapshot: SessionTurnsSnapshot) =>
	snapshot.hasMoreNewer ? [] : snapshot.turns;
onMount(() => {
	void refresh();
	const { spaceId, id } = session;
	let live = false;
	const unsubscribe = sessionTurnsRepo.subscribe(spaceId, id, (snapshot) => {
		live = true;
		turns = tail(snapshot);
	});
	void sessionTurnsRepo.getCached(spaceId, id).then((snapshot) => {
		if (snapshot && !live) turns = tail(snapshot);
	});
	return () => {
		request?.abort();
		unsubscribe();
	};
});
</script>

{#if stats}
  <StatsContent stats={stats.own} scope="session" {timeline} />
  {#if stats.inherited.turns || stats.inherited.compactions}
    <details class="group mt-4 border-t border-border-subtle pt-3">
      <summary class="flex cursor-pointer list-none items-center justify-between gap-3 text-[11px] text-text-secondary marker:hidden">
        <span class="inline-flex items-center gap-1 font-medium"><ChevronDown aria-hidden="true" class="h-3 w-3 -rotate-90 transition-transform group-open:rotate-0" />{m.stats_inherited({}, { locale })}</span>
        {#if stats.inherited.turns}<span class="shrink-0 tabular-nums text-text-placeholder">{m.stats_turns({}, { locale })} {stats.inherited.turns.toLocaleString(locale)}</span>{/if}
      </summary>
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
