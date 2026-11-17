<script lang="ts">
  import DoorOpen from "@lucide/svelte/icons/door-open";
  import Link from "@lucide/svelte/icons/link";
  import MessagesSquare from "@lucide/svelte/icons/messages-square";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import type { Camp } from "../engine/camp.svelte.ts";

  let { camp, logOpen = $bindable(false) }: { camp: Camp; logOpen: boolean } = $props();
  const t = $derived(camp.t);
  const people = $derived(camp.members.filter((member) => !member.spirit).slice(0, 6));
  const transport = $derived(camp.transport === "peer" ? t.direct : camp.transport === "relay" ? t.relayed : t.connecting);
</script>

<header class="topbar">
  <div class="cluster">
    <button class="brand" onclick={() => camp.recenter()} title={t.recenter}>
      <span class="mark" aria-hidden="true"></span>
      <span class="wordmark">{t.title}</span>
    </button>
    <div class="chip" title={t.transportHint}>
      <span class="code">{camp.code}</span>
      <span class="dot" class:live={camp.transport === "peer"} aria-hidden="true"></span>
      <span class="muted">{transport}</span>
    </div>
    <div class="chip people" aria-label={t.people(camp.people)}>
      <span class="faces" aria-hidden="true">
        {#each people as person (person.participantId)}<span class="face" style:--face={person.color}></span>{/each}
      </span>
      <span>{t.people(camp.people)}</span>
    </div>
  </div>
  <div class="cluster">
    <button class="icon" onclick={() => void camp.copyLink()} title={t.copyLink} aria-label={t.copyLink}><Link size={17} /></button>
    <button class="icon" onclick={() => void camp.copyInvite()} title={t.invite} aria-label={t.invite}><SquareTerminal size={17} /></button>
    <button class="icon" class:on={logOpen} onclick={() => (logOpen = !logOpen)} title={t.log} aria-label={t.log} aria-pressed={logOpen}>
      <MessagesSquare size={17} />
      {#if camp.unread > 0 && !logOpen}<span class="badge">{Math.min(99, camp.unread)}</span>{/if}
    </button>
    <button class="icon" onclick={() => void camp.leave()} title={t.leave} aria-label={t.leave}><DoorOpen size={17} /></button>
  </div>
</header>
