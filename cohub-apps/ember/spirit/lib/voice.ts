import type { CohubClient } from "@neta-art/cohub";
import { LIMITS, type Locale, VOICE } from "./mind.ts";

type Declaration = {
  model: string;
  hidden?: boolean;
  meta?: { fields?: Record<string, unknown> };
  content?: { input?: Array<{ type?: string }> };
};

// A model fits when it can design a voice (declares meta.voice_prompt) and clone one (takes audio input).
const canDesignAndClone = (model: Declaration) =>
  !model.hidden && Boolean(model.meta?.fields?.voice_prompt) && Boolean(model.content?.input?.some((input) => input.type === "audio"));

export class Voice {
  private readonly client: CohubClient;
  private readonly spaceId: string;
  private readonly locale: Locale;
  private model: string | null = null;
  private reference: string | null = null;

  constructor(client: CohubClient, spaceId: string, locale: Locale) {
    this.client = client;
    this.spaceId = spaceId;
    this.locale = locale;
  }

  async prepare() {
    try {
      const { models } = await this.client.models.listMultimodal();
      this.model = (models as Declaration[]).find(canDesignAndClone)?.model ?? null;
    } catch {
      this.model = null;
    }
    return this.model;
  }

  async speak(text: string): Promise<string | null> {
    if (!this.model || [...text].length < LIMITS.voiceMinChars) return null;
    const cloning = this.reference !== null;
    const result = await this.client.generations.createAndWait(
      {
        spaceId: this.spaceId,
        model: this.model,
        content: cloning
          ? [{ type: "text", text }, { type: "audio", source: { type: "url", url: this.reference as string } }]
          : [{ type: "text", text }],
        ...(cloning ? {} : { meta: { voice_prompt: VOICE[this.locale] } }),
      },
      { timeoutMs: 90_000 },
    );
    const url = result.output.find((block) => block.type === "audio" && block.source.type === "url");
    const audio = url && url.type === "audio" && url.source.type === "url" ? url.source.url : null;
    if (audio && !this.reference) this.reference = audio;
    return audio;
  }
}
