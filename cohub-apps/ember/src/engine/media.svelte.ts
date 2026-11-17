import type { AppDevice, CohubClient } from "@neta-art/cohub";
import { type Point, voiceVolume } from "../camp/world.ts";
import { LevelMeter, VoiceMixer } from "../net/audio.ts";
import { CAMERA_RANGE, cameraQuality, type CameraQuality, type MediaCandidate, selectCampMedia } from "../net/media-policy.ts";
import type { CampSession, RemoteTrack } from "../net/session.ts";
import type { World } from "./world.ts";

export type DeviceNotice = "micUnavailable" | "cameraUnavailable" | "deviceDenied" | "deviceUnavailable" | "noRtc" | "cameraLocal";

export class CampMedia {
  mic = $state(false);
  localCamera = $state.raw<MediaStreamTrack | null>(null);
  cameras = $state.raw<RemoteTrack[]>([]);
  requesting = $state<AppDevice | null>(null);
  level = 0;

  private mixer: VoiceMixer | null = null;
  private meter: LevelMeter | null = null;
  private track: MediaStreamTrack | null = null;
  private pending: MediaStreamTrack | null = null;
  private pendingCamera: MediaStreamTrack | null = null;
  private requestEpoch = 0;
  private readonly voices = new Map<string, MediaStreamTrack>();
  private readonly qualities = new Map<MediaStreamTrack, CameraQuality>();
  private readonly qualityPending = new Set<MediaStreamTrack>();
  private qualityAt = 0;
  private visible = true;

  constructor(
    private readonly client: CohubClient,
    private readonly world: World,
    private readonly hooks: {
      session(): CampSession | null;
      notice(notice: DeviceNotice): void;
      beforeGrant(device: AppDevice): void;
      afterGrant(): void;
      cameraVisible?(point: Point): boolean;
    },
  ) {}

  wake() {
    this.mixer ??= new VoiceMixer();
    void this.mixer.resume();
    this.mixer.sync(this.voices);
  }

  async toggleMic() {
    if (this.track) {
      this.mic = !this.mic;
      this.track.enabled = this.mic;
      return;
    }
    const epoch = this.requestEpoch;
    const track = await this.acquire("microphone");
    if (!track) return;
    if (epoch !== this.requestEpoch || !this.hooks.session()) { track.stop(); return; }
    this.wake();
    this.track = track;
    this.meter = this.mixer ? new LevelMeter(this.mixer.context, new MediaStream([track])) : null;
    this.mic = true;
    track.addEventListener("ended", () => {
      if (this.track !== track) return;
      this.track = null;
      this.pending = null;
      this.meter?.dispose();
      this.meter = null;
      this.mic = false;
      void this.hooks.session()?.stopMic();
    }, { once: true });
    await this.publish(track);
  }

  async toggleCamera() {
    if (this.localCamera) {
      await this.closeCamera();
      return;
    }
    const epoch = this.requestEpoch;
    const track = await this.acquire("camera");
    if (!track) return;
    if (epoch !== this.requestEpoch || !this.hooks.session()) { track.stop(); return; }
    this.localCamera = track;
    track.addEventListener("ended", () => {
      if (this.localCamera === track) void this.closeCamera();
    }, { once: true });
    await this.publishCamera(track);
  }

  private async closeCamera() {
    const track = this.localCamera;
    this.localCamera = null;
    this.pendingCamera = null;
    track?.stop();
    await this.hooks.session()?.stopCamera();
  }

