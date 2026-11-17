<script lang="ts">
  import { onMount } from "svelte";
  import type { Camp } from "./engine/camp.svelte.ts";
  import CameraBubble from "./ui/CameraBubble.svelte";
  import Dock from "./ui/Dock.svelte";
  import Lobby from "./ui/Lobby.svelte";
  import Log from "./ui/Log.svelte";
  import StarTip from "./ui/StarTip.svelte";
  import TopBar from "./ui/TopBar.svelte";

  let { camp }: { camp: Camp } = $props();
  let host: HTMLDivElement;
  let logOpen = $state(false);

  onMount(() => {
    camp.attach(host);
    void camp.boot();
    void document.fonts?.ready.then(() => camp.board?.stage.invalidate({ cards: true }));
    return () => camp.destroy();
  });

  $effect(() => {
    if (logOpen) camp.unread = 0;
  });
</script>

<div class="camp" class:seated={camp.phase === "camp"} class:ink={camp.inkMode}>
  <div class="board" bind:this={host} aria-label={camp.t.title} role="application"></div>
  <div class="vignette" aria-hidden="true"></div>

  {#if camp.phase === "camp"}
    <div class="camera-layer">
      {#if camp.media.localCamera}
        {#key camp.media.localCamera.id}
          <CameraBubble {camp} participantId={camp.world.self.id} track={camp.media.localCamera} self />
        {/key}
      {/if}
      {#each camp.media.cameras as camera (`${camera.participantId}:${camera.track.id}`)}
        <CameraBubble {camp} participantId={camera.participantId} track={camera.track} />
      {/each}
    </div>
    <TopBar {camp} bind:logOpen />
    <Dock {camp} />
    {#if logOpen}<Log {camp} onclose={() => (logOpen = false)} />{/if}
    {#if camp.star}<StarTip star={camp.star} t={camp.t} />{/if}
  {:else}
    <Lobby {camp} />
  {/if}

  {#if camp.notice}
    <div class="notice" class:error={camp.notice.tone === "error"} role="status">{camp.notice.text}</div>
  {/if}
</div>
