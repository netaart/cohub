<script lang="ts">
import type { AppRuntimeInvocationContext, Permission, SpaceFsFileResponse } from "@neta-art/cohub";
import { APPS_PATH, emptyManifest, isPermissionError, parseCatalog, parseManifest, toInstalledApp, type FileState, type InstalledApp, type MarketplaceEntry } from "./catalog";
import { createCohubClient } from "@neta-art/cohub";
import { AlertCircle, Check, LoaderCircle, PackageOpen, Search } from "@lucide/svelte";
import { onMount } from "svelte";

const client = createCohubClient();
const CATALOG_URL: string = import.meta.env.__CATALOG_URL__;

let space = $state<{ id: string; name: string | null } | null>(null);
let invocation = $state<AppRuntimeInvocationContext | null>(null);
let catalog = $state<MarketplaceEntry[]>([]);
let installed = $state<InstalledApp[]>([]);
let query = $state("");
let loading = $state(true);
let savingId = $state<string | null>(null);
let error = $state("");
let errorKind = $state<"auth" | "catalog" | "file" | "space" | null>(null);
let authorizing = $state(false);
let requiredScopes = $state<Permission[]>(["file.view"]);
let loaded = $state(false);

const results = $derived.by(() => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return catalog;
  return catalog.filter((app) => terms.every((term) => [app.id, app.name, app.description, app.publisher, ...(app.keywords ?? [])].filter(Boolean).join(" ").toLocaleLowerCase().includes(term)));
});

function decode(file: SpaceFsFileResponse) {
  if (file.encoding !== "base64") return file.content;
  return new TextDecoder().decode(Uint8Array.from(atob(file.content), (character) => character.charCodeAt(0)));
}
async function readInstalled(): Promise<FileState> {
  if (!space) throw new Error("The invocation Space is unavailable.");
  try {
    const file = await client.space(space.id).files.read(APPS_PATH);
    if (!("content" in file)) throw new Error("The installed Apps file is still being prepared.");
    const document = parseManifest(decode(file));
    return { document, revision: { mtimeMs: file.mtimeMs, size: file.size } };
  } catch (cause) {
    if ((cause as { status?: unknown } | null)?.status === 404) {
      return { document: emptyManifest(), revision: null };
    }
    throw cause;
  }
}
async function load() {
  loading = true; error = ""; errorKind = null;
  try {
    const runtime = await client.context();
    invocation = runtime?.invocation ?? null;
    if (runtime?.invocation?.spaceId) {
      space = { id: runtime.invocation.spaceId, name: runtime.space?.name ?? null };
    }
    if (!space) { errorKind = "space"; throw new Error("Choose a Space to browse and install Apps."); }
    try {
      const catalogResponse = await fetch(CATALOG_URL, { headers: { Accept: "application/json" } });
      if (!catalogResponse.ok) throw new Error(`Marketplace returned ${catalogResponse.status}.`);
      catalog = parseCatalog(await catalogResponse.json());
    } catch (cause) {
      errorKind = "catalog";
      throw cause;
    }
    try {
      const state = await readInstalled();
      installed = state.document.apps;
    } catch (cause) {
      if (isPermissionError(cause)) {
        requiredScopes = ["file.view"];
        errorKind = "auth";
      } else {
        errorKind = "file";
      }
      throw cause;
    }
    loaded = true;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Marketplace could not be loaded.";
  }
  finally { loading = false; }
}
async function chooseSpace() {
  authorizing = true; error = ""; errorKind = null;
  try {
    const result = await client.auth.authorize({
      target: { kind: "pick-space" },
      scopes: ["file.view"],
      reason: "Choose a Space to browse Apps.",
      alwaysAsk: true,
    });
    if (result.status !== "granted" || result.target.kind !== "space") {
      errorKind = "space";
      error = "No Space was selected.";
      return;
    }
    space = { id: result.target.spaceId, name: result.target.name };
    await load();
  } catch (cause) {
    errorKind = "space";
    error = cause instanceof Error ? cause.message : "Could not choose a Space.";
  } finally { authorizing = false; }
}
async function authorize() {
  authorizing = true; error = ""; errorKind = null;
  try {
    const result = await client.auth.authorize({
      scopes: requiredScopes,
      target: space ? { kind: "space", spaceId: space.id } : { kind: "pick-space" },
      reason: requiredScopes.includes("file.edit") ? "Install Apps in this Space." : "Browse Apps in this Space.",
      alwaysAsk: true,
    });
    if (result.status === "granted" && result.target.kind === "space") {
      space = { id: result.target.spaceId, name: result.target.name };
      await load();
    }
    else { errorKind = "auth"; error = "Access was not granted."; }
  } catch (cause) {
    errorKind = "auth";
    error = cause instanceof Error ? cause.message : "Authorization failed.";
  } finally { authorizing = false; }
}
async function install(app: MarketplaceEntry) {
  if (!space || installed.some((item) => item.id === app.id) || savingId) return;
  savingId = app.id; error = ""; requiredScopes = ["file.view", "file.edit"];
  try {
    const result = await client.auth.authorize({ scopes: ["file.view", "file.edit"], target: { kind: "space", spaceId: space.id }, reason: `Install ${app.name} in this Space.` });
    if (result.status !== "granted" || result.target.kind !== "space") { errorKind = "auth"; error = "Access was not granted."; return; }
    space = { id: result.target.spaceId, name: result.target.name };
    const current = await readInstalled();
    if (current.document.apps.some((item) => item.id === app.id)) { installed = current.document.apps; return; }
    const next = { ...current.document, apps: [...current.document.apps, toInstalledApp(app)] };
    const writeResult = await client.space(space.id).files.write({ path: APPS_PATH, content: `${JSON.stringify(next, null, 2)}\n`, encoding: "utf-8", ...(current.revision ? { expected: current.revision } : {}), mutationId: crypto.randomUUID() });
    installed = next.apps;
    void writeResult;
  } catch (cause) {
    if (isPermissionError(cause)) {
      requiredScopes = ["file.view", "file.edit"];
      errorKind = "auth";
    } else {
      errorKind = "file";
    }
    error = cause instanceof Error ? cause.message : "App could not be installed.";
  }
  finally { savingId = null; }
}
function installedId(app: MarketplaceEntry) { return installed.find((item) => item.id === app.id)?.id; }

