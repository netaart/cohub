export type BoardNodeFont = {
  path: string;
  family?: string;
};

export type BoardFontRegistry = {
  registerFromPath(path: string, family?: string): unknown;
  has(family: string): boolean;
  setAlias?: (family: string, alias: string) => boolean;
};

export function initializeBoardFonts(registry: BoardFontRegistry, fonts: readonly BoardNodeFont[]): void {
  for (const font of fonts) registry.registerFromPath(font.path, font.family);
  if (!registry.setAlias) return;
  const aliases = {
    Geist: ["Geist Variable"],
    "Geist Mono": ["Geist Mono Variable"],
    "system-ui": ["Noto Sans", "DejaVu Sans", "Liberation Sans", "FreeSans", "Helvetica Neue", "Arial", "Segoe UI"],
    "sans-serif": ["Geist Variable", "Geist", "Noto Sans", "DejaVu Sans", "Liberation Sans", "FreeSans", "Arial"],
    serif: ["Noto Serif", "DejaVu Serif", "Liberation Serif", "FreeSerif", "Times New Roman"],
    monospace: ["Geist Mono Variable", "Geist Mono", "DejaVu Sans Mono", "Liberation Mono", "FreeMono", "Courier New"],
  };
  for (const [alias, candidates] of Object.entries(aliases)) {
    if (registry.has(alias)) continue;
    const family = candidates.find((name) => registry.has(name));
    if (family) registry.setAlias(family, alias);
  }
}
