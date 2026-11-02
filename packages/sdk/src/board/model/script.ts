import type {
  BoardItem,
  BoardPatch,
  BoardScript,
  BoardVec2,
} from "@cohub/protocol";

export type BoardScriptView = {
  camera: { x: number; y: number; zoom: number };
  width: number;
  height: number;
  safeRect: { x: number; y: number; width: number; height: number };
};

export type BoardScriptAnchor = {
  item: string;
  point?: BoardVec2;
};

export type BoardScriptSceneOptions = {
  space?: "world" | "screen";
  anchor?: BoardScriptAnchor;
};

export type BoardScriptEvent = {
  type: string;
  target?: string;
  relatedTarget?: string;
  relatedOwner?: string;
  point?: BoardVec2;
  pointerId?: number;
  pointerType?: string;
  buttons?: number;
  key?: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  data?: unknown;
};

export type BoardScriptChangeSource = "user" | "script" | "remote";

export type BoardScriptTool = "select" | "hand" | "text" | "shape" | "draw" | "arrow" | "frame";

export type BoardScriptGesture = {
  id: string;
  tool: "draw" | "shape" | "frame" | "arrow";
  phase: "start" | "update" | "end" | "cancel";
  points: BoardVec2[];
  item?: string;
};

export type BoardScriptHostEvents = {
  viewchange: BoardScriptView;
  selectionchange: { ids: string[]; total: number };
  transformend: { ids: string[]; operation: "move" | "resize" | "rotate" | "arrow"; cancelled: boolean };
  change: { added: string[]; changed: string[]; removed: string[]; source: BoardScriptChangeSource };
  gesture: BoardScriptGesture;
};

export type BoardScriptEventOf<Type extends string> = BoardScriptEvent & {
  type: Type;
} & (Type extends keyof BoardScriptHostEvents ? { data: BoardScriptHostEvents[Type] } : unknown);

export type BoardScriptFrame = {
  t: number;
  dt: number;
  width: number;
  height: number;
  seed: string;
  params: BoardScript["params"];
  state: Record<string, unknown>;
};

export type BoardScriptItemPatch = Partial<
  Pick<BoardItem, "position" | "scale" | "rotation" | "opacity" | "style" | "z">
> & {
  size?: { width?: number; height?: number };
  props?: Record<string, unknown>;
};
export type BoardScriptHit = ({
  x: number;
  y: number;
  width: number;
  height: number;
} | { target: "self" } | { item: string }) & {
  label?: string;
  cursor?: string;
  tools?: BoardScriptTool[];
};
export type BoardScriptSnapshot = {
  state: Record<string, unknown>;
  time: number;
  random: number;
  configuration?: string;
  effects?: Pick<BoardScriptOutput, "patches" | "world" | "screen" | "anchor" | "hits" | "uniforms">;
};
export type BoardScriptParameter = {
  type: "number" | "boolean" | "string" | "color";
  label?: string;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
};

export type BoardScriptOutput = {
  parameters?: Record<string, BoardScriptParameter>;
  patches: Record<string, Record<string, unknown>>;
  world: Record<string, unknown>;
  screen: Record<string, unknown>;
  anchor?: BoardScriptAnchor;
  hits: Record<string, BoardScriptHit>;
  listens: string[];
  animated: boolean;
  draws?: boolean;
  updating?: boolean;
  frameRate?: number;
  pixelated?: boolean;
  shader?: BoardShader;
  uniforms?: BoardShaderUniformValues;
  version: number;
};

export type BoardScriptTextInput = {
  text: string;
  fontSize?: number;
  fontWeight?: number;
  font?: string;
  lineHeight?: number;
  width?: number;
};

export type BoardScriptContext = {
  readonly self: {
    readonly id: string;
    readonly base: BoardItem | null;
    present(patch: BoardScriptItemPatch | null): void;
  };
  readonly params: BoardScript["params"];
  readonly targets: Readonly<Record<string, string>>;
  emit(target: string, type: string, data?: unknown): Promise<void>;
  readonly items: Readonly<Record<string, BoardItem>>;
  readonly state: Record<string, unknown>;
  readonly frame: BoardScriptFrame;
  readonly view: BoardScriptView | null;
  random(): number;
  on<Type extends string>(type: Type, handler: (event: BoardScriptEventOf<Type>) => void): () => void;
  onFrame(handler: (frame: BoardScriptFrame) => void): () => void;
  onDispose(handler: () => void): void;
  invalidate(): void;
  get(id: string): BoardItem | undefined;
  present(id: string, patch: BoardScriptItemPatch | null): void;
  scene(
    items: Record<string, unknown>,
    options?: BoardScriptSceneOptions,
  ): void;
  hitRegions(hits: Record<string, BoardScriptHit>): void;
  commit(patch: BoardPatch): Promise<boolean>;
  layoutText(text: BoardScriptTextInput): Promise<{ width: number; height: number }>;
  uniforms(values: BoardShaderUniformValues): void;
  capabilities: {
    has(name: string): boolean;
    call(name: string, input?: unknown): Promise<unknown>;
  };
};

export type BoardScriptModule = {
  parameters?: Record<string, BoardScriptParameter>;
  default?:
    | ((context: BoardScriptContext) => void)
    | ((context: BoardScriptContext) => () => void);
  draw?: (context: CanvasRenderingContext2D, frame: BoardScriptFrame) => void;
  shader?: BoardShader;
  animated?: boolean;
  frameRate?: number;
  pixelated?: boolean;
};

export const BOARD_SHADER_LAYERS = ["below", "above", "filter"] as const;
export const BOARD_SHADER_BLENDS = ["normal", "add", "screen", "multiply"] as const;
export const BOARD_SHADER_UNIFORM_TYPES = ["float", "vec2", "vec3", "vec4", "int"] as const;

export type BoardShaderPass = {
  glsl: string;
  sprites?: number;
  blend?: (typeof BOARD_SHADER_BLENDS)[number];
};

export type BoardShader = {
  layer?: (typeof BOARD_SHADER_LAYERS)[number];
  surfaces?: boolean;
  uniforms?: Record<string, string>;
  state?: {
    width: number;
    height: number;
    glsl: string;
    precision?: "byte" | "half";
  };
  passes: BoardShaderPass[];
};

export type BoardShaderUniformValues = Record<string, number | readonly number[]>;
