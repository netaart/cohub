<script lang="ts">
import type { CronJobRecord } from "@neta-art/cohub";
import { Clock, Clock3, Pencil, Power, PowerOff, Trash2 } from "lucide-svelte";
import { untrack } from "svelte";
import { m } from "$messages";
import { asRecord } from "$kit/core";
import { cronjobPromptMeta, formatCronjobPrompt } from "$kit/cronjob";
import { displaySafeJson } from "$kit/task-run";
import { formatDateTime, formatShortDateTime } from "$kit/time";
import { client } from "../../shared/src/client";
import { getLocale } from "../../shared/src/runtime.svelte";
import { scheduleStatus } from "../../shared/src/status";
import Button from "../../shared/src/ui/Button.svelte";
import { cardClass, eyebrowClass, labelClass } from "../../shared/src/ui/classes";
import CopyButton from "../../shared/src/ui/CopyButton.svelte";
import { feedback } from "../../shared/src/ui/feedback.svelte";
import StatusBadge from "../../shared/src/ui/StatusBadge.svelte";
import type { ViewProps } from "../../shared/src/view-types";
import { previewCron } from "./cron";
import ScheduleForm, {
  type ScheduleFields,
  type ScheduleSubmission,
} from "./ScheduleForm.svelte";
import ScheduleRuns from "./ScheduleRuns.svelte";

let { target, spaceId, detail, busy, draft, action, authorize, updateDraft, setDetail, openDetail, back, removed, navigateRelated }: ViewProps = $props();

const locale = $derived(getLocale());
const job = $derived(detail?.kind === "cronjob" ? detail.data : null);
const creating = untrack(() => target.id === "new");
const sendsMessage = $derived(!job || job.taskType === "send_message");
const status = $derived(job ? scheduleStatus(job.enabled, locale) : null);
let editing = $state(untrack(() => draft !== null));
let nextRuns = $state<Date[]>([]);

function initialValues(): ScheduleFields & { prompt?: string } {
  const text = (key: string) => (typeof draft?.[key] === "string" ? (draft[key] as string) : null);
  const notifyOnSuccess = draft?.notifyOnSuccess === undefined ? job?.payload.notifyOnSuccess : draft.notifyOnSuccess;
  if (notifyOnSuccess !== undefined && typeof notifyOnSuccess !== "boolean") throw new Error("notifyOnSuccess must be a boolean");
  return {
    title: text("title") ?? job?.title ?? "",
    cronExpression: text("cronExpression") ?? job?.cronExpression ?? "0 9 * * *",
    timezone: text("timezone") ?? job?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    notifyOnSuccess: notifyOnSuccess ?? true,
    ...(job ? {} : { prompt: text("prompt") ?? "" }),
  };
}

$effect(() => {
  if (!job) return;
  const { cronExpression, timezone } = job;
  let current = true;
  void previewCron(cronExpression, timezone).then((preview) => {
    if (current) nextRuns = preview.ok ? preview.runs : [];
  });
  return () => {
    current = false;
  };
});

function show(next: CronJobRecord) {
  setDetail({ kind: "cronjob", data: { ...job, ...next, userProfile: next.userProfile ?? job?.userProfile } as CronJobRecord });
}

async function save(values: ScheduleSubmission) {
  if (creating) {
    let createdId: string | null = null;
    const saved = await action(["cronjob.manage", "session.prompt.fullaccess"], async () => {
      const result = await client.space(spaceId).prompt({
        title: values.title,
        content: [{ type: "text", text: values.prompt }],
        schedule: { mode: "repeat", cronExpression: values.cronExpression, timezone: values.timezone, notifyOnSuccess: values.notifyOnSuccess },
      });
      if (result.mode !== "repeat") throw new Error("Expected a scheduled prompt");
      updateDraft(null);
      createdId = result.cronJobId;
    });
    if (saved && createdId) openDetail(createdId);
    return;
  }
  const current = job;
  if (!current) return;
  const saved = await action(["cronjob.manage"], async () => {
    // App sessions may not rewrite payloads; the prompt is read-only here.
    const { job: next } = await client.cronJobs.update(current.id, {
      title: values.title,
      cronExpression: values.cronExpression,
      timezone: values.timezone,
      ...(sendsMessage ? { notifyOnSuccess: values.notifyOnSuccess } : {}),
    });
    updateDraft(null);
    show(next);
  });
  if (saved) {
    editing = false;
    feedback.notify(m.resource_app_saved({}, { locale }));
  }
}

