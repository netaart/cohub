<script lang="ts">
import {
	type AppDomainListResponse,
	type AppDomainRecord,
	type AppDomainStatus,
	HttpError,
} from "@neta-art/cohub";
import {
	Check,
	Copy,
	ExternalLink,
	Globe,
	Loader2,
	RefreshCw,
	Trash2,
} from "lucide-svelte";
import { onMount } from "svelte";
import {
	readAppDomains,
	writeAppDomains,
} from "$lib/cache/repositories/app-domains-repo";
import {
	APP_DOMAINS_CHANGED_EVENT,
	type AppDomainsChangedDetail,
} from "$lib/features/app/app-realtime";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";

type Props = {
	spaceId: string;
	appId: string;
	/** Published, public, web or port: the server enforces the same rule. */
	eligible: boolean;
};

let { spaceId, appId, eligible }: Props = $props();

const locale = $derived(getLocale());
let list = $state<AppDomainListResponse | null>(null);
let hostnameInput = $state("");
let busy = $state<"add" | "check" | "remove" | null>(null);
let error = $state<{ message: string; code: string | null } | null>(null);
let copied = $state<string | null>(null);

const domain = $derived(list?.domains[0] ?? null);
const visible = $derived(Boolean(list && (list.enabled || domain)));
const statusLabel: Record<AppDomainStatus, () => string> = {
	pending: () => m.app_domain_status_pending({}, { locale }),
	provisioning: () => m.app_domain_status_provisioning({}, { locale }),
	active: () => m.app_domain_status_active({}, { locale }),
	failed: () => m.app_domain_status_failed({}, { locale }),
	removing: () => m.app_domain_status_removing({}, { locale }),
};
const statusTone: Record<AppDomainStatus, string> = {
	pending: "attention",
	provisioning: "activity",
	active: "success",
	failed: "error",
	removing: "muted",
};

/** Parent zone of a subdomain, whose cookies the App's pages could set. */
function parentZone(hostname: string) {
	const labels = hostname.trim().toLowerCase().split(".").filter(Boolean);
	return labels.length >= 3 ? labels.slice(1).join(".") : null;
}
const inputParent = $derived(parentZone(hostnameInput));

function toError(cause: unknown) {
	return {
		message: cause instanceof Error ? cause.message : String(cause),
		code: cause instanceof HttpError ? (cause.code ?? null) : null,
	};
}

function store(next: AppDomainListResponse) {
	list = next;
	void writeAppDomains(spaceId, appId, $state.snapshot(next));
}

function upsert(record: AppDomainRecord) {
	if (!list) return;
	const others = list.domains.filter((item) => item.id !== record.id);
	store({ ...list, domains: [...others, record] });
}

async function refresh() {
	try {
		store(await sdk.apps.listDomains(appId));
	} catch (cause) {
		if (!list) error = toError(cause);
	}
}

async function run(
	kind: NonNullable<typeof busy>,
	action: () => Promise<void>,
) {
	busy = kind;
	error = null;
	try {
		await action();
	} catch (cause) {
		error = toError(cause);
	} finally {
		busy = null;
	}
}

function add(event: SubmitEvent) {
	event.preventDefault();
	const hostname = hostnameInput.trim();
	if (!hostname) return;
	void run("add", async () => {
		const result = await sdk.apps.addDomain(appId, hostname);
		upsert(result.domain);
		hostnameInput = "";
	});
}

function check(record: AppDomainRecord) {
	void run("check", async () =>
		upsert((await sdk.apps.checkDomain(appId, record.id)).domain),
	);
}

function remove(record: AppDomainRecord) {
	if (
		!confirm(
			m.app_domain_remove_confirm({ hostname: record.hostname }, { locale }),
		)
	)
		return;
	void run("remove", async () => {
		const result = await sdk.apps.removeDomain(appId, record.id);
		if (result.domain) upsert(result.domain);
		else if (list)
			store({
				...list,
				domains: list.domains.filter((item) => item.id !== record.id),
			});
	});
}

async function copy(value: string) {
	await navigator.clipboard.writeText(value);
	copied = value;
	window.setTimeout(() => {
		if (copied === value) copied = null;
	}, 1500);
}

onMount(() => {
	let disposed = false;
	void readAppDomains(spaceId, appId).then((cached) => {
		if (!disposed && cached && !list) list = cached;
	});
	void refresh();
	const handleChange = (event: Event) => {
		const detail = (event as CustomEvent<AppDomainsChangedDetail>).detail;
		if (detail?.spaceId !== spaceId || detail.appId !== appId || !list) return;
		if (detail.domain) upsert(detail.domain);
		else if (detail.removedDomainId)
			store({
				...list,
				domains: list.domains.filter(
					(item) => item.id !== detail.removedDomainId,
				),
			});
	};
	window.addEventListener(APP_DOMAINS_CHANGED_EVENT, handleChange);
	return () => {
		disposed = true;
		window.removeEventListener(APP_DOMAINS_CHANGED_EVENT, handleChange);
	};
});
</script>

