import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
})();

export const packagePath = (...segments: string[]) => join(root, ...segments);

export const standaloneModule = (name: string) =>
  import.meta.url.endsWith(".ts") ? packagePath("src", `${name}.ts`) : packagePath("dist", `${name}.js`);
