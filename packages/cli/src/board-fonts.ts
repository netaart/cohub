/** Geist files `boards export` registers, copied into `dist/fonts` at build time. */

export type BoardExportFont = { pkg: string; file: string; family: string };

const subset = (pkg: string, family: string, weights: number[]): BoardExportFont[] =>
  weights.map((weight) => ({
    pkg,
    family,
    file: `${pkg.split("/").pop()}-latin-${weight}-normal.woff2`,
  }));

export const BOARD_EXPORT_FONTS: readonly BoardExportFont[] = [
  ...subset("@fontsource/geist", "Geist", [400, 500, 600, 700]),
  ...subset("@fontsource/geist-mono", "Geist Mono", [500, 600, 700]),
];
