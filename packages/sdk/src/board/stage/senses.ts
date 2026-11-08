import {
  BOARD_SCRIPT_SENSES,
  type BoardScriptMotionSample,
  type BoardScriptSense,
  type BoardScriptSenseEvents,
  type BoardScriptSenseState,
  type BoardScriptVec3,
} from "../model/script.js";

/** Senses that also need the viewer's consent in the host: one origin serves every Board. */
export const BOARD_CONSENT_SENSES = ["audio", "location"] as const;
export type BoardConsentSense = (typeof BOARD_CONSENT_SENSES)[number];

export type BoardSensesOptions = {
  onReading<Type extends BoardScriptSense>(type: Type, data: BoardScriptSenseEvents[Type]): void;
  onChange(): void;
  consent?: (sense: BoardConsentSense) => boolean;
};

type Emit = <Type extends BoardScriptSense>(type: Type, data: BoardScriptSenseEvents[Type]) => void;
type Source = {
  available(): boolean;
  permit?(): Promise<boolean>;
  start(emit: Emit, fail: (state: "denied" | "unavailable") => void): () => void;
};

const DEG = Math.PI / 180;
const AWAKE: ReadonlySet<BoardScriptSense> = new Set(["motion", "audio", "location"]);
const isConsent = (sense: BoardScriptSense): sense is BoardConsentSense => sense === "audio" || sense === "location";
const coarse = () => typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches;

function screenAngle(): number {
  const angle = screen.orientation?.angle ?? (globalThis as { orientation?: number }).orientation ?? 0;
  return ((angle % 360) + 360) % 360;
}

