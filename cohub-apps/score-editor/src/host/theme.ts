/** The host appearance this App reads, narrowed from the SDK's runtime context. */
export type HostAppearance = {
  readonly colorScheme: "light" | "dark";
  readonly tokens: Partial<Record<string, string>>;
};

/** Host token → editor variable. Colors and faces only; the package derives the rest. */
const TOKEN_MAP: ReadonlyArray<readonly [string, string]> = [
  ["bg-primary", "--sce-color-bg"],
  ["text-primary", "--sce-color-text"],
  ["bg-surface", "--sce-color-surface"],
  ["text-secondary", "--sce-color-muted"],
  ["border-subtle", "--sce-color-line"],
  ["border-primary", "--sce-color-line-strong"],
  ["brand", "--sce-color-accent"],
  ["brand", "--sce-color-note"],
  ["font-sans", "--sce-font-family"],
  ["font-mono", "--sce-font-family-mono"],
];

/**
 * Maps the host's resolved appearance onto the editor's public `--sce-*` variables. A token the host
 * did not resolve is left unmapped, so the package keeps its own light/dark default for it.
 */
export function scoreThemeVars(appearance: HostAppearance): {
  readonly colorScheme: "light" | "dark";
  readonly vars: Readonly<Record<string, string>>;
} {
  const vars: Record<string, string> = {};
  for (const [token, variable] of TOKEN_MAP) {
    const value = appearance.tokens[token];
    if (typeof value === "string" && value.trim() !== "") vars[variable] = value;
  }
  return { colorScheme: appearance.colorScheme, vars };
}
