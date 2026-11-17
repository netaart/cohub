import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions, defineConfig } from "vite";

const web = (path: string) =>
  new URL(`../../apps/web/src/lib/${path}`, import.meta.url).pathname;

export function resourceAppConfig() {
  return defineConfig({
    base: "./",
    plugins: [tailwindcss(), svelte()],
    resolve: {
      conditions: ["source", ...defaultClientConditions],
      dedupe: ["svelte", "lucide-svelte", "@neta-art/cohub", "@cohub/protocol"],
      alias: {
        $kit: web("resource-kit"),
        $messages: web("paraglide/messages.js"),
      },
    },
    build: { target: "es2022" },
  });
}

export default resourceAppConfig();
