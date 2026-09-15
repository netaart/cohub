import { readFile } from "node:fs/promises";
import type { GenerationContentBlock } from "@neta-art/cohub";
import { error } from "./output.js";

export const SUNO_MODEL = "suno_music_chirp_fenix";

export type SunoInputOptions = {
  model: string; prompt?: string; lyrics?: string; lyricsFile?: string;
  style?: string; title?: string; instrumental?: boolean; meta?: string;
  hasMedia?: boolean;
};

export async function resolveSunoInput(options: SunoInputOptions): Promise<{
  prompt?: string; content: GenerationContentBlock[]; meta?: Record<string, unknown>;
}> {
  if (options.model !== SUNO_MODEL) {
    if (!options.prompt?.trim()) return error("Invalid prompt", "Prompt text is required");
    return { prompt: options.prompt, content: [{ type: "text", text: options.prompt ?? "" }], meta: options.meta ? JSON.parse(options.meta) : undefined };
  }
  if (options.meta) return { content: [{ type: "text", text: options.prompt }], meta: JSON.parse(options.meta) as Record<string, unknown> };
  if (options.hasMedia) return error("Invalid Suno input", "Suno lyrics options cannot be combined with media inputs");
  if (!options.prompt?.trim()) return error("Invalid prompt", "Prompt text is required");
  if (options.lyrics !== undefined && options.lyricsFile) return error("Invalid Suno input", "Use --lyrics or --lyrics-file, not both");
  const lyrics = options.lyricsFile ? await readFile(options.lyricsFile, "utf8").catch(() => error("Invalid lyrics file", "Unable to read --lyrics-file")) : options.lyrics;
  const meta: Record<string, unknown> = { gpt_description_prompt: options.prompt, make_instrumental: Boolean(options.instrumental) };
  if (lyrics !== undefined) {
    if (!lyrics.trim()) return error("Invalid Suno input", "Lyrics must not be empty");
    delete meta.gpt_description_prompt;
  }
  if (options.style?.trim()) meta.tags = options.style; else if (options.style !== undefined) return error("Invalid Suno input", "--style cannot be empty");
  if (options.title?.trim()) meta.title = options.title; else if (options.title !== undefined) return error("Invalid Suno input", "--title cannot be empty");
  return { content: [{ type: "text", text: lyrics ?? options.prompt }], meta };
}