{#snippet copyButton(value: string)}
	<button type="button" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={() => void copy(value)} title={m.app_domain_copy({}, { locale })} aria-label={m.app_domain_copy({}, { locale })}>
		{#if copied === value}<Check class="h-3.5 w-3.5 text-success-soft" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
	</button>
{/snippet}

{#if visible && list}
	<section class="border-b border-border-subtle/70 pb-5" aria-labelledby="app-domain-heading">
		<div class="mb-4 flex items-center gap-2">
			<Globe class="h-3.5 w-3.5 text-text-tertiary" />
			<h2 id="app-domain-heading" class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">{m.app_domain_title({}, { locale })}</h2>
		</div>

		{#if domain}
			<div class="space-y-4">
				<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div class="flex min-w-0 items-center gap-2.5">
						{#if domain.status === "active"}
							<a href={domain.url} target="_blank" rel="noopener" class="inline-flex min-w-0 items-center gap-1.5 font-mono text-[13px] text-text-primary transition-colors hover:text-brand">
								<span class="truncate">{domain.hostname}</span>
								<ExternalLink class="h-3.5 w-3.5 shrink-0" />
							</a>
						{:else}
							<span class="truncate font-mono text-[13px] text-text-primary">{domain.hostname}</span>
						{/if}
						<span class="tag shrink-0 font-medium" data-tone={statusTone[domain.status]}>{statusLabel[domain.status]()}</span>
					</div>
					<div class="flex shrink-0 gap-2">
						{#if domain.status !== "removing"}
							<button type="button" class="inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-[5px] bg-bg-elevated px-2.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 sm:flex-none" onclick={() => check(domain)} disabled={busy !== null}>
								{#if busy === "check"}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<RefreshCw class="h-3.5 w-3.5" />{/if}
								<span>{m.app_domain_check({}, { locale })}</span>
							</button>
						{/if}
						<button type="button" class="inline-flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-[5px] px-2.5 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-50 sm:flex-none" onclick={() => remove(domain)} disabled={busy !== null || (domain.status === "removing")}>
							{#if busy === "remove"}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
							<span>{m.app_domain_remove({}, { locale })}</span>
						</button>
					</div>
				</div>

				{#if domain.error && domain.status !== "removing"}
					<div class="break-words text-[12px] leading-5 {domain.status === 'failed' || domain.error.code === 'dns_moved' ? 'text-error-soft' : 'text-text-tertiary'}">{domain.error.message}</div>
				{/if}

				{#if domain.status === "pending" || domain.status === "provisioning" || domain.status === "failed"}
					<div class="space-y-2">
						<div class="text-[11px] leading-5 text-text-tertiary">{m.app_domain_dns_hint({}, { locale })}</div>
						<div class="divide-y divide-border-subtle/60 border-y border-border-subtle/60">
							{#each domain.dnsRecords as record (record.type)}
								<div class="grid gap-1.5 py-2.5 text-[12px] sm:grid-cols-[64px_minmax(0,1fr)_minmax(0,1fr)] sm:items-center sm:gap-3">
									<div class="flex items-center gap-1.5 font-mono text-text-secondary">
										{#if record.satisfied}<Check class="h-3.5 w-3.5 text-success-soft" />{/if}
										<span>{record.type}</span>
									</div>
									<div class="flex min-w-0 items-center gap-1">
										<span class="min-w-0 flex-1 break-all font-mono text-text-primary" title={m.app_domain_record_name({}, { locale })}>{record.name}</span>
										{@render copyButton(record.name)}
									</div>
									<div class="flex min-w-0 items-center gap-1">
										<span class="min-w-0 flex-1 break-all font-mono text-text-secondary" title={m.app_domain_record_value({}, { locale })}>{record.value}</span>
										{@render copyButton(record.value)}
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		{:else if !eligible}
			<div class="text-[12px] text-text-placeholder">{m.app_domain_not_eligible({}, { locale })}</div>
		{:else}
			<form class="space-y-2" onsubmit={add}>
				<div class="flex flex-col gap-2 sm:flex-row">
					<input
						bind:value={hostnameInput}
						required
						maxlength="253"
						inputmode="url"
						autocapitalize="off"
						autocomplete="off"
						spellcheck="false"
						placeholder="app.example.com"
						aria-label={m.app_domain_title({}, { locale })}
						class="min-w-0 flex-1 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[12px] text-text-primary focus:border-brand/50 focus:outline-none"
					/>
					<button type="submit" disabled={busy !== null || !hostnameInput.trim()} class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[5px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50">
						{#if busy === "add"}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
						<span>{m.app_domain_add({ price: String(list.priceUsd) }, { locale })}</span>
					</button>
				</div>
				<div class="text-[11px] leading-5 text-text-placeholder">{m.app_domain_price_note({}, { locale })}</div>
				{#if inputParent}
					<div class="text-[11px] leading-5 text-text-tertiary">{m.app_domain_subdomain_warning({ hostname: hostnameInput.trim().toLowerCase(), parent: inputParent }, { locale })}</div>
				{/if}
			</form>
		{/if}

		{#if error}
			<div class="mt-3 break-words rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft">{error.message}</div>
		{/if}
		{#if error?.code === "insufficient_balance" || domain?.error?.code === "insufficient_balance"}
			<a href="/settings/billing" class="mt-2 inline-flex text-[12px] font-medium text-brand underline-offset-2 hover:underline">{m.purchase_cta_add_balance({}, { locale })}</a>
		{/if}
	</section>
{/if}
