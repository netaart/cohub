<script module lang="ts">
export type ScheduleFields = { title: string; cronExpression: string; timezone: string; notifyOnSuccess: boolean };
export type ScheduleSubmission = ScheduleFields & { prompt: string };
</script>

<script lang="ts">
import { Check, Plus } from "lucide-svelte";
import { untrack } from "svelte";
import { m } from "$messages";
import { formatShortDateTime } from "$kit/time";
import { getLocale } from "../../shared/src/runtime.svelte";
import Button from "../../shared/src/ui/Button.svelte";
import { cardClass, inputClass, labelClass } from "../../shared/src/ui/classes";
import Field from "../../shared/src/ui/Field.svelte";
import Notice from "../../shared/src/ui/Notice.svelte";
import { CRON_PRESETS, previewCron, type CronPreview } from "./cron";

type Props = {
  mode: "create" | "edit";
  initial: ScheduleFields & { prompt?: string };
  readonlyPrompt?: string;
  showNotifications?: boolean;
  busy: boolean;
  /** A new schedule reports its prompt so unsaved text is never lost. */
  onchange: (fields: ScheduleFields, prompt?: string) => void;
  onsubmit: (values: ScheduleSubmission) => void;
  oncancel: () => void;
};
let { mode, initial, readonlyPrompt, showNotifications = true, busy, onchange, onsubmit, oncancel }: Props = $props();

const locale = $derived(getLocale());
let title = $state(untrack(() => initial.title));
let prompt = $state(untrack(() => initial.prompt ?? ""));
let cronExpression = $state(untrack(() => initial.cronExpression));
let timezone = $state(untrack(() => initial.timezone));
let notifyOnSuccess = $state(untrack(() => initial.notifyOnSuccess));
let preview = $state<CronPreview | null>(null);
let submitted = $state(false);
let timezones = $state<string[]>([]);

const creating = untrack(() => mode === "create");
const fields: ScheduleFields = $derived({ title, cronExpression, timezone, notifyOnSuccess });
const values = $derived({ ...fields, prompt });
const previewError = $derived(
  preview && !preview.ok
    ? {
        fields: m.cron_schedule_hint,
        expression: m.resource_app_cron_invalid,
        timezone: m.resource_app_timezone_invalid,
        interval: m.resource_app_cron_too_frequent,
      }[preview.reason]({}, { locale })
    : null,
);

$effect(() => {
  const expression = cronExpression;
  const zone = timezone;
  let current = true;
  const timer = setTimeout(async () => {
    const next = await previewCron(expression, zone);
    if (current) preview = next;
  }, 150);
  return () => {
    current = false;
    clearTimeout(timer);
  };
});

function loadTimezones() {
  if (timezones.length) return;
  try {
    timezones = Intl.supportedValuesOf("timeZone");
  } catch {
    timezones = ["UTC"];
  }
}

function changed() {
  onchange(fields, creating ? prompt : undefined);
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  submitted = true;
  const checked = await previewCron(cronExpression, timezone);
  preview = checked;
  if (!title.trim() || (creating && !prompt.trim()) || !checked.ok) return;
  onsubmit({ ...fields, title: title.trim(), prompt: prompt.trim(), cronExpression: cronExpression.trim(), timezone: checked.timezone });
}

function applyPreset(expression: string) {
  cronExpression = expression;
  changed();
}

const presetLabel = {
  hourly: m.resource_app_preset_hourly,
  daily: m.resource_app_preset_daily,
  weekdays: m.resource_app_preset_weekdays,
  weekly: m.resource_app_preset_weekly,
};
</script>

