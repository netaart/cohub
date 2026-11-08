import {
  BOARD_SCRIPT_SENSES,
  type BoardScriptBrowserEvent,
  type BoardScriptBrowserEvents,
  type BoardScriptSense,
  type BoardScriptSenseState,
} from "../model/script.js";

export const BOARD_CONSENT_SENSES = ["microphone", "camera", "location"] as const;
export type BoardConsentSense = (typeof BOARD_CONSENT_SENSES)[number];

type Emit = <Type extends BoardScriptBrowserEvent>(type: Type, data: BoardScriptBrowserEvents[Type]) => void;

export type BoardSensesOptions = {
  onReading: Emit;
  onChange(): void;
  consent?: (sense: BoardConsentSense) => boolean;
};

type Source = {
  available(): boolean;
  permit?(): Promise<boolean>;
  start(emit: Emit, fail: (state: "denied" | "unavailable") => void): () => void;
};

const AWAKE: ReadonlySet<BoardScriptSense> = new Set(["motion", "microphone", "camera", "location"]);
const isConsent = (sense: BoardScriptSense): sense is BoardConsentSense => (BOARD_CONSENT_SENSES as readonly string[]).includes(sense);
const coarse = () => typeof matchMedia === "function" && matchMedia("(any-pointer: coarse)").matches;

function plain(value: unknown, depth = 3): unknown {
  if (value === null || typeof value !== "object") return typeof value === "function" ? undefined : value;
  if (depth === 0) return undefined;
  if (Array.isArray(value)) return value.map((entry) => plain(entry, depth - 1) ?? null);
  const result: Record<string, unknown> = {};
  for (const key in value) {
    const field = plain((value as Record<string, unknown>)[key], depth - 1);
    if (field !== undefined) result[key] = field;
  }
  return result;
}

const pick = <T>(event: object, keys: readonly string[]) =>
  Object.fromEntries(keys.flatMap((key) => (key in event ? [[key, plain((event as Record<string, unknown>)[key])]] : []))) as T;

const ORIENTATION_KEYS = ["alpha", "beta", "gamma", "absolute", "webkitCompassHeading", "webkitCompassAccuracy"] as const;

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
      const onMotion = (event: DeviceMotionEvent) =>
        emit("browser:devicemotion", {
          ...pick<Omit<BoardScriptBrowserEvents["browser:devicemotion"], "t">>(event, ["acceleration", "accelerationIncludingGravity", "rotationRate", "interval"]),
          t: event.timeStamp,
        });
      const onOrientation = (event: Event) =>
        emit(`browser:${event.type as "deviceorientation" | "deviceorientationabsolute"}`, {
          ...pick<Omit<BoardScriptBrowserEvents["browser:deviceorientation"], "t">>(event, ORIENTATION_KEYS),
          t: event.timeStamp,
        });
      const types = ["deviceorientation", ...("ondeviceorientationabsolute" in globalThis ? ["deviceorientationabsolute"] : [])];
      addEventListener("devicemotion", onMotion);
      for (const type of types) addEventListener(type, onOrientation);
      return () => {
        removeEventListener("devicemotion", onMotion);
        for (const type of types) removeEventListener(type, onOrientation);
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
        const pads = [...navigator.getGamepads()].flatMap((pad) =>
          pad ? [pick<BoardScriptBrowserEvents["browser:gamepads"]["pads"][number]>(pad, ["index", "id", "mapping", "connected", "timestamp", "buttons", "axes"])] : []);
        const key = JSON.stringify(pads);
        if (key !== last) {
          last = key;
          emit("browser:gamepads", { pads });
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

const failure = (error: unknown) => {
  const name = error instanceof DOMException ? error.name : "";
  return name === "NotAllowedError" || name === "SecurityError" ? "denied" : "unavailable";
};

const AUDIO_WORKLET = `registerProcessor("cohub-board-audio", class extends AudioWorkletProcessor {
  buffer = new Float32Array(8192);
  length = 0;
  process([input]) {
    const channel = input && input[0];
    if (channel) {
      this.buffer.set(channel, this.length);
      this.length += channel.length;
      if (this.length >= sampleRate / 50) {
        this.port.postMessage(this.buffer.slice(0, this.length));
        this.length = 0;
      }
    }
    return true;
  }
});`;

function microphoneSource(context: { resume: Set<AudioContext> }): Source {
  return {
    available: () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioWorkletNode !== "undefined",
    start(emit, fail) {
      // Made now, inside the tap or consent click when there is one, so Safari lets it run.
      const audio = new AudioContext();
      if (audio.state === "suspended") context.resume.add(audio);
      let stopped = false;
      let stream: MediaStream | null = null;
      const module = URL.createObjectURL(new Blob([AUDIO_WORKLET], { type: "text/javascript" }));
      const opened = navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        .then((media) => (stream = media));
      void Promise.all([opened, audio.audioWorklet.addModule(module)]).then(([media]) => {
        if (stopped) return stop();
        const node = new AudioWorkletNode(audio, "cohub-board-audio");
        const silent = audio.createGain();
        silent.gain.value = 0;
        audio.createMediaStreamSource(media).connect(node).connect(silent).connect(audio.destination);
        node.port.onmessage = ({ data }: MessageEvent<Float32Array>) =>
          emit("browser:audio", { samples: data, sampleRate: audio.sampleRate, t: audio.currentTime * 1000 });
      }, (error: unknown) => {
        void opened.then(stop, () => {});
        if (!stopped) fail(failure(error));
      });
      function stop() {
        for (const track of stream?.getTracks() ?? []) track.stop();
      }
      return () => {
        stopped = true;
        stop();
        URL.revokeObjectURL(module);
        context.resume.delete(audio);
        void audio.close().catch(() => {});
      };
    },
  };
}

const VIDEO_MS = 1000 / 30;

function cameraSource(): Source {
  return {
    available: () => typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof createImageBitmap === "function",
    start(emit, fail) {
      let stopped = false;
      let stream: MediaStream | null = null;
      let frame = 0;
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      let last = -Infinity;
      let capturing = false;
      const next = () => { if (!stopped) frame = requestAnimationFrame(capture); };
      const capture = (now: number) => {
        if (capturing || now - last < VIDEO_MS || video.readyState < 2) return next();
        capturing = true;
        last = now;
        createImageBitmap(video).then((bitmap) => {
          capturing = false;
          if (stopped) return bitmap.close();
          emit("browser:video", { frame: bitmap, width: bitmap.width, height: bitmap.height, t: now });
        }, () => { capturing = false; });
        next();
      };
      void navigator.mediaDevices
        .getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" } })
        .then((media) => {
          stream = media;
          if (stopped) return stop();
          video.srcObject = media;
          void video.play().catch(() => {});
          next();
        }, (error: unknown) => {
          if (!stopped) fail(failure(error));
        });
      function stop() {
        for (const track of stream?.getTracks() ?? []) track.stop();
      }
      return () => {
        stopped = true;
        cancelAnimationFrame(frame);
        stop();
        video.srcObject = null;
      };
    },
  };
}

function locationSource(): Source {
  return {
    available: () => typeof navigator !== "undefined" && Boolean(navigator.geolocation),
    start(emit, fail) {
      const watch = navigator.geolocation.watchPosition(
        (position) => emit("browser:position", pick<BoardScriptBrowserEvents["browser:position"]>(position, ["coords", "timestamp"])),
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
    microphone: microphoneSource({ resume }),
    camera: cameraSource(),
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
