import { mountResourceApp } from "../../shared/src/mount.ts";

mountResourceApp("app", () => import("./AppView.svelte"));