<form class="space-y-6" novalidate onsubmit={submit} oninput={changed}>
  <fieldset class="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_260px]" disabled={busy}>
    <div class="min-w-0 space-y-5">
      <Field id="schedule-title" label={m.cron_title({}, { locale })} error={submitted && !title.trim() ? m.resource_app_required({}, { locale }) : null}>
        <input id="schedule-title" class={inputClass} aria-invalid={submitted && !title.trim()} maxlength="200" placeholder={m.cron_placeholder_name({}, { locale })} bind:value={title} />
      </Field>
      {#if creating}
        <Field id="schedule-prompt" label={m.cron_prompt({}, { locale })} error={submitted && !prompt.trim() ? m.resource_app_required({}, { locale }) : null}>
          <textarea id="schedule-prompt" aria-invalid={submitted && !prompt.trim()} rows="9" class="{inputClass} resize-y leading-6" placeholder={m.cron_placeholder_content({}, { locale })} bind:value={prompt}></textarea>
        </Field>
      {:else}
        <div class="space-y-1.5">
          <div class={labelClass}>{m.cron_prompt({}, { locale })}</div>
          <pre class="max-h-60 overflow-auto rounded-[6px] bg-bg-elevated/35 px-3 py-2 text-[13px] leading-6 whitespace-pre-wrap break-words text-text-secondary">{readonlyPrompt ?? prompt}</pre>
          <p class="text-[11px] leading-5 text-text-placeholder">{m.resource_app_prompt_readonly({}, { locale })}</p>
        </div>
      {/if}
    </div>

    <aside class="min-w-0 space-y-5">
      <Field id="schedule-expression" label={m.cron_schedule({}, { locale })} error={previewError} hint={m.cron_schedule_hint({}, { locale })}>
        <input id="schedule-expression" class="{inputClass} font-mono" autocomplete="off" spellcheck="false" placeholder="0 9 * * *" aria-invalid={Boolean(previewError)} aria-describedby={previewError ? "schedule-expression-error" : "schedule-expression-hint"} bind:value={cronExpression} />
      </Field>
      <div class="-mt-2 flex flex-wrap gap-1.5">
        {#each CRON_PRESETS as preset (preset.id)}
          <button type="button" class="inline-flex min-h-7 items-center rounded-full px-2.5 text-[11px] transition-colors pointer-coarse:min-h-9 {cronExpression.trim() === preset.expression ? 'bg-brand-muted text-brand' : 'bg-bg-elevated/40 text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}" onclick={() => applyPreset(preset.expression)}>{presetLabel[preset.id]({}, { locale })}</button>
        {/each}
      </div>
      <Field id="schedule-timezone" label={m.cron_timezone({}, { locale })}>
        <input id="schedule-timezone" class={inputClass} list="schedule-timezones" autocomplete="off" spellcheck="false" placeholder="UTC" bind:value={timezone} onfocus={loadTimezones} />
        <datalist id="schedule-timezones">{#each timezones as zone (zone)}<option value={zone}></option>{/each}</datalist>
      </Field>
      {#if showNotifications}
        <label class="flex min-h-11 items-start gap-3 text-text-secondary">
          <input type="checkbox" class="mt-0.5 accent-brand" checked={notifyOnSuccess} aria-describedby="schedule-notifications-hint" onchange={(event) => { notifyOnSuccess = event.currentTarget.checked; changed(); }} />
          <span class="min-w-0">
            <span class={labelClass}>{m.cron_notify_on_success({}, { locale })}</span>
            <span id="schedule-notifications-hint" class="mt-1 block text-[11px] leading-5 text-text-placeholder">{m.cron_notify_on_success_hint({}, { locale })}</span>
          </span>
        </label>
      {/if}
      {#if preview?.ok}
        <div class={cardClass}>
          <div class={labelClass}>{m.resource_app_next_runs({}, { locale })}</div>
          <ol class="mt-1.5 space-y-0.5 font-mono text-[12px] tabular-nums text-text-secondary">
            {#each preview.runs as run (run.getTime())}<li>{formatShortDateTime(run.toISOString(), locale, preview.timezone)}</li>{/each}
          </ol>
        </div>
      {/if}
    </aside>
  </fieldset>

  <div class="flex flex-col-reverse gap-2 border-t border-border-subtle/70 pt-4 sm:flex-row sm:justify-end">
    <Button variant="outline" disabled={busy} onclick={oncancel}>{m.cron_cancel({}, { locale })}</Button>
    <Button variant="primary" type="submit" icon={mode === "create" ? Plus : Check} loading={busy}>{mode === "create" ? m.cron_create({}, { locale }) : m.cron_save_changes({}, { locale })}</Button>
  </div>
</form>
