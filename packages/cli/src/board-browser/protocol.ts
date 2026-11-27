import type { BoardDocument } from "@neta-art/cohub";
import type { BoardMediaState, BoardScriptCamera, BoardScriptParameter, BoardShader } from "@neta-art/cohub/board";
import type { BoardExportRegion, BoardThemeId } from "@neta-art/cohub/board";
import type { BoardExportWarning } from "@neta-art/cohub/board/export";
import type { BoardSimulationResult, BoardSimulationSpec } from "../board-simulation.js";

export type BoardBrowserInit = {
  document: BoardDocument;
  animation: string | null;
  theme: BoardThemeId;
  inputs?: string;
  keep?: boolean;
};

export type BoardBrowserFormat = "png" | "jpeg" | "webp" | "rgba";

export type BoardBrowserFrame = {
  time: number | null;
  next?: number;
  region: BoardExportRegion;
  camera?: { width: number; height: number };
  view?: BoardScriptCamera;
  viewport?: { width: number; height: number };
  screen?: boolean;
  maxPixels?: number;
  scale: number;
  padding?: number;
  background: "paper" | "transparent";
  format: BoardBrowserFormat;
  quality?: number;
  withImages: boolean;
  imageMemory: number;
  assetKeys?: Record<string, string>;
};

export type BoardBrowserFrameInfo = {
  time: number | null;
  width: number;
  height: number;
  scale: number;
  itemCount: number;
  warnings: BoardExportWarning[];
  media: BoardMediaState[];
};

export type BoardBrowserShader = { id: string; shader: BoardShader; parameters?: Record<string, BoardScriptParameter> };

export type BoardBrowserProfileInput = Pick<BoardBrowserFrame, "time" | "region" | "camera" | "scale" | "withImages" | "imageMemory"> & {
  frames: number;
  rounds: number;
  budgetMs: number;
};

export type BoardBrowserScriptCost = {
  id: string;
  step: { p50: number; p95: number };
  draw: { p50: number; p95: number };
  width: number;
  height: number;
};

export type BoardBrowserProfile = {
  renderer: string;
  gpu: "software" | "hardware";
  width: number;
  height: number;
  frames: number;
  rounds: number;
  reduced: { width: number; height: number; frames: number; frameMs: number } | null;
  elapsedMs: number;
  frame: { p50: number; p95: number };
  owners: Array<{
    id: string;
    ms: number;
    range: [number, number];
    filter: "none" | "always" | "switchable";
    sprites: number;
    boxes: number;
    state: { width: number; height: number } | null;
  }>;
  scripts: BoardBrowserScriptCost[];
  effects: number;
  items: number;
};

export type BoardBrowserSimulation = BoardSimulationSpec & {
  document: BoardDocument;
  theme: BoardThemeId;
  timeoutMs: number;
  recordings: Record<string, string>;
  frame?: Omit<BoardBrowserFrame, "time" | "camera" | "view" | "viewport"> & { timeoutMs: number };
};

export type { BoardSimulationResult };
