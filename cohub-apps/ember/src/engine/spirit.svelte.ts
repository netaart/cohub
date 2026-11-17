import type { CohubClient } from "@neta-art/cohub";
import { EVENTS, type GoneData, LIVE_WINDOW_MS, readText, SUMMON_WINDOW_MS } from "../camp/protocol.ts";
import type { CampSession, Member } from "../net/session.ts";

const WATCH_INTERVAL_MS = 2500;

export type SpiritEvent = { type: string; data: unknown; at: number; participantId: string; self: boolean; sequence: number };

export class SpiritControl {
  summoning = $state(false);
  speaking = $state(false);

  private claim: { sequence: number; at: number } | null = null;

  constructor(
    private readonly client: CohubClient,
    private readonly host: {
      session(): CampSession | null;
      members(): readonly Member[];
      locale(): "en" | "zh";
      name(): string;
      fail(reason: "busy" | "awake" | "failed", detail: string): void;
      gone(reason: GoneData["reason"]): void;
      voice(url: string, participantId: string): Promise<number>;
    },
  ) {}

  get member() {
    return this.host.members().find((member) => member.spirit) ?? null;
  }

  get present() {
    return this.member !== null;
  }

  async summon() {
    const session = this.host.session();
    if (!session || this.present || this.summoning) return;
    this.summoning = true;
    try {
      await session.publish(EVENTS.summon, { name: this.host.name() });
    } catch {
      this.summoning = false;
      this.host.fail("failed", "");
    }
  }

  async dismiss() {
    await this.host.session()?.publish(EVENTS.dismiss, {});
  }

  handle(event: SpiritEvent, replaying: boolean) {
    const live = !replaying && Date.now() - event.at < LIVE_WINDOW_MS;
    switch (event.type) {
      case EVENTS.summon:
        return this.onSummon(event, live);
      case EVENTS.speak:
        if (this.owns(event)) this.summoning = false;
        return;
      case EVENTS.voice: {
        const audio = (event.data as { audio?: unknown } | null)?.audio;
        if (live && this.owns(event) && typeof audio === "string" && /^https:\/\//.test(audio)) void this.play(audio, event.participantId);
        return;
      }
      case EVENTS.gone: {
        this.claim = null;
        this.summoning = false;
        this.speaking = false;
        const reason = (event.data as Partial<GoneData> | null)?.reason;
        if (live) this.host.gone(reason ?? "ended");
        return;
      }
      default:
        return;
    }
  }

  tick() {
    if (this.present) {
      this.summoning = false;
      return;
    }
    if (this.claim && Date.now() - this.claim.at > SUMMON_WINDOW_MS) {
      this.claim = null;
      this.summoning = false;
    }
  }

  reset() {
    this.claim = null;
    this.summoning = false;
    this.speaking = false;
  }

  private owns(event: SpiritEvent) {
    return this.host.members().some((member) => member.participantId === event.participantId && member.spirit);
  }

  private onSummon(event: SpiritEvent, live: boolean) {
    if (this.present) return;
    if (this.claim && event.at - this.claim.at < SUMMON_WINDOW_MS) return;
    this.claim = { sequence: event.sequence, at: event.at };
    if (!live) return;
    this.summoning = true;
    if (event.self) void this.wake();
  }

  private async wake() {
    const session = this.host.session();
    if (!session) return;
    try {
      const { invite } = await session.invite(600);
      const { taskRunId } = await this.client.app.actions.run({
        action: "spirit",
        input: { invite, locale: this.host.locale(), by: readText(this.host.name(), 24) },
      });
      await this.watch(taskRunId);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async watch(taskRunId: string) {
    const deadline = Date.now() + SUMMON_WINDOW_MS;
    while (Date.now() < deadline && this.summoning && !this.present) {
      await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
      const detail = await this.client.tasks.get(taskRunId).catch(() => null);
      if (detail?.run.status === "failed") return this.fail(detail.run.errorMessage ?? "");
      if (detail?.run.status === "completed" && !this.present) return this.fail("");
    }
  }

  private fail(reason: string) {
    this.summoning = false;
    this.claim = null;
    const detail = reason.trim().split("\n").at(-1)?.slice(0, 160) ?? "";
    if (detail.includes("SPIRIT_BUSY")) return this.host.fail("busy", detail);
    if (detail.includes("SPIRIT_ALREADY_AWAKE")) return this.host.fail("awake", detail);
    this.host.fail("failed", detail);
  }

  private async play(url: string, participantId: string) {
    this.speaking = true;
    const duration = await this.host.voice(url, participantId).catch(() => 0);
    setTimeout(() => (this.speaking = false), Math.max(1500, duration));
  }
}
