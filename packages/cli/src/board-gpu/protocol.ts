import type { BoardDocument } from "@neta-art/cohub";
import type { BoardScriptParameter, BoardScriptSnapshot, BoardShader } from "@neta-art/cohub/board";
import type { BoardExportRegion, BoardThemeId } from "@neta-art/cohub/board";
import type { BoardExportWarning } from "@neta-art/cohub/board/export";

export type BoardGpuInit = {
  document: BoardDocument;
  animation: string | null;
  theme: BoardThemeId;
  snapshots?: Record<string, BoardScriptSnapshot>;
};
export type BoardGpuFrame = {
  time: number | null;
  region: BoardExportRegion;
  camera?: { width: number; height: number };
  scale: number;
  padding?: number;
  background: "paper" | "transparent";
  format: "png" | "jpeg" | "webp";
  quality?: number;
  withImages: boolean;
  imageMemory: number;
  assetKeys?: Record<string, string>;
};
export type BoardGpuResult = {
  data: string;
  width: number;
  height: number;
  scale: number;
  itemCount: number;
  warnings: BoardExportWarning[];
};
export type BoardGpuShader = { id: string; shader: BoardShader; parameters?: Record<string, BoardScriptParameter> };
export type BoardGpuProfileInput = Pick<BoardGpuFrame, "time" | "region" | "camera" | "scale" | "withImages" | "imageMemory"> & {
  frames: number;
  rounds: number;
  budgetMs: number;
};
export type BoardGpuProfile = {
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
  effects: number;
  items: number;
};
