import { mountResourceApp } from "../../shared/src/mount.ts";

mountResourceApp("task", () => import("./TaskView.svelte"));
