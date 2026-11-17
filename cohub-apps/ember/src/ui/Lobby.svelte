<script lang="ts">
  import Shuffle from "@lucide/svelte/icons/shuffle";
  import { untrack } from "svelte";
  import { CAMPER_COLORS, type Camp } from "../engine/camp.svelte.ts";

  let { camp }: { camp: Camp } = $props();
  let name = $state(untrack(() => camp.profile.name));
  let color = $state(untrack(() => camp.profile.color));
  let code = $state("");

  $effect(() => {
    code = camp.code;
  });

  const t = $derived(camp.t);
  const busy = $derived(camp.phase === "joining" || camp.phase === "boot");
  const signedOut = $derived(camp.phase === "lobby" && camp.context !== null && !camp.context.viewer);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    void camp.sit({ name, color, code });
  };
</script>

<div class="lobby" class:busy>
  <form class="lobby-card" onsubmit={submit} aria-busy={busy}>
    <header>
      <span class="mark" aria-hidden="true"></span>
      <h1>{t.title}</h1>
    </header>
    <p class="tagline">{t.tagline}</p>

    <label class="field">
      <span>{t.nameLabel}</span>
      <input bind:value={name} maxlength="24" placeholder={t.traveler} autocomplete="nickname" disabled={busy} />
    </label>

    <fieldset class="field">
      <legend>{t.colorLabel}</legend>
      <div class="swatches">
        {#each CAMPER_COLORS as swatch, index (swatch)}
          <button
            type="button"
            class="swatch"
            class:on={swatch === color}
            style:--swatch={swatch}
            aria-label={t.colour(index + 1)}
            aria-pressed={swatch === color}
            disabled={busy}
            onclick={() => (color = swatch)}
          ></button>
        {/each}
      </div>
    </fieldset>

    <label class="field">
      <span>{t.codeLabel}</span>
      <div class="code-row">
        <input bind:value={code} maxlength="32" spellcheck="false" autocapitalize="characters" class="mono" disabled={busy} />
        <button type="button" class="ghost" onclick={() => camp.newCamp()} disabled={busy} title={t.newCamp} aria-label={t.newCamp}>
          <Shuffle size={16} />
        </button>
      </div>
      <small>{camp.linked ? t.codeLinked : t.codeHint}</small>
    </label>

    {#if camp.joinError}<p class="error" role="alert">{camp.joinError}</p>{/if}
    {#if signedOut}<p class="hint" role="note">{t.signIn}</p>{/if}

    <button class="primary" type="submit" disabled={busy}>
      {#if camp.phase === "joining"}{camp.restoring ? t.restoring : t.joining}{:else}{t.sit}{/if}
    </button>
  </form>
</div>
