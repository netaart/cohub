import type { Point } from "../camp/world.ts";

type Voice = {
  track: MediaStreamTrack;
  anchor: HTMLAudioElement;
  source: MediaStreamAudioSourceNode;
  gain: GainNode;
  pan: StereoPannerNode;
};

export type Speaker = { id: string; x: number; volume: number };

const PAN_SPAN = 520;
const SMOOTHING = 0.06;

export class VoiceMixer {
  readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly voices = new Map<string, Voice>();

  constructor() {
    this.context = new AudioContext({ latencyHint: "interactive" });
    this.master = this.context.createGain();
    this.master.connect(this.context.destination);
  }

  async resume() {
    if (this.context.state === "suspended") await this.context.resume().catch(() => undefined);
  }

  setMuted(muted: boolean) {
    this.master.gain.setTargetAtTime(muted ? 0 : 1, this.context.currentTime, SMOOTHING);
  }

  sync(tracks: ReadonlyMap<string, MediaStreamTrack>) {
    for (const [id, voice] of this.voices) if (tracks.get(id) !== voice.track) this.drop(id);
    for (const [id, track] of tracks) {
      if (this.voices.has(id)) continue;
      const stream = new MediaStream([track]);
      const anchor = new Audio();
      anchor.muted = true;
      anchor.srcObject = stream;
      void anchor.play().catch(() => undefined);
      const source = this.context.createMediaStreamSource(stream);
      const gain = this.context.createGain();
      gain.gain.value = 0;
      const pan = this.context.createStereoPanner();
      source.connect(gain).connect(pan).connect(this.master);
      this.voices.set(id, { track, anchor, source, gain, pan });
    }
  }

  place(listener: Point, speakers: readonly Speaker[]) {
    const now = this.context.currentTime;
    for (const speaker of speakers) {
      const voice = this.voices.get(speaker.id);
      if (!voice) continue;
      const side = Math.max(-1, Math.min(1, (speaker.x - listener.x) / PAN_SPAN));
      voice.pan.pan.setTargetAtTime(side * 0.85, now, SMOOTHING);
      voice.gain.gain.setTargetAtTime(speaker.volume, now, SMOOTHING);
    }
  }

  async play(url: string, gainFor: () => number): Promise<number> {
    try {
      const response = await fetch(url, { mode: "cors" });
      if (!response.ok) throw new Error(String(response.status));
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      const node = this.context.createBufferSource();
      const gain = this.context.createGain();
      gain.gain.value = gainFor();
      node.buffer = buffer;
      node.connect(gain).connect(this.master);
      const follow = setInterval(() => gain.gain.setTargetAtTime(gainFor(), this.context.currentTime, 0.2), 250);
      node.onended = () => {
        clearInterval(follow);
        gain.disconnect();
      };
      node.start();
      return buffer.duration * 1000;
    } catch {
      const element = new Audio(url);
      element.volume = Math.max(0, Math.min(1, gainFor()));
      return new Promise((resolve) => {
        element.onloadedmetadata = () => resolve(Number.isFinite(element.duration) ? element.duration * 1000 : 0);
        element.onerror = () => resolve(0);
        element.play().catch(() => resolve(0));
      });
    }
  }

  private drop(id: string) {
    const voice = this.voices.get(id);
    if (!voice) return;
    this.voices.delete(id);
    voice.source.disconnect();
    voice.gain.disconnect();
    voice.pan.disconnect();
    voice.anchor.srcObject = null;
  }

  dispose() {
    for (const id of [...this.voices.keys()]) this.drop(id);
    void this.context.close().catch(() => undefined);
  }
}

export class LevelMeter {
  private readonly analyser: AnalyserNode;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly buffer: Uint8Array<ArrayBuffer>;

  constructor(context: AudioContext, stream: MediaStream) {
    this.source = context.createMediaStreamSource(stream);
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.buffer = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
    this.source.connect(this.analyser);
  }

  read() {
    this.analyser.getByteTimeDomainData(this.buffer);
    let sum = 0;
    for (const value of this.buffer) {
      const centered = (value - 128) / 128;
      sum += centered * centered;
    }
    return Math.min(1, Math.sqrt(sum / this.buffer.length) * 4);
  }

  dispose() {
    this.source.disconnect();
    this.analyser.disconnect();
  }
}
