import type { LocalHarness } from "@neta-art/cohub";
import { transcriptFormat } from "../harnesses/index.js";
import type { SessionHeader, ThreadKind } from "../harnesses/types.js";
import type { NativeTranscript, NativeTranscriptTurn } from "./transcript.js";

export type { NativeTranscript, NativeTranscriptTurn, SessionHeader, ThreadKind };
export type Harness = LocalHarness;

/** Directories holding this harness's transcripts; a transcript's header says which project it is. */
export const transcriptRoots = (harness: Harness): string[] => transcriptFormat(harness).roots();

/** Whether a directory found under a root can hold transcripts of `cwd`. */
export const acceptsDirectory = (path: string, root: string, harness: Harness, cwd: string): boolean => transcriptFormat(harness).acceptsDirectory(path, root, cwd);

/** Name-only check: can this path hold a transcript of this harness for `cwd`? */
export const acceptsTranscript = (path: string, harness: Harness, cwd: string): boolean => transcriptFormat(harness).acceptsTranscript(path, cwd);

/** The first line of a transcript: identity, project and purpose. Nothing else is read. */
export const readSessionHeader = async (path: string, harness: Harness, signal?: AbortSignal): Promise<SessionHeader | null> => await transcriptFormat(harness).header(path, signal);

/** Parse a transcript into Turns. */
export const readTranscript = async (path: string, harness: Harness, signal?: AbortSignal): Promise<NativeTranscript> => await transcriptFormat(harness).read(path, signal);
