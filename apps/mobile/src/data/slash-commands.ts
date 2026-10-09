import type { PromptTemplateCatalogEntry, SkillCatalogEntry } from "@neta-art/cohub";

/**
 * Composer slash commands, ported from the Cohub web composer.
 *
 * A slash command is plain text: the draft keeps `/name` or `/skill:name` and
 * the server expands it into the template or skill body when the turn starts.
 * This module only detects the token, ranks the catalog, and rewrites the text.
 */

export type SlashCommandTrigger = { start: number; end: number; query: string };

export type SlashCommandItem = {
  kind: "prompt" | "skill";
  name: string;
  description: string;
  scope: PromptTemplateCatalogEntry["scope"];
  argumentHint?: string;
  category?: string;
  matchScore: number;
};

// Kept identical to the web composer's limits.
const SCAN_LIMIT = 160;
const QUERY_LIMIT = 80;
const SUGGESTION_LIMIT = 50;

/** The canonical text a command inserts; skills keep the `/skill:` prefix. */
export function slashCommandText(item: { kind: "prompt" | "skill"; name: string }) {
  return item.kind === "skill" ? `/skill:${item.name}` : `/${item.name}`;
}

/** Label shown in the menu: skills are prefixed so they read apart from prompts. */
export function slashCommandLabel(item: { kind: "prompt" | "skill"; name: string }) {
  return item.kind === "skill" ? `skill:${item.name}` : item.name;
}

/**
 * The active `/query` token, or null. Like the web composer the slash only
 * counts at the very start of the draft, and the token ends at the first
 * whitespace once an argument is typed.
 */
export function detectSlashCommandTrigger(text: string): SlashCommandTrigger | null {
  const scanned = text.slice(0, SCAN_LIMIT + 1);
  const firstNonWhitespace = scanned.search(/\S/);
  if (firstNonWhitespace === -1 || scanned[firstNonWhitespace] !== "/") return null;
  const afterSlash = scanned.slice(firstNonWhitespace + 1);
  if (afterSlash.search(/\s/) !== -1) return null;
  if (afterSlash.length > QUERY_LIMIT) return null;
  if (text.length > scanned.length) return null;
  return { start: firstNonWhitespace, end: firstNonWhitespace + 1 + afterSlash.length, query: afterSlash };
}

/** Same tiers as the web composer: name prefix, substring, category, description. */
function matchScore(query: string, name: string, category: string, description: string, extra: readonly string[]) {
  if (!query) return 100;
  if (name.startsWith(query)) return 100;
  if (name.includes(query)) return 80;
  if (category.includes(query)) return 64;
  if (extra.some((value) => value.includes(query))) return 64;
  if (description.includes(query)) return 48;
  return 0;
}

export function selectSlashCommandItems(input: {
  prompts: readonly PromptTemplateCatalogEntry[];
  skills: readonly SkillCatalogEntry[];
  query: string;
}): SlashCommandItem[] {
  const query = input.query.toLowerCase();
  const items: SlashCommandItem[] = [];
  for (const prompt of input.prompts) {
    const score = matchScore(query, prompt.name.toLowerCase(), prompt.category?.toLowerCase() ?? "", prompt.description.toLowerCase(), []);
    if (score === 0) continue;
    items.push({
      kind: "prompt",
      name: prompt.name,
      description: prompt.description,
      scope: prompt.scope,
      matchScore: score,
      ...(prompt.argumentHint ? { argumentHint: prompt.argumentHint } : {}),
      ...(prompt.category ? { category: prompt.category } : {}),
    });
  }
  for (const skill of input.skills) {
    const label = `skill:${skill.name}`.toLowerCase();
    const name = skill.name.toLowerCase();
    // An empty query lists every command at the top tier, so the sort's kind
    // tiebreak (prompt < skill) decides the order, matching the web composer.
    let score: number;
    if (!query) score = 100;
    else if (label.startsWith(query) || name.startsWith(query)) score = 100;
    else if (label.includes(query) || name.includes(query)) score = 80;
    else if ((skill.source?.mountSlug.toLowerCase() ?? "").includes(query)) score = 64;
    else if (skill.description.toLowerCase().includes(query)) score = 48;
    else score = 0;
    if (score === 0) continue;
    items.push({ kind: "skill", name: skill.name, description: skill.description, scope: skill.scope, matchScore: score });
  }
  return items
    .sort((left, right) => {
      if (right.matchScore !== left.matchScore) return right.matchScore - left.matchScore;
      if (left.kind !== right.kind) return left.kind.localeCompare(right.kind);
      const leftScope = left.category ?? left.scope;
      const rightScope = right.category ?? right.scope;
      if (leftScope !== rightScope) return leftScope.localeCompare(rightScope);
      return left.name.localeCompare(right.name);
    })
    .slice(0, SUGGESTION_LIMIT);
}

/**
 * Replaces the active token with the command text, leaving room for arguments.
 * Leading whitespace survives because the trigger is measured on the raw draft.
 */
export function insertSlashCommand(text: string, trigger: SlashCommandTrigger, item: { kind: "prompt" | "skill"; name: string }) {
  const head = `${text.slice(0, trigger.start)}${slashCommandText(item)} `;
  // Swallow one leading space from the remainder so re-picking a command does not stack spaces.
  const rest = text.slice(trigger.end);
  const tail = rest.startsWith(" ") ? rest.slice(1) : rest;
  return { markup: head + tail, caret: head.length };
}
