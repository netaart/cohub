<script module lang="ts">
import type { AppRecord, Permission } from "@neta-art/cohub";

export type AppValues = {
  slug: string;
  targetType: AppRecord["targetType"];
  targetRef: string;
  visibility: AppRecord["visibility"];
  appScopes: Permission[];
  hideCohubBar: boolean;
};
</script>

<script lang="ts">
import { Check } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { m } from "$messages";
import { APP_HIDE_COHUB_BAR_FEATURE, APP_SCOPE_OPTIONS } from "$kit/app.ts";
import { client } from "../../shared/src/client.ts";
import { getLocale } from "../../shared/src/runtime.svelte.ts";
import Button from "../../shared/src/ui/Button.svelte";
import { inputClass, labelClass } from "../../shared/src/ui/classes.ts";
import Field from "../../shared/src/ui/Field.svelte";

type Props = {
  initial: AppValues;
  busy: boolean;
  onchange: (values: AppValues) => void;
  onsubmit: (values: AppValues) => void;
  oncancel: () => void;
};
let { initial, busy, onchange, onsubmit, oncancel }: Props = $props();

const locale = $derived(getLocale());
let slug = $state(untrack(() => initial.slug));
let targetType = $state(untrack(() => initial.targetType));
let targetRef = $state(untrack(() => initial.targetRef));
let visibility = $state(untrack(() => initial.visibility));
let scopes = $state<Record<string, boolean>>(
  untrack(() => Object.fromEntries(initial.appScopes.map((scope) => [scope, true]))),
);
let hideCohubBar = $state(untrack(() => initial.hideCohubBar));
let hideCohubBarAllowed = $state<boolean | null>(null);
let submitted = $state(false);

const canToggleCohubBar = $derived(hideCohubBarAllowed === true || initial.hideCohubBar);

onMount(() => {
  client.billing
    .getFeatureEntitlement(APP_HIDE_COHUB_BAR_FEATURE)
    .then(({ enabled }) => enabled, () => false)
    .then((enabled) => (hideCohubBarAllowed = enabled));
});

const values = $derived<AppValues>({
  slug,
  targetType,
  targetRef,
  visibility,
  // Unknown scopes granted elsewhere are kept, never silently dropped.
  appScopes: [
    ...APP_SCOPE_OPTIONS.map((option) => option.scope).filter((scope) => scopes[scope]),
    ...initial.appScopes.filter((scope) => !APP_SCOPE_OPTIONS.some((option) => option.scope === scope)),
  ],
  hideCohubBar,
});

function submit(event: SubmitEvent) {
  event.preventDefault();
  submitted = true;
  if (!slug.trim() || !targetRef.trim()) return;
  onsubmit({ ...values, slug: slug.trim(), targetRef: targetRef.trim() });
}
</script>

<form class="space-y-6" novalidate onsubmit={submit} oninput={() => onchange(values)} onchange={() => onchange(values)}>
  <fieldset class="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]" disabled={busy}>
    <div class="min-w-0 space-y-5">
      <Field id="app-slug" label={m.app_publish_app_slug({}, { locale })} error={submitted && !slug.trim() ? m.resource_app_required({}, { locale }) : null}>
        <input id="app-slug" class="{inputClass} font-mono" aria-invalid={submitted && !slug.trim()} maxlength="100" autocomplete="off" spellcheck="false" bind:value={slug} />
      </Field>
      <div class="grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
        <Field id="app-target-type" label={m.resource_app_target({}, { locale })}>
          <select id="app-target-type" class={inputClass} bind:value={targetType}>
            <option value="file">{m.resource_app_target_file({}, { locale })}</option>
            <option value="directory">{m.resource_app_target_directory({}, { locale })}</option>
            <option value="port">{m.resource_app_target_port({}, { locale })}</option>
          </select>
        </Field>
        <Field id="app-target-ref" label={m.resource_app_target_ref({}, { locale })} error={submitted && !targetRef.trim() ? m.resource_app_required({}, { locale }) : null}>
          <input id="app-target-ref" class="{inputClass} font-mono" aria-invalid={submitted && !targetRef.trim()} autocomplete="off" spellcheck="false" bind:value={targetRef} />
        </Field>
      </div>
      <Field id="app-visibility" label={m.resource_app_visibility({}, { locale })} hint={visibility === "space" ? m.app_view_space_access_detail({}, { locale }) : undefined}>
        <select id="app-visibility" class={inputClass} bind:value={visibility}>
          <option value="public">{m.anyone_with_link({}, { locale })}</option>
          <option value="space">{m.app_publish_space_access({}, { locale })}</option>
        </select>
      </Field>
      <fieldset class="min-w-0 space-y-1.5">
        <legend class={labelClass}>{m.app_view_cohub_bar({}, { locale })}</legend>
        <label class="flex gap-3 rounded-[6px] bg-bg-elevated/30 px-3 py-2 text-text-secondary transition-colors hover:bg-bg-elevated/50" class:opacity-60={!canToggleCohubBar}>
          <input type="checkbox" class="mt-0.5 accent-brand" disabled={!canToggleCohubBar} bind:checked={hideCohubBar} />
          <span class="min-w-0">
            <span class="block text-[12px] text-text-primary">{m.app_publish_hide_cohub_bar({}, { locale })}</span>
            <span class="block text-[11px] leading-5 text-text-placeholder">{m.app_view_hide_footer_detail({}, { locale })}</span>
          </span>
        </label>
        {#if hideCohubBarAllowed === null}
          <p class="text-[11px] leading-5 text-text-placeholder">{m.resource_app_checking({}, { locale })}</p>
        {:else if !hideCohubBarAllowed}
          <p class="text-[11px] leading-5 text-text-placeholder">{m.app_publish_included_pro_max({}, { locale })}</p>
        {/if}
      </fieldset>
    </div>
    <fieldset class="min-w-0 space-y-2">
      <legend class={labelClass}>{m.app_publish_app_can({}, { locale })}</legend>
      {#each APP_SCOPE_OPTIONS as option (option.scope)}
        <label class="flex gap-3 rounded-[6px] bg-bg-elevated/30 px-3 py-2 text-text-secondary transition-colors hover:bg-bg-elevated/50">
          <input type="checkbox" class="mt-0.5 accent-brand" bind:checked={scopes[option.scope]} />
          <span class="min-w-0">
            <span class="block text-[12px] text-text-primary">{option.label({}, { locale })}</span>
            <span class="block text-[11px] leading-5 text-text-placeholder">{option.description({}, { locale })}</span>
          </span>
        </label>
      {/each}
    </fieldset>
  </fieldset>
  <div class="flex flex-col-reverse gap-2 border-t border-border-subtle/70 pt-4 sm:flex-row sm:justify-end">
    <Button variant="outline" disabled={busy} onclick={oncancel}>{m.common_cancel({}, { locale })}</Button>
    <Button variant="primary" type="submit" icon={Check} loading={busy}>{m.cron_save_changes({}, { locale })}</Button>
  </div>
</form>
