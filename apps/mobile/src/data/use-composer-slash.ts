import type { PromptTemplateCatalogEntry, SkillCatalogEntry } from "@neta-art/cohub";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { useApp } from "@/src/data/context";
import {
  detectSlashCommandTrigger,
  insertSlashCommand,
  selectSlashCommandItems,
  type SlashCommandItem,
  type SlashCommandTrigger,
} from "@/src/data/slash-commands";

export type SlashCommandMenuState = {
  query: string;
  items: SlashCommandItem[];
  loading: boolean;
  failed: boolean;
};

type Catalog = {
  userUuid: string;
  spaceId: string;
  prompts: PromptTemplateCatalogEntry[];
  skills: SkillCatalogEntry[];
};

// Catalogs are per user and Space, and never survive a sign-out: the cache key
// includes the authenticated user so a different account cannot read it.
let cachedCatalog: Catalog | null = null;

export function clearSlashCommandCache() {
  cachedCatalog = null;
}

/**
 * Composer `/` commands. Detection and insertion are text-only — the server
 * expands `/name` and `/skill:name` when the turn starts — so this hook only
 * loads the two catalogs and keeps the menu state.
 */
export function useComposerSlashCommands({ value, onChange, spaceId, composer }: {
  value: string;
  onChange: (markup: string) => void;
  spaceId: string | null;
  composer: { current: { input: TextInput | null } };
}) {
  const { client, userUuid } = useApp();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [focused, setFocused] = useState(false);
  // Set when the user picks a command or closes the menu; cleared by the next edit.
  const [dismissedText, setDismissedText] = useState<string | null>(null);
  const valueRef = useRef(value);
  const requestRef = useRef(0);
  useEffect(() => { valueRef.current = value; }, [value]);

  const scope = spaceId ? `${userUuid}:${spaceId}` : `${userUuid}:`;
  const scoped = catalog?.userUuid === userUuid && catalog.spaceId === (spaceId ?? "") ? catalog : null;

  const load = useCallback(async () => {
    if (!client || !spaceId) return;
    const key = `${userUuid}:${spaceId}`;
    if (cachedCatalog && `${cachedCatalog.userUuid}:${cachedCatalog.spaceId}` === key) {
      setCatalog(cachedCatalog);
      return;
    }
    const generation = ++requestRef.current;
    setLoading(true);
    setFailed(false);
    try {
      const options = { spaceId };
      const [prompts, skills] = await Promise.all([client.prompts.list(options), client.skills.list(options)]);
      if (generation !== requestRef.current) return;
      const next: Catalog = { userUuid, spaceId, prompts: prompts.prompts, skills: skills.skills };
      cachedCatalog = next;
      setCatalog(next);
    } catch {
      if (generation !== requestRef.current) return;
      // Missing permission or a network failure leaves typing and sending intact.
      setFailed(true);
    } finally {
      if (generation === requestRef.current) setLoading(false);
    }
  }, [client, spaceId, userUuid]);

  const trigger = useMemo<SlashCommandTrigger | null>(() => (focused ? detectSlashCommandTrigger(value) : null), [focused, value]);
  const open = trigger !== null && value !== dismissedText;
  // Any edit re-arms a dismissed menu, matching the web composer's slash state.
  if (dismissedText !== null && dismissedText !== value) setDismissedText(null);

  useEffect(() => {
    if (!open) return;
    // Deferred so opening the menu does not set state during the effect body.
    queueMicrotask(() => { void load().catch(() => undefined); });
  }, [load, open, scope]);

  // Drafts restore asynchronously; a cached catalog for this scope shows up before the request lands.
  const menu = useMemo<SlashCommandMenuState | null>(() => {
    if (!open || !trigger) return null;
    return {
      query: trigger.query,
      items: selectSlashCommandItems({ prompts: scoped?.prompts ?? [], skills: scoped?.skills ?? [], query: trigger.query }),
      loading: loading || scoped === null,
      failed,
    };
  }, [failed, loading, open, scoped, trigger]);

  const select = useCallback((item: SlashCommandItem) => {
    const current = valueRef.current;
    const active = detectSlashCommandTrigger(current);
    if (!active) return;
    const result = insertSlashCommand(current, active, item);
    valueRef.current = result.markup;
    setDismissedText(result.markup);
    onChange(result.markup);
    requestAnimationFrame(() => {
      composer.current.input?.focus();
      composer.current.input?.setSelection(result.caret, result.caret);
    });
  }, [composer, onChange]);

  const dismiss = useCallback(() => setDismissedText(valueRef.current), []);
  const onFocusChange = useCallback((next: boolean) => setFocused(next), []);

  return {
    menu,
    select,
    dismiss,
    onFocusChange,
  };
}
