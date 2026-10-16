import { z } from "zod";

const metaSchema = z.record(z.string(), z.unknown());
const MAX_BASE64_CHARS = 14 * 1024 * 1024;

const generationSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("url"), url: z.string().url() }),
  z.object({ type: z.literal("base64"), mediaType: z.string().min(1), data: z.string().min(1).max(MAX_BASE64_CHARS) }),
]);

export const generationContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), meta: metaSchema.optional() }),
  z.object({ type: z.literal("image"), source: generationSourceSchema, meta: metaSchema.optional() }),
  z.object({ type: z.literal("video"), source: generationSourceSchema, meta: metaSchema.optional() }),
  z.object({ type: z.literal("audio"), source: generationSourceSchema, meta: metaSchema.optional() }),
  z.object({ type: z.literal("3d"), source: generationSourceSchema, meta: metaSchema.optional() }),
]);

export const createGenerationTaskRequestSchema = z.object({
  spaceId: z.string().uuid(),
  sessionId: z.string().uuid().optional().nullable(),
  turnId: z.string().uuid().optional().nullable(),
  model: z.string().min(1),
  content: z.array(generationContentBlockSchema).min(1),
  parameters: z.record(z.string(), z.unknown()).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type CreateGenerationTaskRequestInput = z.infer<typeof createGenerationTaskRequestSchema>;
