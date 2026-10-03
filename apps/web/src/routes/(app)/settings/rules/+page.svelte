<script lang="ts">
import { CONFIG_SPACE_SLUG } from "@cohub/protocol/public-identifiers";
import { HttpError, type SpaceRecord } from "@neta-art/cohub";
import {
	ArrowUpRight,
	CheckCircle2,
	FileText,
	Loader2,
	Plus,
	RefreshCw,
	ShieldAlert,
} from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { ensureAuth } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import { formatDateTime } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";

const currentPath = $derived(page.url.pathname);
const currentSearch = $derived(page.url.search);

const locale = $derived(getLocale());

let rulesContent = $state("");
let updatedAt = $state<string | null>(null);
let configSpace = $state<SpaceRecord | null>(null);
let isLoading = $state(true);
let isCreating = $state(false);
let loadError = $state("");
let actionMessage = $state("");
let actionError = $state(false);

const hasPublishedRules = $derived(rulesContent.trim().length > 0);

function formatUpdatedAt(value: string | null) {
	if (!value) return m.rules_not_published_yet({}, { locale });
	const date = new Date(value);
	// Keep the raw value when parsing fails instead of silently dropping data.
	if (Number.isNaN(date.getTime())) return value;
	return formatDateTime(date, locale, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

async function findConfigSpace() {
	try {
		return await sdk.spaces.getOwnedBySlug(CONFIG_SPACE_SLUG);
	} catch (error) {
		if (error instanceof HttpError && error.status === 404) return null;
		throw error;
	}
}

async function loadRulesPage() {
	if (!(await ensureAuth({ redirectPath: `${currentPath}${currentSearch}` })))
		return;
	isLoading = true;
	loadError = "";
	actionMessage = "";
	actionError = false;
	try {
		const [rules, space] = await Promise.all([
			sdk.user.getRules(),
			findConfigSpace(),
		]);
		rulesContent = rules.content;
		updatedAt = rules.updatedAt;
		configSpace = space;
		cacheSpaceRecordSoon(configSpace);
	} catch (error) {
		if (
			await handleUnauthorizedError(error, `${currentPath}${currentSearch}`)
		) {
			return;
		}
		loadError =
			error instanceof Error
				? error.message
				: m.rules_load_failed({}, { locale });
	} finally {
		isLoading = false;
	}
}

async function createConfigSpace() {
	if (isCreating) return;
	isCreating = true;
	actionMessage = "";
	actionError = false;
	try {
		const result = await sdk.spaces.create({
			name: "config",
			slug: CONFIG_SPACE_SLUG,
			description:
				"Personal Cohub configuration. Edit AGENTS.md here, then create a Save to publish user rules.",
		});
		cacheSpaceRecordSoon(result.space);
		configSpace = result.space;
		actionMessage = m.rules_config_created({}, { locale });
		actionError = false;
		await goto(buildSpaceLandingRoute(result.space.id));
	} catch (error) {
		if (
			await handleUnauthorizedError(error, `${currentPath}${currentSearch}`)
		) {
			return;
		}
		if (billingConversion.handleHttpError(error)) return;
		actionMessage =
			error instanceof Error
				? error.message
				: m.rules_create_config_failed({}, { locale });
		actionError = true;
	} finally {
		isCreating = false;
	}
}

function openConfigSpace() {
	if (!configSpace) return;
	void goto(buildSpaceLandingRoute(configSpace.id));
}

onMount(() => {
	void loadRulesPage();
});
</script>

<svelte:head>
	<title>{m.page_title_rules({}, { locale })} — Cohub</title>
</svelte:head>

<div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
  <div class="flex-1 p-6 overflow-y-auto">
    <section class="max-w-3xl">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 class="text-[18px] font-semibold text-text-primary tracking-tight">{m.page_title_rules({}, { locale })}</h1>
          <p class="mt-1 text-[13px] text-text-tertiary max-w-2xl leading-5">
            {m.rules_description({ config: "config" }, { locale })}
          </p>
          <ol class="mt-2 space-y-1 text-[13px] text-text-tertiary max-w-2xl leading-5">
            <li><span class="font-medium text-text-secondary">1.</span> {m.rules_step1({ config: "config" }, { locale })}</li>
            <li><span class="font-medium text-text-secondary">2.</span> {m.rules_step2({ file: "AGENTS.md" }, { locale })}</li>
            <li><span class="font-medium text-text-secondary">3.</span> {m.rules_step3({}, { locale })}</li>
          </ol>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onclick={loadRulesPage}
            class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] border border-border-subtle bg-bg-surface text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
            disabled={isLoading || isCreating}
          >
            <RefreshCw class="w-3.5 h-3.5" />
            {m.rules_refresh({}, { locale })}
          </button>
          {#if configSpace}
            <button
              type="button"
              onclick={openConfigSpace}
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] bg-brand-muted border border-brand-border text-brand text-[12px] font-medium hover:bg-brand-muted-hover transition-colors"
            >
              <ArrowUpRight class="w-3.5 h-3.5" />
              {m.rules_open_config({}, { locale })}
            </button>
          {:else}
            <button
              type="button"
              onclick={createConfigSpace}
              class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] bg-brand-muted border border-brand-border text-brand text-[12px] font-medium hover:bg-brand-muted-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isLoading || isCreating}
            >
              {#if isCreating}
                <Loader2 class="w-3.5 h-3.5 animate-spin" />
              {:else}
                <Plus class="w-3.5 h-3.5" />
              {/if}
              {m.rules_create_config({}, { locale })}
            </button>
          {/if}
        </div>
      </div>

      <div class="mt-5 rounded-md border border-warning-bg bg-warning-bg p-3 flex gap-2.5">
        <ShieldAlert class="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <p class="text-[12px] leading-5 text-text-tertiary">
          {m.rules_warning({}, { locale })}
        </p>
      </div>

      {#if loadError}
        <div class="mt-6 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{loadError}</div>
      {:else if isLoading}
        <div class="mt-6 space-y-3" aria-hidden="true">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="h-16 rounded-md bg-bg-hover-strong"></div>
            <div class="h-16 rounded-md bg-bg-hover-strong"></div>
            <div class="h-16 rounded-md bg-bg-hover-strong"></div>
          </div>
          <div class="h-40 rounded-md bg-bg-hover-strong"></div>
        </div>
      {:else}
        <div class="mt-6 grid gap-3 sm:grid-cols-3">
          <div class="rounded-md border border-border-subtle bg-bg-surface p-3">
            <div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">{m.rules_config_space_label({}, { locale })}</div>
            <div class="mt-2 flex items-center gap-2 text-[13px] text-text-primary">
              {#if configSpace}
                <CheckCircle2 class="w-4 h-4 text-status-running" />
                <span class="font-medium">{m.rules_ready({}, { locale })}</span>
              {:else}
                <FileText class="w-4 h-4 text-text-placeholder" />
                <span class="font-medium">{m.rules_not_created({}, { locale })}</span>
              {/if}
            </div>
          </div>
          <div class="rounded-md border border-border-subtle bg-bg-surface p-3">
            <div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">{m.rules_published_file({}, { locale })}</div>
            <div class="mt-2 text-[13px] text-text-primary font-mono truncate">/configs/user/AGENTS.md</div>
          </div>
          <div class="rounded-md border border-border-subtle bg-bg-surface p-3">
            <div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">{m.rules_updated({}, { locale })}</div>
            <div class="mt-2 text-[13px] text-text-primary truncate">{formatUpdatedAt(updatedAt)}</div>
          </div>
        </div>

        {#if actionMessage}
          <div class={actionError ? "mt-3 text-[12px] text-error-soft" : "mt-3 text-[12px] text-status-running"}>{actionMessage}</div>
        {/if}

        <div class="mt-6 rounded-md border border-border-subtle bg-bg-surface overflow-hidden">
          <div class="flex items-center justify-between gap-3 px-3 py-2 border-b border-border-subtle bg-bg-header-alt">
            <div class="text-[12px] font-medium text-text-secondary">{m.rules_preview({}, { locale })}</div>
            <div class="text-[11px] text-text-tertiary">{m.rules_read_only({}, { locale })}</div>
          </div>
          {#if hasPublishedRules}
            <pre class="max-h-[520px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-text-primary">{rulesContent}</pre>
          {:else}
            <div class="p-8 text-center">
              <div class="mx-auto w-11 h-11 rounded-md bg-bg-hover border border-border-subtle flex items-center justify-center mb-3">
                <FileText class="w-5 h-5 text-text-placeholder" />
              </div>
              <p class="text-[14px] text-text-tertiary">{m.rules_no_published({}, { locale })}</p>
              <p class="text-[12px] text-text-placeholder mt-1 max-w-md mx-auto">
                {#if configSpace}
                  {m.rules_no_published_hint_config({}, { locale })}
                {:else}
                  {m.rules_no_published_hint_create({}, { locale })}
                {/if}
              </p>
            </div>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</div>
