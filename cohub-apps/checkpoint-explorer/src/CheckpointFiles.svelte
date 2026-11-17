<script lang="ts">
import type { SpaceFsFileResponse, SpaceFsTreeResponse } from "@neta-art/cohub";
import { ChevronLeft, Download, File, Folder, FolderOpen } from "lucide-svelte";
import { onMount } from "svelte";
import { m } from "$messages";
import { formatDiffBytes } from "$kit/diff.ts";
import { client } from "../../shared/src/client.ts";
import { getLocale } from "../../shared/src/runtime.svelte.ts";
import Button from "../../shared/src/ui/Button.svelte";
import CopyButton from "../../shared/src/ui/CopyButton.svelte";
import Notice from "../../shared/src/ui/Notice.svelte";

type Props = { spaceId: string; checkpointId: string };
let { spaceId, checkpointId }: Props = $props();

const locale = $derived(getLocale());
const api = $derived(client.space(spaceId).checkpoints(checkpointId));
const MAX_LINES = 5000;

let path = $state("");
let tree = $state<SpaceFsTreeResponse | null>(null);
let treeLoading = $state(false);
let treeError = $state(false);
let file = $state<SpaceFsFileResponse | null>(null);
let fileLoading = $state(false);
let fileError = $state(false);
let selected = $state<string | null>(null);
const trees = new Map<string, SpaceFsTreeResponse>();
let treeRequest = 0;
let fileRequest = 0;

const crumbs = $derived(path ? path.split("/") : []);
const entries = $derived(
  [...(tree?.entries ?? [])].sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  ),
);
const lines = $derived(file?.kind === "text" ? file.content.split("\n") : []);
const preview = $derived(
  file && file.kind !== "text" && file.url && file.mimeType?.startsWith("image/") ? file.url : null,
);

async function openDir(next: string) {
  path = next;
  const request = ++treeRequest;
  const cached = trees.get(next);
  if (cached) tree = cached;
  treeLoading = !cached;
  treeError = false;
  try {
    const result = await api.files.list(next);
    trees.set(next, result);
    if (request === treeRequest) tree = result;
  } catch {
    if (request === treeRequest && !cached) treeError = true;
  } finally {
    if (request === treeRequest) treeLoading = false;
  }
}

async function openFile(next: string) {
  selected = next;
  const request = ++fileRequest;
  fileLoading = true;
  fileError = false;
  file = null;
  try {
    const result = await api.files.read(next);
    if (result.kind === "text" && result.delivery === "url" && result.url) {
      const response = await fetch(result.url);
      if (!response.ok) throw new Error("Failed to read snapshot file");
      result.content = await response.text();
    }
    if (request === fileRequest) file = result;
  } catch {
    if (request === fileRequest) fileError = true;
  } finally {
    if (request === fileRequest) fileLoading = false;
  }
}

function closeFile() {
  fileRequest += 1;
  selected = null;
  file = null;
  fileError = false;
}

onMount(() => void openDir(""));

const rowClass =
  "flex min-h-9 w-full min-w-0 items-center gap-2 rounded-[5px] px-2 text-left text-[12px] transition-colors hover:bg-bg-hover/70 pointer-coarse:min-h-11";
</script>

