<script lang="ts">
  import Flame from "@lucide/svelte/icons/flame";
  import Hand from "@lucide/svelte/icons/hand";
  import LocateFixed from "@lucide/svelte/icons/locate-fixed";
  import Mic from "@lucide/svelte/icons/mic";
  import MicOff from "@lucide/svelte/icons/mic-off";
  import Video from "@lucide/svelte/icons/video";
  import VideoOff from "@lucide/svelte/icons/video-off";
  import MoonStar from "@lucide/svelte/icons/moon-star";
  import PenLine from "@lucide/svelte/icons/pen-line";
  import Send from "@lucide/svelte/icons/send";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import StickyNote from "@lucide/svelte/icons/sticky-note";
  import TreePine from "@lucide/svelte/icons/tree-pine";
  import { LIMITS } from "../camp/protocol.ts";
  import type { Camp } from "../engine/camp.svelte.ts";

  let { camp }: { camp: Camp } = $props();
  let text = $state("");
  let input: HTMLTextAreaElement;
  let sending = $state(false);
  let hints = $state(true);

  const t = $derived(camp.t);
  const spirit = $derived(camp.spirit.member);
  const spiritLabel = $derived(
    spirit ? t.dismiss(camp.spiritName) : camp.spirit.summoning ? t.summoning(camp.spiritName) : t.summon(camp.spiritName),
  );
  const placeholder = $derived(camp.writeAt ? t.cardPlaceholder : spirit ? t.sayToSpirit(camp.spiritName) : t.say);

  $effect(() => {
    if (camp.composer > 0) {
      hints = false;
      input?.focus();
    }
  });

  $effect(() => {
    const timer = setTimeout(() => (hints = false), 14_000);
    return () => clearTimeout(timer);
  });

  const send = async (as: "chat" | "card") => {
    const value = text.trim();
    if (!value || sending) return;
    sending = true;
    const ok = as === "card" || camp.writeAt ? await camp.pin(value) : await camp.chat(value);
    sending = false;
    if (ok) text = "";
    input?.focus();
  };

  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send(event.metaKey || event.ctrlKey ? "card" : "chat");
    } else if (event.key === "Escape") {
      camp.writeAt = null;
      input.blur();
    }
  };
</script>

<div class="dock-wrap">
  {#if hints}
    <ul class="hints" aria-label={t.title}>
      <li>{t.hintWalk}</li>
      <li>{t.hintBurn}</li>
      <li>{t.hintWrite}</li>
    </ul>
  {/if}
  <div class="dock" class:writing={camp.writeAt !== null}>
    <div class="compose">
      <textarea
        bind:this={input}
        bind:value={text}
        rows="1"
        maxlength={LIMITS.cardText}
        {placeholder}
        aria-label={placeholder}
        onkeydown={keydown}
      ></textarea>
      <button class="icon" onclick={() => void send("chat")} disabled={!text.trim() || sending || camp.writeAt !== null} title={t.send} aria-label={t.send}>
        <Send size={17} />
      </button>
      <button class="icon accent" class:on={camp.writeAt !== null} onclick={() => void send("card")} disabled={!text.trim() || sending} title={t.pin} aria-label={t.pin}>
        <StickyNote size={17} />
      </button>
    </div>
    <div class="tools" role="toolbar" aria-label={t.title}>
      <button class="tool" class:on={camp.inkMode} onclick={() => camp.toggleInk()} aria-pressed={camp.inkMode} title={camp.inkMode ? t.inkOff : t.ink} aria-label={camp.inkMode ? t.inkOff : t.ink}>
        <PenLine size={18} /><span>{t.inkShort}</span>
      </button>
      <button class="tool" onclick={() => void camp.addWood()} disabled={camp.woodWait > 0} title={t.wood} aria-label={t.wood}>
        <Flame size={18} /><span>{camp.woodWait ? t.woodWait(camp.woodWait) : t.woodShort}</span>
      </button>
      <button class="tool" class:on={camp.media.mic} disabled={camp.media.requesting !== null} onclick={() => void camp.media.toggleMic()} aria-pressed={camp.media.mic} title={camp.media.mic ? t.micOff : t.micOn} aria-label={camp.media.mic ? t.micOff : t.micOn}>
        {#if camp.media.mic}<Mic size={18} />{:else}<MicOff size={18} />{/if}<span>{t.micShort}</span>
      </button>
      <button class="tool" class:on={camp.media.localCamera !== null} disabled={camp.media.requesting !== null}
        aria-busy={camp.media.requesting === 'camera'} aria-pressed={camp.media.localCamera !== null}
        onclick={() => void camp.media.toggleCamera()} title={camp.media.localCamera ? t.cameraOff : t.cameraOn}
        aria-label={camp.media.localCamera ? t.cameraOff : t.cameraOn}>
        {#if camp.media.localCamera}<Video size={18} />{:else}<VideoOff size={18} />{/if}<span>{t.cameraShort}</span>
      </button>
      <button class="tool" onclick={() => camp.wave()} title={t.wave} aria-label={t.wave}><Hand size={18} /><span>{t.wave}</span></button>
      <span class="divider" aria-hidden="true"></span>
      <button class="tool" class:on={camp.lookingUp} onclick={() => camp.lookUp()} aria-pressed={camp.lookingUp} title={camp.lookingUp ? t.ground : t.sky} aria-label={camp.lookingUp ? t.ground : t.sky}>
        {#if camp.lookingUp}<TreePine size={18} />{:else}<MoonStar size={18} />{/if}<span>{camp.lookingUp ? t.groundShort : t.skyShort}</span>
      </button>
      {#if !camp.following && !camp.lookingUp}
        <button class="tool" onclick={() => camp.recenter()} title={t.recenter} aria-label={t.recenter}><LocateFixed size={18} /><span>{t.recenterShort}</span></button>
      {/if}
      <span class="spacer" aria-hidden="true"></span>
      <button
        class="tool spirit"
        class:on={spirit !== null}
        class:busy={camp.spirit.summoning}
        disabled={camp.spirit.summoning}
        onclick={() => void (spirit ? camp.spirit.dismiss() : camp.spirit.summon())}
        title={spiritLabel}
        aria-label={spiritLabel}
      >
        <Sparkles size={18} /><span>{spirit ? t.dismiss(camp.spiritName) : t.summon(camp.spiritName)}</span>
      </button>
    </div>
  </div>
</div>
