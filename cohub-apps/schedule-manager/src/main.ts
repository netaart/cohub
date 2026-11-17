import { mountResourceApp } from "../../shared/src/mount.ts";

mountResourceApp("cronjob", () => import("./ScheduleView.svelte"));
