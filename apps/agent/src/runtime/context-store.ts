import { db } from "../db.js";
import { createRequestedContextWindowReader, createRequestedThinkingLevelReader, createRuntimeContextReader } from "./context-reader.js";

export const loadRuntimeContext = createRuntimeContextReader(db);
export const loadRequestedThinkingLevel = createRequestedThinkingLevelReader(db);
export const loadRequestedContextWindow = createRequestedContextWindowReader(db);
