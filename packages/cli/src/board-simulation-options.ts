export const BOARD_SIMULATION_MODES = ["edit", "play", "view"] as const;
export const BOARD_SIMULATION_POINTERS = ["fine", "coarse"] as const;
export const BOARD_SIMULATION_VIEWPORT = { width: 1280, height: 800 };

export function parseBoardSize(value: string, name: string): { width: number; height: number } {
  const size = /^(\d+)x(\d+)$/.exec(value.trim());
  const width = Number(size?.[1]);
  const height = Number(size?.[2]);
  if (!(width >= 1 && width <= 8192 && height >= 1 && height <= 8192)) throw new Error(`${name} must be widthxheight up to 8192x8192, e.g. 1600x900.`);
  return { width, height };
}
