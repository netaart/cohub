import { mountResourceApp } from "../../shared/src/mount.ts";

mountResourceApp("checkpoint", () => import("./CheckpointView.svelte"));
