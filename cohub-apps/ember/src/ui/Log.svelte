<script lang="ts">
  import X from "@lucide/svelte/icons/x";
  import { tick } from "svelte";
  import type { Camp } from "../engine/camp.svelte.ts";

  let { camp, onclose }: { camp: Camp; onclose: () => void } = $props();
  let list: HTMLOListElement | undefined = $state();
  const t = $derived(camp.t);
  const time = (at: number) => new Date(at).toLocaleTimeString(camp.locale === "zh" ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" });

  $effect(() => {
    void camp.log.length;
    void tick().then(() => list?.scrollTo({ top: list.scrollHeight, behavior: camp.world.reduced ? "auto" : "smooth" }));
  });
</script>

<aside class="log" aria-label={t.log}>
  <header>
    <h2>{t.log}</h2>
    <button class="icon" onclick={onclose} aria-label={t.close} title={t.close}><X size={16} /></button>
  </header>
  {#if camp.log.length === 0}
    <p class="empty">{t.logEmpty}</p>
  {:else}
    <ol bind:this={list}>
      {#each camp.log as line (line.id)}
        <li class={line.kind}>
          <span class="who" style:--who={line.color}>{line.name}</span>
          <time datetime={new Date(line.at).toISOString()}>{time(line.at)}</time>
          <p>{line.text}</p>
        </li>
      {/each}
    </ol>
  {/if}
</aside>
