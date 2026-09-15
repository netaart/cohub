import { readFile } from "node:fs/promises";
import type { GenerationContentBlock } from "@neta-art/cohub";
import { error } from "./output.js";

export const SUNO_MODEL = "suno_music_chirp_fenix";

export type SunoInputOptions = {
  model: string; mode?: string; prompt?: string; lyricsFile?: string;
  style?: string; title?: string; instrumental?: boolean; meta?: string;
  hasMedia?: boolean;
};

export async function resolveSunoInput(options: SunoInputOptions): Promise<{
  prompt?: string; content: GenerationContentBlock[]; meta?: Record<string, unknown>;
}> {
  const fields = options.lyricsFile || options.style !== undefined || options.title !== undefined || options.instrumental;
  if (!options.mode && (options.model !== SUNO_MODEL || !fields)) {
    if (!options.prompt?.trim()) return error("Invalid prompt", "Prompt text is required");
    return { prompt: options.prompt, content: [{ type: "text", text: options.prompt ?? "" }], meta: options.meta ? JSON.parse(options.meta) : undefined };
  }
  if (options.model !== SUNO_MODEL) return error("Invalid Suno mode", "--mode and Suno options only support suno_music_chirp_fenix");
  if (!options.mode || !["simple", "custom"].includes(options.mode)) return error("Invalid Suno mode", "--mode must be simple or custom");
  if (options.meta) return error("Invalid Suno input", "--mode cannot be combined with --meta");
  if (options.hasMedia) return error("Invalid Suno input", "--mode cannot be combined with media inputs");
  if (options.mode === "simple") {
    if (!options.prompt?.trim()) return error("Invalid Suno input", "Simple mode requires a non-empty song description");
    if (options.lyricsFile || options.style !== undefined || options.title !== undefined) return error("Invalid Suno input", "Simple mode accepts only a description and --instrumental");
    return { content: [{ type: "text", text: options.prompt }], meta: { gpt_description_prompt: options.prompt, make_instrumental: Boolean(options.instrumental) } };
  }
  if (options.instrumental) return error("Invalid Suno input", "Custom mode cannot use --instrumental; use --mode simple");
  if (options.prompt && options.lyricsFile) return error("Invalid Suno input", "Custom lyrics may be provided by prompt or --lyrics-file, not both");
  const lyrics = options.lyricsFile ? await readFile(options.lyricsFile, "utf8").catch(() => error("Invalid lyrics file", "Unable to read --lyrics-file")) : options.prompt;
  if (!lyrics?.trim()) return error("Invalid Suno input", "Custom mode requires non-empty lyrics");
  const meta: Record<string, unknown> = { make_instrumental: false };
  if (options.style?.trim()) meta.tags = options.style; else if (options.style !== undefined) return error("Invalid Suno input", "--style cannot be empty");
  if (options.title?.trim()) meta.title = options.title; else if (options.title !== undefined) return error("Invalid Suno input", "--title cannot be empty");
  return { content: [{ type: "text", text: lyrics }], meta };
}
