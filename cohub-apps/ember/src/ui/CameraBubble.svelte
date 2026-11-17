<script lang="ts">
  import { onMount } from "svelte";
  import type { Camp } from "../engine/camp.svelte.ts";
  import { CAMERA_RANGE } from "../net/media-policy.ts";

  let { camp, participantId, track, self = false }: {
    camp: Camp; participantId: string; track: MediaStreamTrack; self?: boolean;
  } = $props();
  let anchor: HTMLDivElement;
  let video = $state<HTMLVideoElement | null>(null);
  let ready = $state(false);
  const member = $derived(camp.members.find((member) => member.participantId === participantId));
  const name = $derived(self ? camp.profile.name : member?.name || camp.t.traveler);
  const label = $derived(camp.t.cameraOf(name));

  $effect(() => {
    const element = video;
    if (!element) return;
    ready = false;
    element.srcObject = new MediaStream([track]);
    void element.play().catch(() => {});
    return () => {
      element.pause();
      element.srcObject = null;
    };
  });

  onMount(() => {
    const board = camp.board;
    if (!board) return;
    let placement = "";
    const update = () => {
      const body = self ? camp.world.self : camp.world.body(participantId);
      const at = self ? null : camp.media.cameraPosition(participantId);
      const show = track.readyState !== "ended" && !track.muted && Boolean(body) && document.visibilityState !== "hidden" &&
        camp.context?.window?.visible !== false && (self ? board.cameraVisible(camp.world.self) : Boolean(at?.visible && at.distance < CAMERA_RANGE));
      if (anchor.hidden === show) {
        anchor.hidden = !show;
        if (show) void video?.play().catch(() => {});
        else video?.pause();
      }
      if (!show || !body) return;
      const screen = board.toScreen(body);
      const zoom = board.stage.camera.zoom;
      const boost = Math.min(2.2, Math.max(1, 0.95 / Math.sqrt(Math.max(0.05, zoom))));
      const scale = self ? 1 : 0.72 + 0.28 * Math.max(0, 1 - (at?.distance ?? CAMERA_RANGE) / CAMERA_RANGE);
      const next = `translate3d(${screen.x.toFixed(1)}px, ${(screen.y - 50 * boost * zoom - 10).toFixed(1)}px, 0) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
      if (next !== placement) {
        placement = next;
        anchor.style.transform = next;
      }
    };
    const off = board.onFrame(update);
    document.addEventListener("visibilitychange", update);
    return () => {
      off();
      document.removeEventListener("visibilitychange", update);
    };
  });

  $effect(() => {
    if (camp.context?.window?.visible === false && anchor) {
      anchor.hidden = true;
      video?.pause();
    }
  });
</script>

<div class="camera-anchor" bind:this={anchor} role="img" aria-label={label} title={label} hidden>
  <div class="camera-bubble" class:ready style:--cam-color={self ? camp.profile.color : member?.color ?? 'var(--ember)'}>
    <video bind:this={video} class:mirrored={self} muted playsinline autoplay onloadeddata={() => (ready = true)} aria-hidden="true"></video>
    <span class="camera-light" aria-hidden="true"></span>
  </div>
</div>

<style>
  .camera-anchor {
    position: absolute;
    top: 0;
    left: 0;
    width: 72px;
    height: 72px;
    transform-origin: bottom center;
    pointer-events: none;
  }

  .camera-anchor[hidden] { display: none; }

  .camera-bubble {
    position: relative;
    width: 100%;
    height: 100%;
    padding: 3px;
    border: 1px solid var(--cam-color);
    border-radius: 50%;
    background: var(--surface-strong);
    box-shadow: 0 5px 18px rgb(0 0 0 / 0.3);
    opacity: 0;
    transform: translateY(8px) scale(0.82);
    transition: opacity 220ms var(--ease), transform 300ms var(--ease);
  }

  .camera-bubble.ready { opacity: 1; transform: none; }

  video { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block; }
  video.mirrored { transform: scaleX(-1); }

  .camera-light {
    position: absolute;
    bottom: 1px;
    right: 9px;
    width: 9px;
    height: 9px;
    border: 2px solid var(--surface-strong);
    border-radius: 50%;
    background: var(--cam-color);
  }

  @media (prefers-reduced-motion: reduce) {
    .camera-bubble { transition: none; transform: none; }
  }
</style>