function toScreen(v: BoardScriptVec3, angle: number): BoardScriptVec3 {
  if (angle === 0) return v;
  const c = Math.round(Math.cos(angle * DEG));
  const s = Math.round(Math.sin(angle * DEG));
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

const vec = (value: { x?: number | null; y?: number | null; z?: number | null } | null | undefined): BoardScriptVec3 | null =>
  value && value.x != null && value.y != null && value.z != null ? { x: value.x, y: value.y, z: value.z } : null;

function motionSource(): Source {
  type Permission = { requestPermission?: () => Promise<string> };
  const ask = () => (globalThis.DeviceMotionEvent as unknown as Permission | undefined)?.requestPermission;
  return {
    available: () => typeof DeviceMotionEvent !== "undefined" && coarse(),
    permit: ask()
      ? async () => {
          const orientation = (globalThis.DeviceOrientationEvent as unknown as Permission | undefined)?.requestPermission;
          const [motion] = await Promise.all([ask()?.(), orientation?.().catch(() => "denied")]);
          return motion === "granted";
        }
      : undefined,
    start(emit) {
      let samples: BoardScriptMotionSample[] = [];
      let orientation: { x: number; y: number; z: number; w: number } | null = null;
      let heading: number | null = null;
      let gravity: BoardScriptVec3 = { x: 0, y: 0, z: 0 };
      let frame = 0;
      const flush = () => {
        frame = 0;
        const data = { samples, orientation, heading };
        samples = [];
        emit("motion", data);
      };
      const onMotion = (event: DeviceMotionEvent) => {
        const angle = screenAngle();
        const total = vec(event.accelerationIncludingGravity);
        let acceleration = vec(event.acceleration);
        if (total && acceleration) gravity = { x: total.x - acceleration.x, y: total.y - acceleration.y, z: total.z - acceleration.z };
        else if (total) {
          gravity = { x: gravity.x + (total.x - gravity.x) * 0.1, y: gravity.y + (total.y - gravity.y) * 0.1, z: gravity.z + (total.z - gravity.z) * 0.1 };
          acceleration = { x: total.x - gravity.x, y: total.y - gravity.y, z: total.z - gravity.z };
        }
        const rate = event.rotationRate;
        samples.push({
          t: event.timeStamp,
          acceleration: toScreen(acceleration ?? { x: 0, y: 0, z: 0 }, angle),
          gravity: toScreen(gravity, angle),
          rotationRate: toScreen({ x: (rate?.beta ?? 0) * DEG, y: (rate?.gamma ?? 0) * DEG, z: (rate?.alpha ?? 0) * DEG }, angle),
        });
        frame ||= requestAnimationFrame(flush);
      };
      const onOrientation = (event: DeviceOrientationEvent) => {
        if (event.alpha == null || event.beta == null || event.gamma == null) return;
        const angle = screenAngle();
        const [x, y, z] = [event.beta * DEG / 2, event.gamma * DEG / 2, event.alpha * DEG / 2];
        const [cx, cy, cz, sx, sy, sz] = [Math.cos(x), Math.cos(y), Math.cos(z), Math.sin(x), Math.sin(y), Math.sin(z)];
        const q = { x: sx * cy * cz - cx * sy * sz, y: cx * sy * cz + sx * cy * sz, z: cx * cy * sz + sx * sy * cz, w: cx * cy * cz - sx * sy * sz };
        const [hz, hw] = [Math.sin(-angle * DEG / 2), Math.cos(-angle * DEG / 2)];
        orientation = { x: q.x * hw + q.y * hz, y: q.y * hw - q.x * hz, z: q.z * hw + q.w * hz, w: q.w * hw - q.z * hz };
        const compass = (event as DeviceOrientationEvent & { webkitCompassHeading?: number }).webkitCompassHeading;
        heading = compass ?? (event.absolute ? (360 - event.alpha + angle) % 360 : heading);
      };
      const orientationType = "ondeviceorientationabsolute" in globalThis ? "deviceorientationabsolute" : "deviceorientation";
      addEventListener("devicemotion", onMotion);
      addEventListener(orientationType, onOrientation as EventListener);
      return () => {
        removeEventListener("devicemotion", onMotion);
        removeEventListener(orientationType, onOrientation as EventListener);
        cancelAnimationFrame(frame);
      };
    },
  };
}

function gamepadSource(): Source {
  return {
    available: () => typeof navigator !== "undefined" && typeof navigator.getGamepads === "function",
    start(emit) {
      let frame = 0;
      let last = "";
      const poll = () => {
        const pads = [...navigator.getGamepads()].flatMap((pad) => (pad?.connected ? [{
          index: pad.index,
          id: pad.id,
          buttons: pad.buttons.map((button) => Math.round(button.value * 100) / 100),
          axes: pad.axes.map((axis) => Math.round(axis * 100) / 100),
        }] : []));
        const key = JSON.stringify(pads);
        if (key !== last) {
          last = key;
          emit("gamepad", { pads });
        }
        frame = pads.length ? requestAnimationFrame(poll) : 0;
      };
      const wake = () => { frame ||= requestAnimationFrame(poll); };
      addEventListener("gamepadconnected", wake);
      addEventListener("gamepaddisconnected", wake);
      wake();
      return () => {
        removeEventListener("gamepadconnected", wake);
        removeEventListener("gamepaddisconnected", wake);
        cancelAnimationFrame(frame);
      };
    },
  };
}

const AUDIO_MS = 33;
const SPECTRUM_BANDS = 32;
const SPECTRUM_HZ = [50, 12_000] as const;

function spectrumBands(bins: number, rate: number): Array<[number, number]> {
  const [low, high] = SPECTRUM_HZ;
  const bin = (hz: number) => Math.min(bins - 1, Math.round((hz / (rate / 2)) * bins));
  return Array.from({ length: SPECTRUM_BANDS }, (_, i) => {
    const from = bin(low * (high / low) ** (i / SPECTRUM_BANDS));
    return [from, Math.max(from + 1, bin(low * (high / low) ** ((i + 1) / SPECTRUM_BANDS)))];
  });
}

function pitchOf(buffer: Float32Array, rate: number): number | null {
  const min = Math.floor(rate / 1000);
  const max = Math.min(buffer.length >> 1, Math.ceil(rate / 60));
  const at = (i: number) => buffer[i] as number;
  let energy = 0;
  for (let i = 0; i < max; i += 2) energy += at(i) * at(i);
  if (!energy) return null;
  let best = 0;
  let lag = 0;
  for (let offset = min; offset < max; offset++) {
    let sum = 0;
    for (let i = 0; i < max; i += 2) sum += at(i) * at(i + offset);
    if (sum > best) {
      best = sum;
      lag = offset;
    }
  }
  return lag && best / energy > 0.5 ? Math.round(rate / lag) : null;
}

function audioSource(context: { resume: Set<AudioContext> }): Source {
  return {
    available: () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioContext !== "undefined",
    start(emit, fail) {
      // Made now, inside the tap or consent click when there is one, so Safari lets it run.
      const audio = new AudioContext();
      if (audio.state === "suspended") context.resume.add(audio);
      let stopped = false;
      let release = () => {};
      void navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        .then((stream) => {
          const stopTracks = () => {
            for (const track of stream.getTracks()) track.stop();
          };
          if (stopped) return stopTracks();
          const analyser = audio.createAnalyser();
          analyser.fftSize = 2048;
          audio.createMediaStreamSource(stream).connect(analyser);
          const buffer = new Float32Array(analyser.fftSize);
          const frequencies = new Float32Array(analyser.frequencyBinCount);
          const bands = spectrumBands(frequencies.length, audio.sampleRate);
          const range = analyser.maxDecibels - analyser.minDecibels;
          let smooth = 0;
          let onsetAt = -Infinity;
          const timer = setInterval(() => {
            if (audio.state !== "running") return;
            analyser.getFloatTimeDomainData(buffer);
            let sum = 0;
            for (const sample of buffer) sum += sample * sample;
            const rms = Math.sqrt(sum / buffer.length);
            const level = Math.min(1, Math.max(0, (20 * Math.log10(rms || 1e-6) + 60) / 60));
            const now = performance.now();
            const onset = level > 0.3 && level - smooth > 0.15 && now - onsetAt > 100;
            if (onset) onsetAt = now;
            smooth += (level - smooth) * 0.2;
            analyser.getFloatFrequencyData(frequencies);
            const spectrum = bands.map(([from, to]) => {
              let sum = 0;
              for (let i = from; i < to; i++) sum += frequencies[i] as number;
              const value = (sum / (to - from) - analyser.minDecibels) / range;
              return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
            });
            emit("audio", { level: Math.round(level * 1000) / 1000, pitch: level > 0.2 ? pitchOf(buffer, audio.sampleRate) : null, onset, spectrum });
          }, AUDIO_MS);
          release = () => {
            clearInterval(timer);
            stopTracks();
          };
        }, (error: unknown) => {
          if (stopped) return;
          const name = error instanceof DOMException ? error.name : "";
          fail(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable");
        });
      return () => {
        stopped = true;
        release();
        context.resume.delete(audio);
        void audio.close().catch(() => {});
      };
    },
  };
}

function locationSource(): Source {
  return {
    available: () => typeof navigator !== "undefined" && Boolean(navigator.geolocation),
    start(emit, fail) {
      const watch = navigator.geolocation.watchPosition(
        ({ coords, timestamp }) => emit("location", {
          latitude: coords.latitude,
          longitude: coords.longitude,
          accuracy: coords.accuracy,
          altitude: coords.altitude,
          heading: coords.heading != null && Number.isFinite(coords.heading) ? coords.heading : null,
          speed: coords.speed,
          t: timestamp,
        }),
        (error) => { if (error.code === error.PERMISSION_DENIED) fail("denied"); },
        { enableHighAccuracy: false, maximumAge: 10_000 },
      );
      return () => navigator.geolocation.clearWatch(watch);
    },
  };
}

export function createBoardSenses(options: BoardSensesOptions) {
  const resume = new Set<AudioContext>();
  const sources: Record<BoardScriptSense, Source> = {
    motion: motionSource(),
    gamepad: gamepadSource(),
    audio: audioSource({ resume }),
    location: locationSource(),
  };
  const available = new Map<BoardScriptSense, boolean>();
  const permitted = new Set<BoardScriptSense>();
  const asking = new Set<BoardScriptSense>();
  const denied = new Set<BoardScriptSense>();
  const failed = new Set<BoardScriptSense>();
  const running = new Map<BoardScriptSense, () => void>();
  const gestures = new Set<() => void>();
  let wanted: readonly BoardScriptSense[] = [];
  let active = true;
  let visible = true;
  let listening = false;
  let lock: WakeLockSentinel | null = null;
  let locking = false;
  let states = readStates();

  function supports(sense: BoardScriptSense) {
    let value = available.get(sense);
    if (value === undefined) {
      value = sources[sense].available();
      available.set(sense, value);
    }
    return value;
  }

  function stateOf(sense: BoardScriptSense): BoardScriptSenseState {
    if (!supports(sense) || failed.has(sense)) return "unavailable";
    if (denied.has(sense)) return "denied";
    if (isConsent(sense) && !(options.consent?.(sense) ?? false)) return "ask";
    return sources[sense].permit && !permitted.has(sense) ? "ask" : "on";
  }

  function readStates() {
    return Object.fromEntries(BOARD_SCRIPT_SENSES.map((sense) => [sense, stateOf(sense)])) as Record<BoardScriptSense, BoardScriptSenseState>;
  }

  const awake = () => visible && active && [...running.keys()].some((sense) => AWAKE.has(sense));

  function holdScreen() {
    const wake = awake();
    if (!wake) {
      const held = lock;
      lock = null;
      void held?.release().catch(() => {});
      return;
    }
    if (lock || locking || typeof navigator === "undefined" || !navigator.wakeLock) return;
    locking = true;
    navigator.wakeLock.request("screen").then((sentinel) => {
      locking = false;
      if (awake()) lock = sentinel;
      else void sentinel.release();
    }, () => { locking = false; });
  }

  function reconcile() {
    const shown = typeof document === "undefined" || document.visibilityState === "visible";
    if (shown && !visible) failed.clear();
    visible = shown;
    const live = active && visible ? new Set(wanted.filter((sense) => stateOf(sense) === "on")) : new Set<BoardScriptSense>();
    for (const [sense, stop] of running)
      if (!live.has(sense)) {
        running.delete(sense);
        stop();
      }
    for (const sense of live)
      if (!running.has(sense))
        running.set(sense, sources[sense].start(options.onReading, (state) => {
          if (state === "denied") denied.add(sense);
          else failed.add(sense);
          reconcile();
        }));
    const listen = wanted.length > 0 && typeof document !== "undefined";
    if (listen !== listening) {
      listening = listen;
      if (listen) document.addEventListener("visibilitychange", reconcile);
      else document.removeEventListener("visibilitychange", reconcile);
    }
    holdScreen();
    const next = readStates();
    if (BOARD_SCRIPT_SENSES.some((sense) => next[sense] !== states[sense])) {
      states = next;
      options.onChange();
    }
  }

  return {
    get states() { return states; },
    get wanted() { return wanted; },
    sync(next: readonly BoardScriptSense[], isActive: boolean) {
      if (next.length === wanted.length && next.every((sense, i) => sense === wanted[i]) && isActive === active) return;
      wanted = next;
      active = isActive;
      reconcile();
    },
    refresh() {
      for (const sense of denied) if (isConsent(sense)) denied.delete(sense);
      failed.clear();
      reconcile();
    },
    whenGesture(run: () => void) {
      gestures.add(run);
      return () => gestures.delete(run);
    },
    unlock() {
      for (const audio of resume) void audio.resume().then(() => resume.delete(audio), () => {});
      for (const run of gestures) run();
      gestures.clear();
      for (const sense of wanted) {
        const permit = sources[sense].permit;
        if (!permit || asking.has(sense) || stateOf(sense) !== "ask") continue;
        asking.add(sense);
        void permit().then((granted) => (granted ? permitted : denied).add(sense), () => {}).finally(() => {
          asking.delete(sense);
          reconcile();
        });
      }
    },
    destroy() {
      wanted = [];
      gestures.clear();
      reconcile();
    },
  };
}

export type BoardSenses = ReturnType<typeof createBoardSenses>;
