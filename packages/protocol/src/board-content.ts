import { z } from "zod";

export const BOARD_CONTENT_KINDS = [
  "text",
  "image",
  "video",
  "audio",
  "3d",
  "file",
  "json",
  "collection",
] as const;
export type BoardContentKind = (typeof BOARD_CONTENT_KINDS)[number];
export const BoardContentKindSchema = z.enum(BOARD_CONTENT_KINDS);

export const BoardPortSchema = z.object({
  id: z.string().min(1).max(120),
  kind: BoardContentKindSchema,
  role: z.string().min(1).max(80).optional(),
  required: z.boolean().optional(),
  multiple: z.boolean().optional(),
  maxItems: z.number().int().positive().optional(),
}).strict();
export type BoardPort = z.infer<typeof BoardPortSchema>;

export const BoardNodeCapabilitySchema = z.object({
  inputs: z.array(BoardPortSchema),
  outputs: z.array(BoardPortSchema),
}).strict();
export type BoardNodeCapability = z.infer<typeof BoardNodeCapabilitySchema>;

const mediaOutputs = (kind: "image" | "video" | "audio" | "3d") => [{ id: kind, kind }];

/** Shared semantic capabilities. Presentation-only shapes intentionally have no ports yet. */
export const BOARD_NODE_CAPABILITIES: Record<string, BoardNodeCapability> = {
  text: { inputs: [], outputs: [{ id: "text", kind: "text" }] },
  image: { inputs: [], outputs: mediaOutputs("image") },
  video: { inputs: [], outputs: mediaOutputs("video") },
  audio: { inputs: [], outputs: mediaOutputs("audio") },
  file: { inputs: [], outputs: [{ id: "file", kind: "file" }] },
  task: {
    inputs: [
      { id: "input", kind: "collection", multiple: true },
      { id: "image-references", kind: "image", role: "reference", multiple: true },
      { id: "video-references", kind: "video", role: "reference", multiple: true },
      { id: "audio-references", kind: "audio", role: "reference", multiple: true },
      { id: "3d-references", kind: "3d", role: "reference", multiple: true },
    ],
    outputs: [{ id: "artifacts", kind: "collection", multiple: true }],
  },
};

export const EMPTY_BOARD_NODE_CAPABILITY: BoardNodeCapability = {
  inputs: [],
  outputs: [],
};

export function boardNodeCapability(type: string): BoardNodeCapability {
  return BOARD_NODE_CAPABILITIES[type] ?? EMPTY_BOARD_NODE_CAPABILITY;
}
