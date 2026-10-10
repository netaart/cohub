
import type { BoardDocument } from "@cohub/protocol";
import { BOARD_TEXT_FONT_FAMILY } from "@cohub/protocol/board-constants";
import {
  type Adapter,
  CanvasGraphicsContextSystem,
  CanvasGraphicsPipe,
  CanvasRenderer,
  CanvasRendererTextSystem,
  CanvasTextPipe,
  CanvasTextSystem,
  DOMAdapter,
  extensions,
  GraphicsContextSystem,
  GraphicsPipe,
  type ICanvas,
  ImageSource,
  type Renderer,
  Texture,
} from "pixi.js";
import { installBoardTextMeasurement } from "../../render/text-measurement.js";
import {
  type BoardExportOptions,
  type BoardExportResult,
  renderBoardExport,
} from "../index.js";
import type { BoardSketchHost } from "../../render/renderers/board-renderer-registry.js";

export type NodeCanvasModule = {
  createCanvas: (width: number, height: number) => unknown;
  Image: new () => unknown;
  GlobalFonts: {
    registerFromPath: (path: string, name?: string) => unknown;
    has: (name: string) => boolean;
    setAlias?: (fontName: string, alias: string) => boolean;
  };
};

const SYSTEM_UI_FAMILIES = [
  "Noto Sans",
  "DejaVu Sans",
  "Liberation Sans",
  "FreeSans",
  "Helvetica Neue",
  "Arial",
  "Segoe UI",
];

function aliasSystemUi(fonts: NodeCanvasModule["GlobalFonts"]): void {
  if (!fonts.setAlias || fonts.has("system-ui")) return;
  const family = SYSTEM_UI_FAMILIES.find((name) => fonts.has(name));
  if (family) fonts.setAlias(family, "system-ui");
}

export type BoardNodeFont = {
  path: string;
  family?: string;
};

export type BoardNodeRendererOptions = {
  fonts?: BoardNodeFont[];
  canvasModule?: NodeCanvasModule;
};

export type BoardNodeTexture = { readonly __boardTexture: unique symbol };

export type BoardNodeRenderer = {
  renderer: Renderer;
  canvasModule: NodeCanvasModule;
  decodeImage: (bytes: Uint8Array, mimeType?: string) => Promise<BoardNodeTexture>;
  destroy: () => void;
};

const WEBGL_PROBE_STUB = {
  getShaderPrecisionFormat: () => ({ precision: 1, rangeMin: 1, rangeMax: 1 }),
  getExtension: () => null,
  getParameter: () => 0,
};

function isWebGLContext(kind: string): boolean {
  return kind.startsWith("webgl") || kind === "experimental-webgl";
}

async function loadCanvasModule(): Promise<NodeCanvasModule> {
  try {
    return (await import("@napi-rs/canvas")) as unknown as NodeCanvasModule;
  } catch (cause) {
    throw new Error(
      "Board image export needs the optional '@napi-rs/canvas' package. Install it with: npm i @napi-rs/canvas",
      { cause },
    );
  }
}

function installAnimationFrameShim(): () => void {
  const globals = globalThis as {
    requestAnimationFrame?: (cb: (t: number) => void) => unknown;
    cancelAnimationFrame?: (id: unknown) => void;
  };
  if (globals.requestAnimationFrame) return () => {};
  const timers = new Set<ReturnType<typeof setTimeout>>();
  globals.requestAnimationFrame = (cb) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      cb(Date.now());
    }, 16);
    timer.unref?.();
    timers.add(timer);
    return timer;
  };
  globals.cancelAnimationFrame = (id) => {
    clearTimeout(id as ReturnType<typeof setTimeout>);
    timers.delete(id as ReturnType<typeof setTimeout>);
  };
  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    globals.requestAnimationFrame = undefined;
    globals.cancelAnimationFrame = undefined;
  };
}

