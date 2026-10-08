import { getContext, setContext } from "svelte";
import type { RelatedSessionView } from "$lib/related-sessions";
import type { RelatedSessionRef, SentSession } from "$lib/sent-turns";

export type SessionRelations = {
	sentByTurn(turnId: string): readonly SentSession[];
	sentByToolCall(toolCallId: string): readonly SentSession[];
	session(ref: RelatedSessionRef): RelatedSessionView;
	request(refs: Iterable<RelatedSessionRef>): void;
};

const sessionRelationsKey = Symbol("cohub.chat.session-relations");

export function provideSessionRelations(relations: SessionRelations) {
	setContext(sessionRelationsKey, relations);
}

export function useSessionRelations(): SessionRelations | undefined {
	return getContext<SessionRelations | undefined>(sessionRelationsKey);
}
