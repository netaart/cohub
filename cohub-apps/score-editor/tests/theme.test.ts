import assert from "node:assert/strict";
import { test } from "node:test";
import { scoreThemeVars } from "../src/host/theme.ts";

type Rgba = { readonly r: number; readonly g: number; readonly b: number; readonly a: number };

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

function linearToSrgb(value: number): number {
  const channel = clamp(value);
  return channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function oklchToSrgb(lightness: number, chroma: number, hue: number): readonly [number, number, number] {
  const l = lightness / 100;
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const lCube = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCube = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCube = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube),
    linearToSrgb(-1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube),
    linearToSrgb(-0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube),
  ];
}

function parseColor(css: string): Rgba {
  const oklch = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(css);
  if (oklch) {
    const [r, g, b] = oklchToSrgb(Number(oklch[1]), Number(oklch[2]), Number(oklch[3]));
    return { r, g, b, a: 1 };
  }
  const rgb = /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)%\s*)?\)$/.exec(css);
  if (rgb) {
    return {
      r: Number(rgb[1]) / 255,
      g: Number(rgb[2]) / 255,
      b: Number(rgb[3]) / 255,
      a: rgb[4] === undefined ? 1 : Number(rgb[4]) / 100,
    };
  }
  const hex = /^#([\da-f]{6})$/i.exec(css);
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
  }
  throw new Error(`unsupported color: ${css}`);
}

function luminance(color: Rgba): number {
  const channel = (value: number): number =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrast(foreground: Rgba, background: Rgba): number {
  const alpha = foreground.a;
  const over: Rgba = {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    a: 1,
  };
  const a = luminance(over);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const STUDIO = {
  name: "Studio classic dark",
  colorScheme: "dark" as const,
  ground: "#050605",
  secondary: "rgb(236 225 210 / 68%)",
} as const;

const THEMES = [
  {
    name: "Cohub light",
    colorScheme: "light" as const,
    ground: "oklch(100% 0 0)",
    secondary: "oklch(35% 0.008 250)",
  },
  {
    name: "Cohub dark",
    colorScheme: "dark" as const,
    ground: "oklch(18% 0.004 250)",
    secondary: "oklch(82% 0.006 250)",
  },
  STUDIO,
];

test("muted comes from text-secondary, not text-tertiary", () => {
  const secondary = scoreThemeVars({
    colorScheme: "dark",
    tokens: { "text-secondary": "#b9b9ba" },
  });
  assert.equal(secondary.vars["--sce-color-muted"], "#b9b9ba");

  const tertiary = scoreThemeVars({
    colorScheme: "dark",
    tokens: { "text-tertiary": "#737474" },
  });
  assert.equal(tertiary.vars["--sce-color-muted"], undefined);
});

for (const theme of THEMES) {
  test(`${theme.name}: text-secondary over the editor ground reaches 4.5:1`, () => {
    const { vars } = scoreThemeVars({
      colorScheme: theme.colorScheme,
      tokens: { "bg-primary": theme.ground, "text-secondary": theme.secondary },
    });
    const muted = vars["--sce-color-muted"];
    const ground = vars["--sce-color-bg"];
    assert.ok(muted !== undefined, `${theme.name} has no muted`);
    assert.ok(ground !== undefined, `${theme.name} has no ground`);
    const ratio = contrast(parseColor(muted), parseColor(ground));
    assert.ok(ratio >= 4.5, `${theme.name}: ${ratio.toFixed(2)}:1`);
  });
}
