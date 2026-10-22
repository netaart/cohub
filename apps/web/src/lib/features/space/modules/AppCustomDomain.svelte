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
import { onMount, untrack } from "svelte";
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
	/** Changes whenever the App's status, visibility or version changes. */
	revision: string;
};

type Problem = { code: string | null };

let { spaceId, appId, revision }: Props = $props();

const locale = $derived(getLocale());
let list = $state<AppDomainListResponse | null>(null);
let hostnameInput = $state("");
let busy = $state<"add" | "check" | "remove" | null>(null);
let problem = $state<Problem | null>(null);
let copied = $state<string | null>(null);

// Realtime changes that land while a list request is in flight are replayed
// on top of its (older) snapshot; removals are remembered so no late
// response can bring a removed domain back.
let listRequests = 0;
let latestListRequest = 0;
let buffered: AppDomainsChangedDetail[] = [];
const removedIds = new Set<string>();

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

/** Localized copy for an API or domain error; English diagnostics go to the console only. */
function problemText(code: string | null, record: AppDomainRecord | null) {
	const hostname = record?.hostname ?? "";
	const price = String(list?.priceUsd ?? "");
	switch (code) {
		case "domain_invalid":
			return m.app_domain_error_domain_invalid({}, { locale });
		case "domain_reserved":
			return m.app_domain_error_domain_reserved({}, { locale });
		case "domain_in_use":
			return m.app_domain_error_domain_in_use({ hostname }, { locale });
		case "app_domain_exists":
			return m.app_domain_error_app_domain_exists({}, { locale });
		case "app_not_eligible":
			return m.app_domain_not_eligible({}, { locale });
		case "ownership_not_found":
			return m.app_domain_error_ownership_not_found({}, { locale });
		case "verification_expired":
			return m.app_domain_error_verification_expired({}, { locale });
		case "insufficient_balance":
			return m.app_domain_error_insufficient_balance({ price }, { locale });
		case "dns_moved":
			return m.app_domain_error_dns_moved(
				{ hostname, target: list?.cnameTarget ?? "" },
				{ locale },
			);
		case "certificate_failed":
			return m.app_domain_error_certificate_failed({}, { locale });
		case "provider_unavailable":
			return m.app_domain_error_provider_unavailable({}, { locale });
		case "custom_domains_disabled":
			return m.app_domain_error_disabled({}, { locale });
		case "billing_unavailable":
			return m.app_domain_error_billing_unavailable({}, { locale });
		default:
			return m.app_domain_error_generic({}, { locale });
	}
}

/** Parent zone of a subdomain, whose cookies the App's pages could set. */
function parentZone(hostname: string) {
	const labels = hostname.trim().toLowerCase().split(".").filter(Boolean);
	return labels.length >= 3 ? labels.slice(1).join(".") : null;
}
const inputParent = $derived(parentZone(hostnameInput));

function toProblem(cause: unknown): Problem {
	console.warn("[custom-domain]", cause);
	return {
		code: cause instanceof HttpError ? (cause.code ?? null) : null,
	};
}

function withRecord(
	base: AppDomainListResponse,
	record: AppDomainRecord,
): AppDomainListResponse {
	if (removedIds.has(record.id)) return base;
	const current = base.domains.find((item) => item.id === record.id);
	if (current && Date.parse(current.updatedAt) > Date.parse(record.updatedAt))
		return base;
	const others = base.domains.filter((item) => item.id !== record.id);
	return { ...base, domains: [...others, record] };
}

function withoutRecord(base: AppDomainListResponse, domainId: string) {
	removedIds.add(domainId);
	return {
		...base,
		domains: base.domains.filter((item) => item.id !== domainId),
	};
}

function applyChange(
	base: AppDomainListResponse,
	change: AppDomainsChangedDetail,
) {
	if (change.domain) return withRecord(base, change.domain);
	if (change.removedDomainId)
		return withoutRecord(base, change.removedDomainId);
	return base;
}

