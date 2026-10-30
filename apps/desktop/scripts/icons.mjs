#!/usr/bin/env node
// Usage: node apps/desktop/scripts/icons.mjs --macos <AppIcon.iconset> --windows <Cohub.ico> --linux <cohub.png>
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sharp = createRequire(join(root, "packages/cli/package.json"))("sharp");
const { values } = parseArgs({ options: { macos: { type: "string" }, windows: { type: "string" }, linux: { type: "string" } } });

const favicon = await readFile(join(root, "apps/web/static/favicon.svg"), "utf8");
const [, inner] = favicon.match(/<svg[^>]*>([\s\S]*)<\/svg>/) ?? [];
if (!inner) throw new Error("favicon.svg has no content");

const macosSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs><filter id="s" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-opacity="0.28"/></filter></defs>
  <g filter="url(#s)" transform="translate(100 100) scale(${824 / 192})">${inner.replace(/rx="32"/, 'rx="43"')}</g>
</svg>`;

const render = (svg, size) => sharp(Buffer.from(svg), { density: 72 * Math.max(1, size / 192) }).resize(size, size).png().toBuffer();

if (values.macos) {
  await mkdir(values.macos, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(join(values.macos, `icon_${size}x${size}.png`), await render(macosSvg, size));
    await writeFile(join(values.macos, `icon_${size}x${size}@2x.png`), await render(macosSvg, size * 2));
  }
}

if (values.windows) {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const frames = await Promise.all(sizes.map((size) => render(favicon, size)));
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(sizes[index] % 256, entry);
    header.writeUInt8(sizes[index] % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  await mkdir(dirname(values.windows), { recursive: true });
  await writeFile(values.windows, Buffer.concat([header, ...frames]));
}

if (values.linux) {
  await mkdir(dirname(values.linux), { recursive: true });
  await writeFile(values.linux, await render(favicon, 512));
}
