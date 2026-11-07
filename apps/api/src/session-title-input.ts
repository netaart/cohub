import * as z from "zod";

const schema = z.object({ title: z.string().nullable() });

export function parseSessionTitleInput(value: unknown):
  | { success: true; title: string | null }
  | { success: false } {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return { success: false };
  return { success: true, title: parsed.data.title?.trim() || null };
}