export async function createNodeBoardRenderer(
  options: BoardNodeRendererOptions = {},
): Promise<BoardNodeRenderer> {
  const canvasModule = options.canvasModule ?? (await loadCanvasModule());
  extensions.add(
    CanvasGraphicsPipe,
    GraphicsPipe,
    CanvasGraphicsContextSystem,
    GraphicsContextSystem,
    CanvasRendererTextSystem,
    CanvasTextSystem,
    CanvasTextPipe,
  );

  for (const font of options.fonts ?? []) {
    canvasModule.GlobalFonts.registerFromPath(font.path, font.family ?? BOARD_TEXT_FONT_FAMILY);
  }
  aliasSystemUi(canvasModule.GlobalFonts);

  function createCanvas(width = 1, height = 1) {
    const canvas = canvasModule.createCanvas(
      Math.max(1, Math.ceil(width)),
      Math.max(1, Math.ceil(height)),
    ) as {
      getContext: (kind: string, ...rest: unknown[]) => unknown;
    };
    const nativeGetContext = canvas.getContext.bind(canvas);
    canvas.getContext = (kind: string, ...rest: unknown[]) =>
      isWebGLContext(String(kind)) ? WEBGL_PROBE_STUB : nativeGetContext(kind, ...rest);
    return canvas;
  }

  const adapter: Adapter = {
    createCanvas: (width, height) => createCanvas(width, height) as unknown as ICanvas,
    createImage: () => new canvasModule.Image() as never,
    getCanvasRenderingContext2D: () =>
      (createCanvas(1, 1).getContext("2d") as { constructor: unknown })
        .constructor as never,
    getWebGLRenderingContext: () => WEBGL_PROBE_STUB as never,
    getNavigator: () => ({ userAgent: "cohub-board-node", gpu: null }),
    getBaseUrl: () => "file://",
    getFontFaceSet: () => null,
    fetch: (url, init) => fetch(url as string | URL, init),
    parseXML: () => {
      throw new Error("XML parsing is not available in Node board export.");
    },
  };
  DOMAdapter.set(adapter);
  installBoardTextMeasurement();

  const restoreAnimationFrame = installAnimationFrameShim();
  const renderer = new CanvasRenderer();
  await renderer.init({
    width: 1,
    height: 1,
    backgroundAlpha: 0,
    antialias: true,
    resolution: 1,
    skipExtensionImports: true,
  });

  return {
    renderer: renderer as unknown as Renderer,
    canvasModule,
    decodeImage: async (bytes, mimeType = "image/png") => {
      const image = new canvasModule.Image() as {
        src: string;
        width: number;
        height: number;
        onload?: () => void;
        onerror?: (error: unknown) => void;
      };
      const base64 = Buffer.from(bytes).toString("base64");
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = (error) => reject(error);
        image.src = `data:${mimeType};base64,${base64}`;
      });
      return new Texture({
        source: new ImageSource({
          resource: image as never,
          width: image.width,
          height: image.height,
        }),
      }) as unknown as BoardNodeTexture;
    },
    destroy: () => {
      renderer.destroy();
      restoreAnimationFrame();
    },
  };
}

export type BoardNodeExportFormat = "png" | "jpeg" | "webp";

export type BoardNodeExportOptions = Omit<BoardExportOptions, "textures" | "backgroundImage"> & {
  textures?: Map<string, BoardNodeTexture>;
  backgroundImage?: {
    texture: BoardNodeTexture;
    fit: "cover" | "contain" | "repeat";
    position: "center" | "top" | "bottom" | "left" | "right";
    opacity: number;
  };
  sketches?: BoardSketchHost;
  format?: BoardNodeExportFormat;
  quality?: number;
};

export type BoardNodeExportResult = Omit<BoardExportResult, "canvas"> & {
  bytes: Uint8Array;
  format: BoardNodeExportFormat;
};

const MIME: Record<BoardNodeExportFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export { createNodeBoardSketchHost } from "./sketch.js";

export function boardImageMimeType(format: BoardNodeExportFormat): string {
  return MIME[format];
}

export function exportBoardImageBytes(
  renderer: BoardNodeRenderer,
  document: BoardDocument,
  options: BoardNodeExportOptions = {},
): BoardNodeExportResult | null {
  const { format = "png", quality = 0.92, textures, sketches, backgroundImage, ...rest } = options;
  const result = renderBoardExport(renderer.renderer, document, {
    ...rest,
    ...(sketches ? { sketches } : {}),
    ...(textures ? { textures: textures as unknown as Map<string, Texture> } : {}),
    ...(backgroundImage
      ? {
          backgroundImage: {
            ...backgroundImage,
            texture: backgroundImage.texture as unknown as Texture,
          },
        }
      : {}),
  });
  if (!result) return null;
  const canvas = result.canvas as unknown as {
    toBuffer: (mime: string, quality?: number) => Buffer;
  };
  const bytes =
    format === "png"
      ? canvas.toBuffer(MIME.png)
      : canvas.toBuffer(MIME[format], Math.round(quality * 100));
  return { bytes: new Uint8Array(bytes), plan: result.plan, warnings: result.warnings, format };
}