function store(next: AppDomainListResponse) {
	list = next;
	void writeAppDomains(spaceId, appId, $state.snapshot(next));
}

/** Applies a server change now and replays it over any list still in flight. */
function applyLocal(change: AppDomainsChangedDetail) {
	if (listRequests > 0 || !list) buffered.push(change);
	if (list) store(applyChange(list, change));
}

async function refresh() {
	listRequests += 1;
	const request = ++latestListRequest;
	try {
		let next = await sdk.apps.listDomains(appId);
		// A newer request carries newer eligibility; drop this older answer.
		if (request !== latestListRequest) return;
		next = {
			...next,
			domains: next.domains.filter((item) => !removedIds.has(item.id)),
		};
		for (const change of buffered) next = applyChange(next, change);
		store(next);
	} catch (cause) {
		if (!list) problem = toProblem(cause);
	} finally {
		listRequests -= 1;
		if (listRequests === 0) buffered = [];
	}
}

async function run(
	kind: NonNullable<typeof busy>,
	action: () => Promise<void>,
) {
	busy = kind;
	problem = null;
	try {
		await action();
	} catch (cause) {
		problem = toProblem(cause);
	} finally {
		busy = null;
	}
}

function add(event: SubmitEvent) {
	event.preventDefault();
	const hostname = hostnameInput.trim();
	if (!hostname || !list) return;
	void run("add", async () => {
		const result = await sdk.apps.addDomain(appId, hostname);
		applyLocal({ spaceId, appId, domain: result.domain });
		hostnameInput = "";
	});
}

function check(record: AppDomainRecord) {
	void run("check", async () => {
		const result = await sdk.apps.checkDomain(appId, record.id);
		applyLocal({ spaceId, appId, domain: result.domain });
	});
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
		applyLocal(
			result.domain
				? { spaceId, appId, domain: result.domain }
				: { spaceId, appId, removedDomainId: record.id },
		);
	});
}

async function copy(value: string) {
	await navigator.clipboard.writeText(value);
	copied = value;
	window.setTimeout(() => {
		if (copied === value) copied = null;
	}, 1500);
}

// Reload when the App itself changes, since that can change eligibility.
$effect(() => {
	revision;
	untrack(() => void refresh());
});

onMount(() => {
	let disposed = false;
	void readAppDomains(spaceId, appId).then((cached) => {
		if (disposed || !cached || list) return;
		list = buffered.reduce(applyChange, {
			...cached,
			eligible: cached.eligible ?? false,
		});
	});
	const handleChange = (event: Event) => {
		const detail = (event as CustomEvent<AppDomainsChangedDetail>).detail;
		if (detail?.spaceId !== spaceId || detail.appId !== appId) return;
		applyLocal(detail);
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

				{#if !list.eligible && domain.status !== "removing"}
					<div class="text-[12px] leading-5 text-text-tertiary">{m.app_domain_not_eligible({}, { locale })}</div>
				{/if}
				{#if domain.error && domain.status !== "removing"}
					<div class="space-y-1 text-[12px] leading-5 {domain.status === 'failed' || domain.error.code === 'dns_moved' ? 'text-error-soft' : 'text-text-tertiary'}">
						<div class="break-words">{problemText(domain.error.code, domain)}</div>
					</div>
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
		{:else if !list.eligible}
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

		{#if problem}
			<div class="mt-3 space-y-1 rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft">
				<div class="break-words">{problemText(problem.code, domain)}</div>
			</div>
		{/if}
		{#if problem?.code === "insufficient_balance" || domain?.error?.code === "insufficient_balance"}
			<a href="/settings/billing" class="mt-2 inline-flex text-[12px] font-medium text-brand underline-offset-2 hover:underline">{m.purchase_cta_add_balance({}, { locale })}</a>
		{/if}
	</section>
{/if}
