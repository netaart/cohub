export type ContentBlockMeta = Record<string, unknown>;

export type Timing = {
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
};

export type ContentBlock =
  | { type: "text"; text: string; _meta?: ContentBlockMeta }
  | { type: "thinking"; thinking: string; signature?: string; redacted?: boolean; _meta?: ContentBlockMeta }
  | {
      type: "image";
      source:
        | { type: "url"; url: string }
        | { type: "base64"; media_type: string; data: string };
      _meta?: ContentBlockMeta;
    }
  | {
      type: "shell_command";
      command: string;
      rawText: string;
      _meta?: ContentBlockMeta;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      _meta?: ContentBlockMeta;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
      is_error?: boolean;
      _meta?: ContentBlockMeta;
    }
  | {
      type: "system_note";
      note_type: "session_created" | "forked" | "compacted" | "info";
      text: string;
      _meta?: ContentBlockMeta;
    };