function cancel() {
  updateDraft(null);
  if (creating) back();
  else editing = false;
}

async function toggle() {
  const current = job;
  if (!current) return;
  await action(["cronjob.manage"], async () => {
    show((await client.cronJobs.toggle(current.id, !current.enabled)).job);
  });
}

async function remove() {
  const current = job;
  if (!current) return;
  const confirmed = await feedback.ask({
    title: m.resource_app_delete_schedule_title({}, { locale }),
    message: m.resource_app_delete_schedule_message({ title: current.title }, { locale }),
    confirmLabel: m.cron_delete({}, { locale }),
    cancelLabel: m.cron_cancel({}, { locale }),
    danger: true,
  });
  if (!confirmed) return;
  const deleted = await action(["cronjob.manage"], () => client.cronJobs.delete(current.id).then(() => {}));
  if (deleted) removed(m.resource_app_deleted({}, { locale }));
}

function payloadField(key: string) {
  const value = asRecord(job?.payload)?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}
</script>

{#if creating}
  <article class="space-y-6 px-4 py-5 sm:px-6">
    <header class="border-b border-border-subtle/70 pb-5">
      <div class={eyebrowClass}>{m.cron_scheduled_prompt({}, { locale })}</div>
      <h1 class="mt-2 text-[24px] font-semibold tracking-tight text-text-primary sm:text-[28px]">{m.cron_new_scheduled({}, { locale })}</h1>
      <p class="mt-2 max-w-2xl text-[13px] leading-6 text-text-tertiary">{m.resource_app_empty_schedules_hint({}, { locale })}</p>
    </header>
    <ScheduleForm mode="create" initial={initialValues()} {busy} onchange={(fields, prompt) => updateDraft({ ...fields, prompt })} onsubmit={save} oncancel={cancel} />
  </article>
{:else if job && status}
  <article class="space-y-6 px-4 py-5 sm:space-y-8 sm:px-6">
    <header class="flex flex-col gap-4 border-b border-border-subtle/70 pb-5 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0 space-y-3">
        <h1 class="text-[24px] font-semibold tracking-tight break-words text-text-primary sm:text-[28px]">{job.title}</h1>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StatusBadge tone={status.tone} label={status.label} />
          {#if job.userProfile?.displayName}<span class="text-[11px] text-text-tertiary">{job.userProfile.displayName}</span>{/if}
          <CopyButton value={job.id} label={m.cron_copy_id({}, { locale })} />
        </div>
      </div>
      {#if !editing}
        <div class="grid shrink-0 auto-cols-fr grid-flow-col gap-2 sm:flex sm:flex-wrap">
          {#if sendsMessage}<Button icon={Pencil} block disabled={busy} onclick={() => (editing = true)}>{m.common_edit({}, { locale })}</Button>{/if}
          <Button icon={job.enabled ? PowerOff : Power} block disabled={busy} onclick={toggle}>{job.enabled ? m.cron_pause({}, { locale }) : m.cron_resume({}, { locale })}</Button>
          <Button variant="danger" icon={Trash2} block disabled={busy} onclick={remove}>{m.cron_delete({}, { locale })}</Button>
        </div>
      {/if}
    </header>

    {#if editing}
      <ScheduleForm mode="edit" initial={initialValues()} readonlyPrompt={formatCronjobPrompt(job.payload)} showNotifications={sendsMessage} {busy} onchange={(fields) => updateDraft(fields)} onsubmit={save} oncancel={cancel} />
    {:else}
      <section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px] lg:gap-8">
        <div class="min-w-0 space-y-6">
          {#if sendsMessage}
            <section class="space-y-3">
              <div>
                <h2 class={eyebrowClass}>{m.cron_prompt({}, { locale })}</h2>
                <p class="mt-1 text-[12px] text-text-tertiary">{cronjobPromptMeta(job.payload, locale)}</p>
              </div>
              <div class="relative overflow-hidden rounded-[8px] bg-bg-elevated/40 ring-1 ring-border-subtle/60">
                <div class="absolute top-0 left-0 h-full w-[3px] bg-brand"></div>
                <pre class="max-h-[460px] overflow-auto py-4 pr-5 pl-6 text-[13px] leading-6 whitespace-pre-wrap break-words text-text-secondary">{formatCronjobPrompt(job.payload)}</pre>
              </div>
            </section>
            <section class="grid gap-3 sm:grid-cols-2">
              <div class={cardClass}><div class={labelClass}>{m.cron_model({}, { locale })}</div><div class="mt-1 truncate text-[13px] text-text-primary">{payloadField("model") ?? m.resource_app_default_model({}, { locale })}</div></div>
              <div class={cardClass}><div class={labelClass}>{m.cron_provider({}, { locale })}</div><div class="mt-1 truncate font-mono text-[12px] text-text-secondary">{payloadField("provider") ?? "default"}</div></div>
            </section>
          {:else}
            <section class="space-y-2">
              <h2 class={eyebrowClass}>{m.cron_payload({}, { locale })}</h2>
              <pre class="max-h-[520px] overflow-auto rounded-[8px] bg-bg-elevated/35 p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-text-secondary">{displaySafeJson(job.payload, { locale })}</pre>
            </section>
          {/if}
        </div>
        <aside class="space-y-5 text-[13px]">
          <div class="space-y-3">
            <h2 class={eyebrowClass}>{m.cron_schedule({}, { locale })}</h2>
            <div>
              <div class="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-placeholder"><Clock class="h-3.5 w-3.5" />{m.cron_expression({}, { locale })}</div>
              <div class="mt-1.5 font-mono text-[15px] break-all text-text-primary">{job.cronExpression}</div>
            </div>
            <div>
              <div class="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-placeholder"><Clock3 class="h-3.5 w-3.5" />{m.cron_timezone({}, { locale })}</div>
              <div class="mt-1.5 text-text-primary">{job.timezone}</div>
            </div>
            {#if job.enabled && nextRuns.length}
              <div>
                <div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.resource_app_next_runs({}, { locale })}</div>
                <ol class="mt-1.5 space-y-0.5 font-mono text-[12px] tabular-nums text-text-secondary">
                  {#each nextRuns as run (run.getTime())}<li>{formatShortDateTime(run.toISOString(), locale, job.timezone)}</li>{/each}
                </ol>
              </div>
            {/if}
          </div>
          <div class="h-px bg-border-subtle/70"></div>
          <div class="space-y-3">
            <h2 class={eyebrowClass}>{m.cron_metadata({}, { locale })}</h2>
            <dl class="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px]">
              <dt class="text-text-placeholder">{m.cron_type({}, { locale })}</dt><dd class="font-mono break-all text-text-secondary">{job.taskType}</dd>
              <dt class="text-text-placeholder">{m.cron_session({}, { locale })}</dt>
              <dd class="min-w-0">{#if job.sessionId}<button type="button" class="font-mono break-all text-text-secondary transition-colors hover:text-brand" onclick={() => navigateRelated({ kind: "session", spaceId, sessionId: job.sessionId! })}>{job.sessionId.slice(0, 8)}</button>{:else}<span class="text-text-secondary">{m.cron_new_session_on_run({}, { locale })}</span>{/if}</dd>
              <dt class="text-text-placeholder">{m.cron_created({}, { locale })}</dt><dd class="text-text-secondary">{formatDateTime(job.createdAt, locale)}</dd>
              <dt class="text-text-placeholder">{m.cron_updated({}, { locale })}</dt><dd class="text-text-secondary">{formatDateTime(job.updatedAt, locale)}</dd>
            </dl>
          </div>
        </aside>
      </section>
    {/if}

    <ScheduleRuns {spaceId} jobId={job.id} {authorize} {navigateRelated} />
  </article>
{/if}
