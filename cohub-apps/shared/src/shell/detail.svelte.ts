import type { ResourceAppTarget } from "@cohub/protocol";
import { asRecord } from "$kit/core.ts";
import { taskIsStreaming } from "$kit/task-run.ts";
import { statusCode } from "../access.ts";
import {
  loadResource,
  subscribeSpace,
  type ResourceDetail,
} from "../client.ts";
import { forgetCache, readCache, writeCache } from "../storage.ts";

const POLL_MS = 5000;

export class DetailController {
  detail = $state<ResourceDetail | null>(null);
  loading = $state(false);
  refreshing = $state(false);
  denied = $state(false);
  missing = $state(false);
  error = $state<"error" | "stale" | null>(null);

  #revision = 0;
  #pending = false;
  #again = false;
  #active = true;
  #spaceId = "";
  #target: ResourceAppTarget | null = null;
  #key: string | null = null;
  #poll: ReturnType<typeof setTimeout> | null = null;
  #stopEvents: (() => void) | null = null;

  get revision() {
    return this.#revision;
  }

  open(spaceId: string, target: ResourceAppTarget, key: string | null, cached: boolean) {
    this.close();
    this.#spaceId = spaceId;
    this.#target = target;
    this.#key = key;
    if (target.id === "new") return;
    const entry = cached ? readCache<ResourceDetail>(key) : null;
    this.detail = entry?.value?.kind === target.kind ? entry.value : null;
    this.loading = !this.detail;
    void this.refresh();
  }

  close() {
    this.#revision += 1;
    this.#stop();
    this.#pending = false;
    this.#again = false;
    this.#target = null;
    this.detail = null;
    this.loading = false;
    this.refreshing = false;
    this.denied = false;
    this.missing = false;
    this.error = null;
  }

  set(detail: ResourceDetail) {
    this.detail = detail;
    this.error = null;
    writeCache(this.#key, detail);
    this.#follow();
  }

  revoke() {
    this.#revision += 1;
    this.#stop();
    this.#pending = false;
    forgetCache(this.#key);
    this.detail = null;
    this.loading = false;
    this.refreshing = false;
    this.denied = true;
    this.error = null;
  }

  setActive(active: boolean) {
    const resumed = active && !this.#active;
    this.#active = active;
    if (!active) this.#clearPoll();
    else if (resumed && this.#target) void this.refresh();
  }

  async refresh(): Promise<void> {
    const target = this.#target;
    if (!target || target.id === "new") return;
    if (this.#pending) {
      this.#again = true;
      return;
    }
    const revision = this.#revision;
    const spaceId = this.#spaceId;
    this.#pending = true;
    this.refreshing = true;
    try {
      const next = await loadResource(spaceId, target);
      if (revision !== this.#revision) return;
      this.detail = next;
      this.denied = false;
      this.missing = false;
      this.error = null;
      writeCache(this.#key, next);
    } catch (cause) {
      if (revision !== this.#revision) return;
      const status = statusCode(cause) ?? 0;
      if (status === 401 || status === 403 || status === 404) {
        forgetCache(this.#key);
        this.detail = null;
        this.denied = status !== 404;
        this.missing = status === 404;
        this.error = null;
      } else this.error = this.detail ? "stale" : "error";
    } finally {
      if (revision === this.#revision) {
        this.#pending = false;
        this.loading = false;
        this.refreshing = false;
        this.#follow();
        if (this.#again) {
          this.#again = false;
          void this.refresh();
        }
      }
    }
  }

  dispose() {
    this.close();
  }

  #follow() {
    this.#clearPoll();
    const detail = this.detail;
    const streaming = detail?.kind === "task" && taskIsStreaming(detail.data.run);
    if (!streaming) {
      this.#stopEvents?.();
      this.#stopEvents = null;
      return;
    }
    const id = detail.data.run.id;
    if (!this.#stopEvents && this.#spaceId)
      this.#stopEvents = subscribeSpace(this.#spaceId, (event) => {
        const task = asRecord(asRecord(event.payload)?.task);
        if (this.#active && event.type === "task.updated" && task?.id === id)
          void this.refresh();
      });
    if (this.#active) this.#poll = setTimeout(() => void this.refresh(), POLL_MS);
  }

  #clearPoll() {
    if (this.#poll) clearTimeout(this.#poll);
    this.#poll = null;
  }

  #stop() {
    this.#clearPoll();
    this.#stopEvents?.();
    this.#stopEvents = null;
  }
}
