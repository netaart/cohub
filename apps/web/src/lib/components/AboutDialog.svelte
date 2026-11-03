<script lang="ts">
import { ArrowUpRight, Check, Copy } from "lucide-svelte";
import { aboutReport } from "$lib/about";
import Dialog from "$lib/components/Dialog.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { BUILD_LABEL, LICENSE, REPO_URL, repoFileUrl } from "$lib/project";

const { open, onClose }: { open: boolean; onClose: () => void } = $props();

const locale = $derived(getLocale());
let copied = $state(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
	try {
		await navigator.clipboard.writeText(aboutReport());
	} catch {
		return;
	}
	copied = true;
	clearTimeout(copiedTimer);
	copiedTimer = setTimeout(() => {
		copied = false;
	}, 2000);
}

$effect(() => () => clearTimeout(copiedTimer));
</script>

<Dialog {open} {onClose} title={m.about_title({}, { locale })} maxWidth="400px">
	<div class="px-5 pt-4 pb-5">
		<div class="flex items-center gap-3">
			<img src="/favicon.svg" alt="" class="h-10 w-10 shrink-0" />
			<div class="min-w-0">
				<div class="text-[15px] font-semibold text-text-primary">Cohub</div>
				<p class="text-[12px] leading-5 text-text-tertiary">{m.landing_footer_tagline({}, { locale })}</p>
			</div>
		</div>

		<dl class="mt-4 divide-y divide-border-subtle rounded-lg border border-border-subtle text-[12px]">
			<div class="flex items-center justify-between gap-3 px-3 py-2">
				<dt class="text-text-tertiary">{m.about_version({}, { locale })}</dt>
				<dd class="flex min-w-0 items-center gap-1.5">
					<code class="truncate font-mono text-text-primary">{BUILD_LABEL}</code>
					<button
						type="button"
						onclick={copy}
						class="shrink-0 rounded-[4px] p-1 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
						title={copied ? m.about_copied({}, { locale }) : m.about_copy({}, { locale })}
						aria-label={m.about_copy({}, { locale })}
					>
						{#if copied}<Check class="h-3 w-3 text-status-running" />{:else}<Copy class="h-3 w-3" />{/if}
					</button>
				</dd>
			</div>
			<div class="flex items-center justify-between gap-3 px-3 py-2">
				<dt class="text-text-tertiary">{m.help_source({}, { locale })}</dt>
				<dd><a href={REPO_URL} target="_blank" rel="noopener noreferrer" class="about-link">netaart/cohub<ArrowUpRight class="h-3 w-3" /></a></dd>
			</div>
			<div class="flex items-center justify-between gap-3 px-3 py-2">
				<dt class="text-text-tertiary">{m.about_license({}, { locale })}</dt>
				<dd><a href={repoFileUrl("LICENSE")} target="_blank" rel="noopener noreferrer" class="about-link">{LICENSE}<ArrowUpRight class="h-3 w-3" /></a></dd>
			</div>
		</dl>

		<div class="mt-3 flex gap-4 text-[12px]">
			<a href="/changelog" class="about-link" onclick={onClose}>{m.help_changelog({}, { locale })}</a>
			<a href={locale === "zh-CN" ? "/zh/docs" : "/docs"} class="about-link" onclick={onClose}>{m.sidebar_docs({}, { locale })}</a>
		</div>
	</div>
</Dialog>

<style>
	.about-link {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		color: var(--text-secondary);
		text-decoration: none;
		transition: color 120ms ease;
	}
	.about-link:hover {
		color: var(--brand);
	}
</style>
