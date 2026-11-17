<script lang="ts">
import { HttpError } from "@neta-art/cohub";
import {
	ArrowUpRight,
	FileText,
	Loader2,
	RefreshCw,
	ShieldAlert,
} from "lucide-svelte";
import { ensureAuth } from "#lib/auth.ts";
import { handleUnauthorizedError } from "#lib/auth-redirect.ts";
import { userTheme } from "#lib/custom-theme/user-theme.svelte.ts";
import * as account from "#lib/features/settings/account-data.ts";
import { onSettingsPageActive } from "#lib/features/settings/page-context.svelte.ts";
import { formatDateTime } from "#lib/i18n/format.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";
import { buildSpaceLandingRoute } from "#lib/space-routes.ts";
import { billingConversion } from "#lib/stores/billing-conversion.svelte.ts";
import { cacheSpaceRecordSoon } from "#lib/stores/space-record-cache.ts";
import { goto } from "$app/navigation";

const locale = $derived(getLocale());

const rulesContent = $derived(account.rules.data?.content ?? "");
const updatedAt = $derived(account.rules.data?.updatedAt ?? null);
let isOpening = $state(false);
let actionError = $state("");
const isLoading = $derived(account.rules.loading);
const loadError = $derived(
	account.rules.data
		? ""
		: account.rules.errorMessage(m.rules_load_failed({}, { locale })),
);

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

async function refresh(options?: { force?: boolean }) {
	if (await ensureAuth()) await account.rules.load(options);
}

onSettingsPageActive(() => void refresh());

async function openHomeSpace() {
	if (isOpening) return;
	isOpening = true;
	actionError = "";
	try {
		const space = await sdk.spaces.ensureHome();
		cacheSpaceRecordSoon(space);
		userTheme.setHomeSpace(space);
		await goto(buildSpaceLandingRoute(space.id));
	} catch (error) {
		if (await handleUnauthorizedError(error)) return;
		if (billingConversion.handleHttpError(error)) return;
		actionError =
			error instanceof HttpError && error.code === "home_space_name_taken"
				? m.rules_home_name_taken({}, { locale })
				: m.rules_open_home_failed({}, { locale });
	} finally {
		isOpening = false;
	}
}
</script>

<div class="flex-1 p-6">
  <section class="max-w-3xl">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 class="text-[18px] font-semibold text-text-primary tracking-tight">{m.page_title_rules({}, { locale })}</h1>
        <p class="mt-1 text-[13px] text-text-tertiary max-w-2xl leading-5">
          {m.rules_description({}, { locale })}
        </p>
        <ol class="mt-2 space-y-1 text-[13px] text-text-tertiary max-w-2xl leading-5">
          <li><span class="font-medium text-text-secondary">1.</span> {m.rules_step1({}, { locale })}</li>
          <li><span class="font-medium text-text-secondary">2.</span> {m.rules_step2({ file: "AGENTS.md" }, { locale })}</li>
          <li><span class="font-medium text-text-secondary">3.</span> {m.rules_step3({}, { locale })}</li>
        </ol>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onclick={() => void refresh({ force: true })}
          class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] border border-border-subtle bg-bg-surface text-[12px] text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors disabled:opacity-50"
          disabled={account.rules.refreshing}
        >
          <RefreshCw class="w-3.5 h-3.5" />
          {m.rules_refresh({}, { locale })}
        </button>
        <button
          type="button"
          onclick={openHomeSpace}
          disabled={isOpening}
          class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] bg-brand-muted border border-brand-border text-brand text-[12px] font-medium hover:bg-brand-muted-hover transition-colors disabled:opacity-50"
        >
          {#if isOpening}
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
          {:else}
            <ArrowUpRight class="w-3.5 h-3.5" />
          {/if}
          {m.rules_open_home({}, { locale })}
        </button>
      </div>
    </div>

    {#if actionError}
      <p role="alert" class="mt-3 text-[12px] text-error-soft">{actionError}</p>
    {/if}

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
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="h-16 rounded-md bg-bg-hover-strong"></div>
          <div class="h-16 rounded-md bg-bg-hover-strong"></div>
        </div>
        <div class="h-40 rounded-md bg-bg-hover-strong"></div>
      </div>
    {:else}
      <div class="mt-6 grid gap-3 sm:grid-cols-2">
        <div class="rounded-md border border-border-subtle bg-bg-surface p-3">
          <div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">{m.rules_published_file({}, { locale })}</div>
          <div class="mt-2 text-[13px] text-text-primary font-mono truncate">/configs/user/AGENTS.md</div>
        </div>
        <div class="rounded-md border border-border-subtle bg-bg-surface p-3">
          <div class="text-[10px] uppercase tracking-[0.14em] text-text-placeholder">{m.rules_updated({}, { locale })}</div>
          <div class="mt-2 text-[13px] text-text-primary truncate">{formatUpdatedAt(updatedAt)}</div>
        </div>
      </div>

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
              {m.rules_no_published_hint({}, { locale })}
            </p>
          </div>
        {/if}
      </div>
    {/if}
  </section>
</div>