onMount(() => { void load(); });
</script>

<div class="shell">
  <header class="toolbar"><div><div class="eyebrow">Cohub</div><h1>Marketplace</h1><p>{space?.name ?? "Current Space"}</p></div><div class="space-pill" title={invocation?.spaceId ?? undefined}>{space?.name ?? "Space"}</div></header>
  {#if !loading && loaded}<label class="search"><Search /><span class="sr-only">Search Apps</span><input type="search" bind:value={query} placeholder="Search Apps" /></label>{/if}
  <main>
    {#if loading}<div class="state"><LoaderCircle class="spin" /><span>Loading Apps</span></div>
    {:else if error}<div class="state error"><AlertCircle /><strong>{error}</strong>{#if errorKind === "space"}<button type="button" disabled={authorizing} onclick={chooseSpace}>{#if authorizing}<LoaderCircle class="spin" />{:else}Choose a Space{/if}</button>{:else if errorKind === "auth"}<button type="button" disabled={authorizing} onclick={authorize}>{#if authorizing}<LoaderCircle class="spin" />{:else}Authorize access{/if}</button>{:else}<button type="button" onclick={() => void load()}>Retry</button>{/if}</div>
    {:else if results.length === 0}<div class="state"><PackageOpen /><span>No matching Apps</span></div>
    {:else}<div class="grid">{#each results as app (app.id)}<article class="app-card">{#if app.icon}<img src={app.icon} alt="" />{:else}<div class="icon"><PackageOpen /></div>{/if}<div class="details"><h2>{app.name}</h2>{#if app.publisher}<div class="publisher">{app.publisher}</div>{/if}{#if app.description}<p>{app.description}</p>{/if}<code>{app.ref}</code></div>{#if installedId(app)}<span class="installed"><Check /> Installed</span>{:else}<button class="install" type="button" disabled={savingId !== null} onclick={() => void install(app)}>{#if savingId === app.id}<LoaderCircle class="spin" />{:else}Install{/if}</button>{/if}</article>{/each}</div>{/if}
  </main>
</div>
