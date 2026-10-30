import { Type } from "@earendil-works/pi-ai";
import { SHORT_UUID_PATTERN, UUID_PATTERN } from "@cohub/protocol/identifiers";
import { assertValidSpaceId } from "../ids.js";

const EMPTY_SPACE_ID_PATTERN = "(?:0{8}-0{4}-[0-8]000-[089abAB]000-0{12}|0{12}[0-8]000[089abAB]0{15})";
const EMPTY_SPACE_ID_REGEX = new RegExp(`^${EMPTY_SPACE_ID_PATTERN}$`);

export const querySpaceIdParameter = Type.Optional(Type.Union([
  Type.String({ pattern: `^\\s*(?:${UUID_PATTERN}|${SHORT_UUID_PATTERN}|${EMPTY_SPACE_ID_PATTERN})?\\s*$` }),
  Type.Null(),
], {
  description: "UUID of another space to query. Omit or use null for the current space. Blank strings and zero UUID placeholders also use the current space. Never invent a space ID.",
}));

export function resolveQuerySpaceId(value: unknown, currentSpaceId: string): string {
  if (value == null) return currentSpaceId;
  if (typeof value !== "string") throw new Error("Invalid space_id: expected a UUID string or null.");
  const trimmed = value.trim();
  if (!trimmed || EMPTY_SPACE_ID_REGEX.test(trimmed)) return currentSpaceId;
  return assertValidSpaceId(trimmed);
}
