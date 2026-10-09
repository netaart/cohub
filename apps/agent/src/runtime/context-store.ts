import { db } from "../db.js";
import { createRequestedThinkingLevelReader, createRuntimeContextReader } from "./context-reader.js";

export const loadRuntimeContext = createRuntimeContextReader(db);
export const loadRequestedThinkingLevel = createRequestedThinkingLevelReader(db);
