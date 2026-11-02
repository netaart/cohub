import type { BoardDocument } from "@neta-art/cohub";
import type { BoardExportRegion, BoardThemeId } from "@neta-art/cohub/board";
import type { BoardExportWarning } from "@neta-art/cohub/board/export";

export type BoardGpuInit = { document: BoardDocument; animation: string | null; theme: BoardThemeId };
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
};
export type BoardGpuResult = {
  data: string;
  width: number;
  height: number;
  scale: number;
  itemCount: number;
  warnings: BoardExportWarning[];
};
