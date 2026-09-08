import { createHighlighterCore, type HighlighterCore, type LanguageRegistration, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { resolveCodeLanguage, type CodeLanguageId } from "@/src/data/code-language";

export type CodeHighlightTheme = "github-light" | "github-dark";

export type HighlightedCode = {
  lines: ThemedToken[][];
  foreground: string;
  background: string;
  theme: CodeHighlightTheme;
};

/** Above this size, rendering falls back to plain monospace text instead of blocking the JS thread. */
const MAX_HIGHLIGHT_CHARS = 40_000;

const RESULT_CACHE_LIMIT = 64;
const RESULT_CACHE_CHAR_LIMIT = 512 * 1024;

type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

const LANGUAGE_LOADERS: Record<CodeLanguageId, LanguageLoader> = {
  bash: () => import("@shikijs/langs/bash"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  css: () => import("@shikijs/langs/css"),
  diff: () => import("@shikijs/langs/diff"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  go: () => import("@shikijs/langs/go"),
  graphql: () => import("@shikijs/langs/graphql"),
  html: () => import("@shikijs/langs/html"),
  ini: () => import("@shikijs/langs/ini"),
  java: () => import("@shikijs/langs/java"),
  javascript: () => import("@shikijs/langs/javascript"),
  json: () => import("@shikijs/langs/json"),
  jsx: () => import("@shikijs/langs/jsx"),
  markdown: () => import("@shikijs/langs/markdown"),
  mermaid: () => import("@shikijs/langs/mermaid"),
  protobuf: () => import("@shikijs/langs/protobuf"),
  python: () => import("@shikijs/langs/python"),
  rust: () => import("@shikijs/langs/rust"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  toml: () => import("@shikijs/langs/toml"),
  tsx: () => import("@shikijs/langs/tsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  xml: () => import("@shikijs/langs/xml"),
  yaml: () => import("@shikijs/langs/yaml"),
};

type CacheEntry = { result: HighlightedCode; chars: number };

let highlighterPromise: Promise<HighlighterCore> | null = null;
let settledHighlighter: HighlighterCore | null = null;
const languageLoads = new Map<CodeLanguageId, Promise<void>>();
const resultCache = new Map<string, CacheEntry>();
let cachedChars = 0;

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cacheKey(code: string, language: CodeLanguageId, theme: CodeHighlightTheme) {
  return `${theme}:${language}:${code.length}:${hashString(code)}`;
}

function cacheResult(key: string, code: string, result: HighlightedCode) {
  const existing = resultCache.get(key);
  if (existing) {
    resultCache.delete(key);
    cachedChars -= existing.chars;
  }
  resultCache.set(key, { result, chars: code.length });
  cachedChars += code.length;
  while (resultCache.size > RESULT_CACHE_LIMIT || cachedChars > RESULT_CACHE_CHAR_LIMIT) {
    const oldestKey = resultCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = resultCache.get(oldestKey);
    resultCache.delete(oldestKey);
    cachedChars -= oldest?.chars ?? 0;
  }
}

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      // The JavaScript regex engine is the only shiki engine that runs on Hermes;
      // ES2018 keeps generated patterns within Hermes' supported RegExp syntax.
      engine: createJavaScriptRegexEngine({ target: "ES2018" }),
      themes: [import("@shikijs/themes/github-light"), import("@shikijs/themes/github-dark")],
      langs: [],
    }).then((highlighter) => {
      settledHighlighter = highlighter;
      return highlighter;
    }).catch((error: unknown) => {
      highlighterPromise = null;
      throw error;
    });
  }
  return highlighterPromise;
}

async function ensureLanguage(highlighter: HighlighterCore, language: CodeLanguageId) {
  if (highlighter.getLoadedLanguages().includes(language)) return;
  const pending = languageLoads.get(language);
  if (pending) {
    await pending;
    return;
  }
  const load = highlighter.loadLanguage(await LANGUAGE_LOADERS[language]()).finally(() => {
    languageLoads.delete(language);
  });
  languageLoads.set(language, load);
  await load;
}

function tokenize(highlighter: HighlighterCore, code: string, language: CodeLanguageId, theme: CodeHighlightTheme): HighlightedCode {
  const result = highlighter.codeToTokens(code, { lang: language, theme });
  return {
    lines: result.tokens,
    foreground: result.fg ?? "#1f2328",
    background: result.bg ?? "transparent",
    theme,
  };
}

/** Highlight synchronously when the highlighter and grammar are already loaded; otherwise `null`. */
export function highlightCodeSync(code: string, language: CodeLanguageId, theme: CodeHighlightTheme): HighlightedCode | null {
  if (code.length > MAX_HIGHLIGHT_CHARS || !settledHighlighter) return null;
  if (!settledHighlighter.getLoadedLanguages().includes(language)) return null;
  const key = cacheKey(code, language, theme);
  const cached = resultCache.get(key);
  if (cached) return cached.result;
  try {
    const result = tokenize(settledHighlighter, code, language, theme);
    cacheResult(key, code, result);
    return result;
  } catch {
    return null;
  }
}

export async function highlightCode(code: string, language: string | null, theme: CodeHighlightTheme): Promise<HighlightedCode | null> {
  const languageId = resolveCodeLanguage(language);
  if (!languageId || code.length > MAX_HIGHLIGHT_CHARS) return null;
  const key = cacheKey(code, languageId, theme);
  const cached = resultCache.get(key);
  if (cached) return cached.result;
  const highlighter = await getHighlighter();
  await ensureLanguage(highlighter, languageId);
  try {
    const result = tokenize(highlighter, code, languageId, theme);
    cacheResult(key, code, result);
    return result;
  } catch {
    // Unsupported grammar patterns fall back to plain text in the caller.
    return null;
  }
}

export function getCachedHighlightedCode(code: string, language: string | null, theme: CodeHighlightTheme): HighlightedCode | null {
  const languageId = resolveCodeLanguage(language);
  if (!languageId) return null;
  return resultCache.get(cacheKey(code, languageId, theme))?.result ?? null;
}
