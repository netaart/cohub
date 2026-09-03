export type PanelName = "chat" | "files";
export type PanelSide = -1 | 1;

export const PANEL_OPEN_THRESHOLD = 0.26;
export const PANEL_CLOSE_THRESHOLD = 0.5;
/** PanResponder velocity is reported in points per millisecond. Native normalizes to this unit. */
export const PANEL_SWIPE_VELOCITY = 0.55;

export function sideForPanel(panel: PanelName): PanelSide {
  "worklet";
  return panel === "chat" ? -1 : 1;
}

export function panelForSide(side: PanelSide): PanelName {
  "worklet";
  return side < 0 ? "chat" : "files";
}

export function panelForOpeningDelta(deltaX: number): PanelName | null {
  "worklet";
  if (deltaX > 0) return "chat";
  if (deltaX < 0) return "files";
  return null;
}

export function shouldOpenPanel(
  distance: number,
  panelWidth: number,
  velocityTowardOpen: number,
) {
  "worklet";
  return distance / panelWidth >= PANEL_OPEN_THRESHOLD || velocityTowardOpen >= PANEL_SWIPE_VELOCITY;
}

export function shouldClosePanel(
  distance: number,
  panelWidth: number,
  velocityTowardClose: number,
) {
  "worklet";
  return distance / panelWidth >= PANEL_CLOSE_THRESHOLD || velocityTowardClose >= PANEL_SWIPE_VELOCITY;
}
