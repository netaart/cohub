import "@fontsource/geist/latin-400.css";
import "@fontsource/geist/latin-500.css";
import "@fontsource/geist/latin-600.css";
import "@fontsource/geist-mono/latin-400.css";
import "./styles.css";
import type { ResourceAppKind } from "@cohub/protocol";
import { mount } from "svelte";
import Shell from "./shell/Shell.svelte";
import type { ResourceViewModule } from "./view-types.ts";

export function mountResourceApp(
  kind: ResourceAppKind,
  loadView: () => Promise<ResourceViewModule>,
) {
  const target = document.getElementById("app");
  if (!target) throw new Error("Missing App mount target");
  const view = loadView();
  return mount(Shell, { target, props: { kind, view } });
}