<div class="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
  <nav class="min-w-0 {selected ? 'hidden lg:block' : ''}" aria-label={m.resource_app_files({}, { locale })}>
    <div class="mb-2 flex min-h-8 min-w-0 items-center gap-0.5 overflow-x-auto font-mono text-[12px] text-text-tertiary [scrollbar-width:none]">
      <button type="button" class="shrink-0 rounded px-1.5 py-1 hover:bg-bg-hover hover:text-text-primary" onclick={() => openDir("")}>/</button>
      {#each crumbs as crumb, index (index)}
        <span class="text-text-placeholder">/</span>
        <button type="button" class="shrink-0 rounded px-1.5 py-1 hover:bg-bg-hover hover:text-text-primary {index === crumbs.length - 1 ? 'text-text-primary' : ''}" onclick={() => openDir(crumbs.slice(0, index + 1).join("/"))}>{crumb}</button>
      {/each}
    </div>
    {#if treeError}
      <Notice>{m.resource_app_error({}, { locale })}</Notice>
    {:else if treeLoading}
      <div class="space-y-1.5" aria-busy="true">{#each Array(6) as _, index}<div class="h-8 animate-pulse rounded bg-bg-elevated/50" style:opacity={1 - index * 0.14}></div>{/each}</div>
    {:else}
      <ul class="space-y-px">
        {#if path}
          <li><button type="button" class="{rowClass} text-text-tertiary" onclick={() => openDir(path.split("/").slice(0, -1).join("/"))}><FolderOpen class="h-3.5 w-3.5 shrink-0" /><span>..</span></button></li>
        {/if}
        {#each entries as entry (entry.path)}
          <li>
            <button type="button" class="{rowClass} {selected === entry.path ? 'bg-bg-active text-text-primary' : 'text-text-secondary'}" onclick={() => (entry.type === "dir" ? openDir(entry.path) : openFile(entry.path))}>
              {#if entry.type === "dir"}<Folder class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />{:else}<File class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />{/if}
              <span class="min-w-0 flex-1 truncate">{entry.name}</span>
              {#if entry.type !== "dir"}<span class="shrink-0 font-mono text-[11px] tabular-nums text-text-placeholder">{formatDiffBytes(entry.size)}</span>{/if}
            </button>
          </li>
        {:else}
          <li class="px-2 py-6 text-[12px] text-text-tertiary">{m.resource_app_empty_dir({}, { locale })}</li>
        {/each}
      </ul>
    {/if}
  </nav>

  <section class="min-w-0 {selected ? '' : 'hidden lg:block'}" aria-live="polite">
    {#if selected}
      <header class="mb-2 flex min-h-8 items-center gap-2">
        <button type="button" class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary hover:bg-bg-hover hover:text-text-primary lg:hidden" aria-label={m.resource_app_back({}, { locale })} onclick={closeFile}><ChevronLeft class="h-4 w-4" /></button>
        <h2 class="min-w-0 flex-1 truncate font-mono text-[12px] text-text-primary" title={selected}>{selected}</h2>
        {#if file}
          <span class="shrink-0 font-mono text-[11px] text-text-placeholder">{formatDiffBytes(file.size)}</span>
          {#if file.kind === "text"}<CopyButton variant="action" value={file.content} label={m.copy({}, { locale })} />{/if}
          {#if file.url}<Button variant="ghost" icon={Download} href={file.url}>{m.resource_app_download({}, { locale })}</Button>{/if}
        {/if}
      </header>
      {#if fileError}
        <Notice>{m.resource_app_error({}, { locale })}</Notice>
      {:else if fileLoading || !file}
        <div class="h-64 animate-pulse rounded-[7px] bg-bg-elevated/40" aria-busy="true"></div>
      {:else if file.kind === "text"}
        <div class="flex max-h-[70dvh] overflow-auto overscroll-contain rounded-[7px] bg-bg-elevated/30 font-mono text-[12px] leading-[1.6] [scrollbar-width:thin]">
          <pre class="sticky left-0 shrink-0 bg-bg-elevated/60 px-2.5 py-2.5 text-right text-text-placeholder select-none" aria-hidden="true">{lines.slice(0, MAX_LINES).map((_, index) => index + 1).join("\n")}</pre>
          <pre class="min-w-0 flex-1 px-3 py-2.5 whitespace-pre text-text-secondary">{lines.slice(0, MAX_LINES).join("\n")}</pre>
        </div>
        {#if lines.length > MAX_LINES}<p class="mt-2 text-[11px] text-text-placeholder">{m.resource_app_truncated({}, { locale })}</p>{/if}
      {:else if preview}
        <img src={preview} alt={file.name} class="max-h-[70dvh] max-w-full rounded-[7px] bg-bg-elevated/30 object-contain" />
      {:else}
        <p class="rounded-[7px] bg-bg-elevated/30 px-3 py-6 text-center text-[12px] text-text-tertiary">{m.resource_app_binary({}, { locale })}</p>
      {/if}
    {:else}
      <p class="flex h-full min-h-48 items-center justify-center rounded-[7px] border border-dashed border-border-subtle/70 text-[12px] text-text-placeholder">{m.resource_app_pick_file({}, { locale })}</p>
    {/if}
  </section>
</div>
