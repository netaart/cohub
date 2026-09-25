import type { CohubClient, SessionRecord, SpaceRecord } from "@neta-art/cohub";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { useApp } from "@/src/data/context";
import { normalizeSearchQuery, useRemoteSearch } from "@/src/data/session-search";
import { personalSpaceActivity, selectSpaceList } from "@/src/data/space-list";
import {
  applyComposerDisplayEdit,
  cohubLinkKey,
  mentionDisplayText,
  detectSpaceMentionTrigger,
  draftMentions,
  findCohubLinks,
  insertSpaceMention,
  replaceCohubLinks,
  restoreDraftMentions,
  selectSpaceMentionSuggestions,
  type CohubLinkMatch,
  type CohubResourceLink,
  type SpaceMentionSuggestion,
  type TextSelection,
} from "@/src/data/space-mentions";

const SPACE_SEARCH_TYPES = ["space"] as const;
const LINK_RESOLVE_LIMIT = 20;

export type SpaceMentionMenuState = {
  query: string;
  items: SpaceMentionSuggestion[];
  loading: boolean;
  remoteFailed: boolean;
};

function compactText(value: string | null | undefined, fallback: string, limit: number) {
  const text = (value ?? "").replace(/\s+/g, " ").trim() || fallback;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function sessionMentionLabel(space: SpaceRecord, session: SessionRecord) {
  const label = `${compactText(space.name ?? space.title, `space:${space.id.slice(0, 8)}`, 32)}/${compactText(session.title, `session:${session.id.slice(0, 8)}`, 48)}`;
  return label.length > 72 ? `${label.slice(0, 71)}…` : label;
}

async function resolveLinkLabel(client: CohubClient, link: CohubResourceLink): Promise<string | null> {
  try {
    if (link.kind === "app") {
      const { app } = await client.apps.getBySlug(link.username, link.spaceSlug, link.appSlug);
      return app.meta?.title || app.meta?.name || app.slug;
    }
    if (link.sessionId) {
      const { space, session } = await client.space(link.spaceId).session(link.sessionId).get();
      return sessionMentionLabel(space, session);
    }
    const space = await client.space(link.spaceId).get();
    return space.name ?? space.title ?? null;
  } catch {
    // Missing permission, deleted resources, and network failures all keep the
    // pasted link as ordinary text, matching the web composer.
    return null;
  }
}

/**
 * Composer `@Space` mentions and Cohub link conversion. `value` is the draft
 * markup; the input renders `displayValue` and reports edits through
 * `onChangeText`, which maps them back onto the markup.
 */
export function useComposerMentions({ value, onChange, currentSpaceId, composer }: {
  value: string;
  onChange: (markup: string) => void;
  currentSpaceId: string | null;
  composer: { current: { input: TextInput | null } };
}) {
  const { client, state, spaceList, userUuid } = useApp();
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const valueRef = useRef(value);
  const selectionRef = useRef<TextSelection | null>(null);
  const pasteGeneration = useRef(0);
  // Mentions seen in this composer, kept after deletion so a cut-and-paste restores them.
  const knownMentions = useRef(new Map<string, string>());
  useEffect(() => {
    valueRef.current = value;
    for (const [label, markup] of draftMentions(value)) knownMentions.current.set(label, markup);
  }, [value]);
  useEffect(() => () => { pasteGeneration.current += 1; }, []);

  const displayValue = useMemo(() => mentionDisplayText(value), [value]);
  const trigger = useMemo(() => focused && selection ? detectSpaceMentionTrigger(value, selection) : null, [focused, selection, value]);
  if (!trigger && dismissedStart !== null) setDismissedStart(null);
  const open = trigger !== null && trigger.start !== dismissedStart;
  const query = open ? trigger.query : "";
  const remote = useRemoteSearch(client, query, { enabled: open, limit: 30, types: SPACE_SEARCH_TYPES });

  const refreshSpaceList = spaceList.refresh;
  useEffect(() => {
    if (!open) return;
    void refreshSpaceList({ silent: true }).catch(() => undefined).finally(() => setNow(Date.now()));
  }, [open, refreshSpaceList]);

  const listInput = useMemo(() => ({ spaces: state.spaces, sessions: state.sessions, overview: spaceList.overview, visits: spaceList.visits, personalActivity: personalSpaceActivity(Object.values(state.sessionViews), userUuid), now }), [now, spaceList.overview, spaceList.visits, state.sessionViews, state.sessions, state.spaces, userUuid]);
  const knownSpaceNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const space of spaceList.overview?.spaces ?? []) if (space.name?.trim()) names.set(space.id, space.name.trim());
    for (const space of state.spaces) if ((space.name ?? space.title)?.trim()) names.set(space.id, (space.name ?? space.title)!.trim());
    return names;
  }, [spaceList.overview, state.spaces]);

  const menu = useMemo<SpaceMentionMenuState | null>(() => {
    if (!open) return null;
    const normalized = normalizeSearchQuery(query);
    const remoteCurrent = remote.query === normalized;
    const items = selectSpaceMentionSuggestions({
      recent: selectSpaceList({ ...listInput, filter: "recent" }),
      spaces: selectSpaceList({ ...listInput, filter: "all" }),
      remote: remoteCurrent ? remote.spaces : [],
      query,
      currentSpaceId,
    });
    return {
      query,
      items,
      loading: (spaceList.loading && spaceList.overview === null) || (normalized.length >= 2 && (!remoteCurrent || remote.loading)),
      remoteFailed: remoteCurrent && remote.error !== null,
    };
  }, [currentSpaceId, listInput, open, query, remote.error, remote.loading, remote.query, remote.spaces, spaceList.loading, spaceList.overview]);

  const updateSelection = useCallback((next: TextSelection) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);

  const placeCaret = useCallback((caret: number) => {
    updateSelection({ start: caret, end: caret });
    requestAnimationFrame(() => composer.current.input?.setSelection(caret, caret));
  }, [composer, updateSelection]);

  const commit = useCallback((markup: string) => {
    valueRef.current = markup;
    onChange(markup);
  }, [onChange]);

  const resolvePastedLinks = useCallback((matches: CohubLinkMatch[]) => {
    if (!client || matches.length === 0) return;
    const generation = ++pasteGeneration.current;
    const pending = [...new Map(matches.map((match) => [cohubLinkKey(match.link), match.link])).values()].slice(0, LINK_RESOLVE_LIMIT);
    void Promise.all(pending.map(async (link) => [cohubLinkKey(link), await resolveLinkLabel(client, link)] as const)).then((entries) => {
      if (generation !== pasteGeneration.current) return;
      const labels = new Map(entries.filter((entry): entry is readonly [string, string] => entry[1] !== null));
      if (labels.size === 0) return;
      const current = valueRef.current;
      // Links are only replaced where the pasted text is still untouched.
      const next = replaceCohubLinks(current, matches, (link) => labels.get(cohubLinkKey(link)));
      if (next === current) return;
      const firstStart = mentionDisplayText(current.slice(0, matches[0]!.start)).length;
      const delta = mentionDisplayText(next).length - mentionDisplayText(current).length;
      commit(next);
      const caret = selectionRef.current;
      if (caret && caret.start >= firstStart) placeCaret(caret.start + delta);
    });
  }, [client, commit, placeCaret]);

  const onChangeText = useCallback((nextDisplay: string) => {
    const edit = applyComposerDisplayEdit(valueRef.current, nextDisplay);
    // Typed characters arrive one at a time; only multi-character inserts
    // (paste, autofill) convert text, like the web composer's paste path.
    if (edit.insertedText.length <= 1) {
      commit(edit.markup);
      return;
    }
    const restored = restoreDraftMentions(edit.markup, { start: edit.insertedStart, end: edit.insertedStart + edit.insertedText.length }, knownMentions.current);
    const restoredEnd = edit.insertedStart + edit.insertedText.length + restored.length - edit.markup.length;
    const links = findCohubLinks(restored, { start: edit.insertedStart, end: restoredEnd });
    if (links.length === 0) {
      commit(restored);
      return;
    }
    const next = replaceCohubLinks(restored, links, (link) => link.kind === "space" && !link.sessionId ? knownSpaceNames.get(link.spaceId) : null);
    const insertedEnd = restoredEnd + next.length - restored.length;
    commit(next);
    placeCaret(mentionDisplayText(next.slice(0, insertedEnd)).length);
    resolvePastedLinks(findCohubLinks(next, { start: edit.insertedStart, end: insertedEnd }));
  }, [commit, knownSpaceNames, placeCaret, resolvePastedLinks]);

  const select = useCallback((item: SpaceMentionSuggestion) => {
    if (!trigger) return;
    const result = insertSpaceMention(valueRef.current, trigger, { spaceId: item.spaceId, label: item.name ?? "" });
    commit(result.markup);
    placeCaret(result.caret);
  }, [commit, placeCaret, trigger]);

  const dismiss = useCallback(() => {
    if (trigger) setDismissedStart(trigger.start);
  }, [trigger]);

  return { displayValue, onChangeText, onSelectionChange: updateSelection, onFocusChange: setFocused, menu, select, dismiss };
}
