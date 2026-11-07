import * as z from "zod";
import type { ContentBlock } from "./content.js";

const meta = z.record(z.string(), z.unknown());
export const contentBlockSchema: z.ZodType<ContentBlock> = z.lazy(() => z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), _meta: meta.optional() }),
  z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string().optional(), _meta: meta.optional() }),
  z.object({ type: z.literal("image"), source: z.union([
    z.object({ type: z.literal("url"), url: z.string().url() }),
    z.object({ type: z.literal("base64"), media_type: z.string(), data: z.string() }),
  ]), _meta: meta.optional() }),
  z.object({ type: z.literal("shell_command"), command: z.string(), rawText: z.string(), _meta: meta.optional() }),
  z.object({ type: z.literal("tool_use"), id: z.string().min(1), name: z.string().min(1), input: z.record(z.string(), z.unknown()), _meta: meta.optional() }),
  z.object({ type: z.literal("tool_result"), tool_use_id: z.string().min(1), content: z.union([z.string(), z.array(contentBlockSchema)]), is_error: z.boolean().optional(), _meta: meta.optional() }),
  z.object({ type: z.literal("system_note"), note_type: z.enum(["session_created", "forked", "compacted", "info"]), text: z.string(), _meta: meta.optional() }),
]));