  private async acquire(device: "microphone" | "camera"): Promise<MediaStreamTrack | null> {
    const session = this.hooks.session();
    if (!session || this.requesting) return null;
    const epoch = this.requestEpoch;
    const current = () => epoch === this.requestEpoch && session === this.hooks.session();
    this.requesting = device;
    try {
      this.hooks.beforeGrant(device);
      const status = await this.client.app.devices.request([device]).catch(() => "unavailable" as const);
      if (!current()) return null;
      this.hooks.afterGrant();
      if (status !== "granted") {
        this.hooks.notice(status === "denied" ? "deviceDenied" : "deviceUnavailable");
        return null;
      }
      const constraints: MediaStreamConstraints = device === "camera"
        ? { audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 20, max: 24 }, facingMode: "user" } }
        : { video: false, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
      const stream = await navigator.mediaDevices.getUserMedia(constraints).catch(() => null);
      if (!current()) {
        for (const track of stream?.getTracks() ?? []) track.stop();
        return null;
      }
      const track = device === "camera" ? stream?.getVideoTracks()[0] : stream?.getAudioTracks()[0];
      if (!current() || !track || track.readyState === "ended") {
        for (const track of stream?.getTracks() ?? []) track.stop();
        if (current()) this.hooks.notice(device === "camera" ? "cameraUnavailable" : "micUnavailable");
        return null;
      }
      for (const extra of stream?.getTracks() ?? []) if (extra !== track) extra.stop();
      return track;
    } finally {
      if (epoch === this.requestEpoch) this.requesting = null;
    }
  }

  private async publish(track: MediaStreamTrack) {
    const session = this.hooks.session();
    if (!session?.peerReady) {
      this.pending = track;
      return;
    }
    await session.publishMic(track).catch(() => {
      if (this.track === track) this.hooks.notice("noRtc");
    });
  }

  private async publishCamera(track: MediaStreamTrack) {
    const session = this.hooks.session();
    if (!session?.peerReady) {
      this.pendingCamera = track;
      this.hooks.notice("cameraLocal");
      return;
    }
    try {
      await session.publishCamera(track);
    } catch {
      if (this.localCamera !== track) return;
      await this.closeCamera();
      this.hooks.notice("cameraUnavailable");
    }
  }

  async flush() {
    if (!this.hooks.session()?.peerReady) return;
    const mic = this.pending;
    const camera = this.pendingCamera;
    this.pending = null;
    this.pendingCamera = null;
    await Promise.all([
      mic && mic.readyState !== "ended" ? this.publish(mic) : Promise.resolve(),
      camera && camera.readyState !== "ended" ? this.publishCamera(camera) : Promise.resolve(),
    ]);
  }

  onTracks(tracks: readonly RemoteTrack[]) {
    this.voices.clear();
    for (const track of tracks) if (track.kind === "audio") this.voices.set(track.participantId, track.track);
    this.mixer?.sync(this.voices);
    this.cameras = tracks.filter((track) => track.kind === "video" && track.name === "cam");
    const live = new Set(this.cameras.map((camera) => camera.track));
    for (const track of this.qualities.keys()) if (!live.has(track)) this.qualities.delete(track);
    this.qualityAt = 0;
  }

  cameraPosition(participantId: string) {
    const body = this.world.body(participantId);
    if (!body) return null;
    return { distance: Math.hypot(body.x - this.world.self.x, body.y - this.world.self.y),
      visible: this.visible && (this.hooks.cameraVisible?.(body) ?? true) };
  }

  plan = (candidates: readonly MediaCandidate[]) => selectCampMedia(candidates, (id) => {
    const body = this.world.body(id);
    const camera = this.cameraPosition(id);
    if (!body || !camera) return null;
    return { ...camera, distance: camera.distance, hearing: this.world.distanceTo(body) };
  });

  setVisible(visible: boolean) {
    this.visible = visible;
    this.hooks.session()?.selectMedia(this.plan);
  }

  frame(now: number) {
    this.level = this.mic && this.meter ? this.meter.read() : 0;
    this.world.self.level = this.level;
    this.world.self.mic = this.mic;
    const bodies = this.world.bodies(now);
    this.world.cameras.clear();
    if (this.localCamera) this.world.cameras.add(this.world.self.id);
    for (const camera of this.cameras) {
      const at = this.cameraPosition(camera.participantId);
      if (at?.visible && at.distance < CAMERA_RANGE) this.world.cameras.add(camera.participantId);
    }
    if (this.mixer && this.voices.size) {
      this.mixer.place(this.world.self, bodies.filter((body) => this.voices.has(body.id))
        .map((body) => ({ id: body.id, x: body.x, volume: voiceVolume(this.world.distanceTo(body)) })));
    }
    if (now - this.qualityAt < 700 || !this.visible) return;
    this.qualityAt = now;
    for (const camera of this.cameras) {
      const at = this.cameraPosition(camera.participantId);
      const quality = at?.visible ? cameraQuality(at.distance) : "low";
      if (this.qualities.get(camera.track) === quality || this.qualityPending.has(camera.track)) continue;
      const epoch = this.requestEpoch;
      this.qualityPending.add(camera.track);
      void camera.setQuality(quality).then(() => {
        if (epoch === this.requestEpoch && this.cameras.some((live) => live.track === camera.track)) this.qualities.set(camera.track, quality);
      }).catch(() => {}).finally(() => this.qualityPending.delete(camera.track));
    }
  }

  async playSpirit(url: string, participantId: string) {
    this.wake();
    if (!this.mixer) return 0;
    return this.mixer.play(url, () => {
      const body = this.world.body(participantId);
      return body ? Math.max(0.35, voiceVolume(this.world.distanceTo(body))) : 0.7;
    });
  }

  stop() {
    this.requestEpoch += 1;
    this.requesting = null;
    this.hooks.afterGrant();
    this.track?.stop();
    this.localCamera?.stop();
    this.meter?.dispose();
    this.mixer?.dispose();
    this.track = null;
    this.pending = null;
    this.pendingCamera = null;
    this.localCamera = null;
    this.cameras = [];
    this.world.cameras?.clear();
    this.qualities.clear();
    this.qualityPending.clear();
    this.meter = null;
    this.mixer = null;
    this.voices.clear();
    this.mic = false;
    this.level = 0;
  }
}
