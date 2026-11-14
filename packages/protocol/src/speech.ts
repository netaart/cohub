export const SPEECH_CONFIG_PATH = ".cohub/speech.json";

export type SpeechVoice = {
  model: string;
  meta?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  references?: string[];
};

export type SpeechConfig = {
  tts?: SpeechVoice;
};

export type TurnSpeechSegment = {
  taskId: string;
  status: "pending" | "completed" | "failed";
  url?: string;
};

/** Stored per voice at `turn.meta.speech[voice]`, so members with different voices never overwrite each other. */
export type TurnSpeech = {
  voice: string;
  segments: TurnSpeechSegment[];
};

export type TurnSpeechTarget = {
  sessionId: string;
  turnId: string;
  voice: string;
  index: number;
};

export type SpeakTurnResponse = {
  speech: TurnSpeech;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHttpsUrl(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function parseVoice(value: unknown): SpeechVoice {
  if (!isRecord(value)) throw new Error("tts must be an object");
  const { model, meta, parameters, references } = value;
  if (typeof model !== "string" || !model.trim()) throw new Error("tts.model is required");
  if (meta !== undefined && !isRecord(meta)) throw new Error("tts.meta must be an object");
  if (parameters !== undefined && !isRecord(parameters)) throw new Error("tts.parameters must be an object");
  if (references !== undefined && !(Array.isArray(references) && references.every(isHttpsUrl))) {
    throw new Error("tts.references must be https URLs");
  }
  return {
    model: model.trim(),
    ...(meta ? { meta } : {}),
    ...(parameters ? { parameters } : {}),
    ...(references?.length ? { references: references as string[] } : {}),
  };
}

export function parseSpeechConfig(raw: string): SpeechConfig {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error(`${SPEECH_CONFIG_PATH} must be a JSON object`);
  return value.tts === undefined ? {} : { tts: parseVoice(value.tts) };
}

function readSegments(value: unknown): TurnSpeechSegment[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const valid = value.every((segment) =>
    isRecord(segment)
    && typeof segment.taskId === "string"
    && (segment.status === "pending" || segment.status === "completed" || segment.status === "failed")
    && (segment.url === undefined || typeof segment.url === "string"));
  return valid ? value as TurnSpeechSegment[] : null;
}

export function readTurnSpeech(meta: unknown, voice: string): TurnSpeech | null {
  const speech = isRecord(meta) && isRecord(meta.speech) ? meta.speech : null;
  const segments = speech ? readSegments(speech[voice]) : null;
  return segments ? { voice, segments } : null;
}

export function readTurnSpeechTarget(value: unknown): TurnSpeechTarget | null {
  if (!isRecord(value)) return null;
  const { sessionId, turnId, voice, index } = value;
  return typeof sessionId === "string" && typeof turnId === "string" && typeof voice === "string"
    && typeof index === "number" && Number.isSafeInteger(index) && index >= 0
    ? { sessionId, turnId, voice, index }
    : null;
}

export const SPEECH_MAX_CHARS = 6000;
const FIRST_SEGMENT_CHARS = 120;
const SEGMENT_CHARS = 480;
const MIN_SEGMENT_CHARS = 20;

const CJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/;
const TERMINAL = /[.!?。！？;；:：…,，、]$/;

const length = (text: string) => Array.from(text).length;

function plainLine(line: string) {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s*>+\s?/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/<https?:\/\/[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSpeechText(markdown: string): string {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const raw of markdown.split(/\r?\n/)) {
    const marker = raw.trimStart().match(/^(`{3,}|~{3,})/)?.[1];
    if (marker && (!fence || marker.startsWith(fence))) {
      fence = fence ? null : marker;
      continue;
    }
    if (fence || /^\s*\|?\s*:?-{3,}/.test(raw) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue;
    const cells = raw.trim().startsWith("|") ? raw.trim().replace(/^\||\|$/g, "").split("|") : [raw];
    const line = cells.map(plainLine).filter(Boolean).join(", ");
    if (!line) continue;
    lines.push(TERMINAL.test(line) ? line : `${line}${CJK.test(line.slice(-1)) ? "。" : "."}`);
  }
  return lines.join("\n");
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;…])|(?<=\.)(?=\s)|\n/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .flatMap((sentence) => {
      if (length(sentence) <= SEGMENT_CHARS) return [sentence];
      const parts: string[] = [];
      let rest = Array.from(sentence);
      while (rest.length > SEGMENT_CHARS) {
        const window = rest.slice(0, SEGMENT_CHARS).join("");
        const cut = Math.max(window.lastIndexOf("，"), window.lastIndexOf(", "), window.lastIndexOf("、"), window.lastIndexOf(" "));
        const size = cut > SEGMENT_CHARS / 2 ? Array.from(window.slice(0, cut + 1)).length : SEGMENT_CHARS;
        parts.push(rest.slice(0, size).join("").trim());
        rest = rest.slice(size);
      }
      return [...parts, rest.join("").trim()].filter(Boolean);
    });
}

export function toSpeechSegments(markdown: string): string[] {
  const segments: string[] = [];
  let current = "";
  let total = 0;
  for (const sentence of sentences(toSpeechText(markdown))) {
    total += length(sentence);
    if (total > SPEECH_MAX_CHARS) break;
    const limit = segments.length === 0 ? FIRST_SEGMENT_CHARS : SEGMENT_CHARS;
    if (current && length(current) >= MIN_SEGMENT_CHARS && length(current) + length(sentence) > limit) {
      segments.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) {
    const last = segments.length - 1;
    if (last >= 0 && length(current) < MIN_SEGMENT_CHARS) segments[last] = `${segments[last]} ${current}`;
    else segments.push(current);
  }
  return segments;
}
