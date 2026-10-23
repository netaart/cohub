/**
 * Fonts `boards export` registers, copied into `dist/fonts` at build time. The
 * variable files and family names are the ones the Web loads, so every weight
 * draws with the same outlines; Figtree is the Neta Pixel theme's font.
 */

export type BoardExportFont = { pkg: string; file: string; family: string };

export const BOARD_EXPORT_FONTS: readonly BoardExportFont[] = [
  { pkg: "@fontsource-variable/geist", file: "geist-latin-wght-normal.woff2", family: "Geist Variable" },
  { pkg: "@fontsource-variable/geist-mono", file: "geist-mono-latin-wght-normal.woff2", family: "Geist Mono Variable" },
  { pkg: "@fontsource-variable/figtree", file: "figtree-latin-wght-normal.woff2", family: "Figtree Variable" },
];
