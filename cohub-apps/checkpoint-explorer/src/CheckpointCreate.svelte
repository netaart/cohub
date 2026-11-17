<script lang="ts">
import type { CheckpointDiffFileResponse, SpacePendingDiffSummary } from "@neta-art/cohub";
import { ListTodo, Save } from "lucide-svelte";
import { onDestroy, untrack } from "svelte";
import { m } from "$messages";
import CheckpointDiffPanel from "$kit/CheckpointDiffPanel.svelte";
import { statusCode } from "../../shared/src/access.ts";
import { client } from "../../shared/src/client.ts";
import { getLocale, runtime } from "../../shared/src/runtime.svelte.ts";
import Button from "../../shared/src/ui/Button.svelte";
import { inputClass } from "../../shared/src/ui/classes.ts";
import Field from "../../shared/src/ui/Field.svelte";
import Notice from "../../shared/src/ui/Notice.svelte";
import type { ViewProps } from "../../shared/src/view-types.ts";

let { spaceId, busy, draft, action, authorize, updateDraft, navigateRelated, back }: ViewProps = $props();

const locale = $derived(getLocale());
const spaceName = $derived(
  runtime.context?.shell?.space?.id === spaceId ? runtime.context.shell.space.name : null,
);
let description = $state(untrack(() => (typeof draft?.description === "string" ? draft.description : "")));
let taskId = $state<string | null>(null);
let conflict = $state(false);
let pending = $state<SpacePendingDiffSummary | null>(null);
let pendingLoading = $state(false);
let pendingError = $state<string | null>(null);
let disposed = false;
onDestroy(() => (disposed = true));

async function loadPending() {
  if (pending || pendingLoading) return;
  pendingLoading = true;
  pendingError = null;
  try {
    if (!(await authorize(["file.view"]))) throw new Error("denied");
    const summary = await client.space(spaceId).files.diff();
    if (!disposed) pending = summary;
  } catch {
    if (!disposed) pendingError = m.cdp_unavailable({}, { locale });
  } finally {
    if (!disposed) pendingLoading = false;
  }
}

async function loadPendingFile(path: string): Promise<CheckpointDiffFileResponse | null> {
  try {
    return await client.space(spaceId).files.diffFile(path);
  } catch {
    return null;
  }
}

async function submit(event: SubmitEvent) {
  event.preventDefault();
  if (taskId) return;
  conflict = false;
  await action(["checkpoint.edit"], async () => {
    try {
      const result = await client.space(spaceId).checkpoints.create(description.trim() || null);
      updateDraft(null);
      if (!disposed) taskId = result.taskRunId;
    } catch (cause) {
      if (statusCode(cause) === 409) {
        conflict = true;
        return;
      }
      throw cause;
    }
  });
  if (taskId) void navigateRelated({ kind: "task", spaceId, taskRunId: taskId });
}
</script>

<article class="mx-auto w-full max-w-xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
  <header class="space-y-1.5">
    <div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">{m.cp_new_save({}, { locale })}</div>
    <h1 class="text-[20px] font-semibold tracking-tight text-text-primary">{m.cp_save_workspace({}, { locale })}</h1>
    <p class="text-[13px] leading-5 text-text-tertiary">{m.cp_create_save_of({}, { locale })} <span class="font-medium text-text-secondary">{spaceName ?? m.resource_app_space({}, { locale })}</span>.</p>
  </header>

  {#if taskId}
    <Notice tone="info">
      {m.resource_app_checkpoint_started({}, { locale })}
      {#snippet action()}<Button variant="ghost" icon={ListTodo} onclick={() => navigateRelated({ kind: "task", spaceId, taskRunId: taskId! })}>{m.resource_app_view_task({}, { locale })}</Button>{/snippet}
    </Notice>
  {:else}
    <form class="space-y-6" onsubmit={submit} oninput={() => updateDraft(description ? { description } : null)}>
      <Field id="checkpoint-description" label={m.cp_description({}, { locale })} optional={m.cp_optional({}, { locale })} hint={m.cp_desc_fallback_hint({}, { locale })}>
        <textarea id="checkpoint-description" rows="3" class="{inputClass} resize-y leading-5" placeholder={m.cp_what_changed_ph({}, { locale })} disabled={busy} bind:value={description}></textarea>
      </Field>

      <div class="border-t border-border-subtle/60 pt-4">
        <CheckpointDiffPanel
          {locale}
          summary={pending}
          loading={pendingLoading}
          error={pendingError}
          emptyLabel={m.cp_workspace_as_is({}, { locale })}
          collapsible
          title={m.cp_review_changes({}, { locale })}
          onExpand={loadPending}
          loadFile={loadPendingFile}
        />
      </div>

      {#if conflict}<Notice tone="info">{m.resource_app_save_in_progress({}, { locale })}</Notice>{/if}

      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" disabled={busy} onclick={() => { updateDraft(null); back(); }}>{m.common_cancel({}, { locale })}</Button>
        <Button variant="primary" type="submit" icon={Save} loading={busy}>{m.common_save({}, { locale })}</Button>
      </div>
    </form>
  {/if}
</article>
