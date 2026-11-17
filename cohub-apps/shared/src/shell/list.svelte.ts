import { isAppSilentShellScope, type ResourceAppKind } from "@cohub/protocol";
import { m } from "$messages";
import { asRecord } from "$kit/core.ts";
import { scopeHash, scopePermissions, type ResourceScope } from "../browser-route.ts";
import { client, subscribeSpace, type SpaceEvent } from "../client.ts";
import {
  hasAccountScope,
  hasScopes,
  isAccessError,
  resourceKey,
} from "../access.ts";
import {
  listResources,
  matchesTaskFilter,
  type ResourcePage,
  type ResourceRow,
  type TaskFilter,
} from "../resource-list.ts";
import { runtime } from "../runtime.svelte.ts";
import { forgetCache, readCache, writeCache } from "../storage.ts";

type LoadMode = "replace" | "append" | "refresh";

export class ListController {
  rows = $state<ResourceRow[]>([]);
  cursor = $state<string | null>(null);
  filter = $state<TaskFilter>("all");
  scope = $state<ResourceScope | null>(null);
  loading = $state(false);
  refreshing = $state(false);
  loadingMore = $state(false);
  authorizing = $state(false);
  denied = $state(false);
  error = $state<"error" | "stale" | null>(null);
  spaceNames = $state<Record<string, string>>({});

  #generation = 0;
  #queryKey = "";
  #pending = false;
  #again = false;
  #active = false;
  #disposed = false;
  #refreshedAt = 0;
  #debounce: ReturnType<typeof setTimeout> | null = null;
  #poll: ReturnType<typeof setTimeout> | null = null;
  #stopEvents: (() => void) | null = null;

  constructor(readonly kind: ResourceAppKind) {}

  get allowed() {
    const scope = this.scope;
    if (!scope) return false;
    return scope.kind === "mine"
      ? hasAccountScope(runtime.context, "user.taskrun.list")
      : hasScopes(runtime.context, scope.spaceId, scopePermissions(this.kind, scope));
  }

  get #cacheKey() {
    const scope = this.scope;
    const context = runtime.context;
    if (!scope || !context) return null;
    return resourceKey(
      context,
      scope.kind === "space" ? scope.spaceId : "mine",
      this.kind,
      "list",
      `${scopeHash(scope)}:${this.filter}`,
    );
  }

  query(scope: ResourceScope | null, filter: TaskFilter, viewer: string | null) {
    const key = JSON.stringify([viewer, scope, filter]);
    if (key === this.#queryKey) return;
    this.#queryKey = key;
    this.scope = scope;
    this.filter = filter;
    this.#generation += 1;
    this.#pending = false;
    this.#again = false;
    this.#stop();
    const cached = this.allowed
      ? readCache<ResourcePage>(this.#cacheKey)?.value
      : null;
    this.rows = Array.isArray(cached?.rows) ? cached.rows : [];
    this.cursor = cached?.cursor ?? null;
    this.denied = false;
    this.error = null;
    this.loading = false;
    this.loadingMore = false;
    this.#refreshedAt = 0;
    if (!scope) return;
    this.#subscribe(scope);
    if (this.#active) void this.load("replace", true);
  }

  setActive(active: boolean) {
    const resumed = active && !this.#active;
    this.#active = active;
    if (!active) return this.#clearPoll();
    if (resumed && this.scope)
      void this.load(this.#refreshedAt ? "refresh" : "replace", !this.#refreshedAt);
  }

  revoke() {
    this.#generation += 1;
    this.#pending = false;
    this.#stop();
    forgetCache(this.#cacheKey);
    this.rows = [];
    this.cursor = null;
    this.denied = true;
    this.loading = false;
    this.loadingMore = false;
  }

  remove(id: string) {
    this.rows = this.rows.filter((row) => row.id !== id);
    this.#persist();
  }

  async load(mode: LoadMode = "refresh", consent = false): Promise<void> {
    const scope = this.scope;
    if (!scope || this.#disposed) return;
    if (this.#pending) {
      if (mode === "refresh") this.#again = true;
      return;
    }
    if (mode === "refresh" && !this.#active) return;
    const generation = this.#generation;
    const current = () => !this.#disposed && generation === this.#generation;
    this.#pending = true;
    this.refreshing = true;
    if (mode === "replace") this.loading = this.rows.length === 0;
    if (mode === "append") this.loadingMore = true;
    try {
      const page = await listResources(
        this.kind,
        scope,
        this.filter,
        mode === "append" ? this.cursor : null,
      );
      // A refresh refills every loaded page so the list keeps its length and scroll.
      const target = mode === "refresh" ? this.rows.length : 0;
      const visited = new Set<string>();
      while (current() && page.cursor && page.rows.length < target && !visited.has(page.cursor)) {
        visited.add(page.cursor);
        const next = await listResources(this.kind, scope, this.filter, page.cursor);
        page.rows.push(...next.rows);
        page.cursor = next.cursor;
      }
      if (!current()) return;
      const merged = mode === "append" ? [...this.rows, ...page.rows] : page.rows;
      this.rows = [...new Map(merged.map((row) => [row.id, row])).values()];
      this.cursor = page.cursor;
      this.denied = false;
      this.error = null;
      this.#refreshedAt = Date.now();
      this.#persist();
    } catch (cause) {
      if (!current()) return;
      if (isAccessError(cause)) {
        forgetCache(this.#cacheKey);
        this.rows = [];
        this.cursor = null;
        this.denied = true;
        if (consent && scope.kind === "space" && this.#silentConsent(scope)) {
          this.#pending = false;
          if (await this.authorize().catch(() => false)) await this.load("replace");
        }
      } else this.error = this.rows.length ? "stale" : "error";
    } finally {
      if (current()) {
        this.#pending = false;
        this.refreshing = false;
        this.loading = false;
        this.loadingMore = false;
        this.#schedulePoll();
        if (this.#again) {
          this.#again = false;
          void this.load("refresh");
        }
      }
    }
  }

  async authorize() {
    const scope = this.scope;
    if (!scope || this.authorizing) return false;
    const key = this.#queryKey;
    this.authorizing = true;
    try {
      const result = await client.auth.authorize({
        target: scope.kind === "mine" ? { kind: "account" } : { kind: "space", spaceId: scope.spaceId },
        scopes: scopePermissions(this.kind, scope),
        fallback: "none",
        reason: m.resource_app_access_reason({}, { locale: runtime.locale }),
      });
      return (
        key === this.#queryKey &&
        result.status === "granted" &&
        (scope.kind === "mine"
          ? result.target.kind === "account"
          : result.target.kind === "space" && result.target.spaceId === scope.spaceId)
      );
    } finally {
      if (!this.#disposed) this.authorizing = false;
    }
  }

  async requestAccess() {
    if (await this.authorize().catch(() => false)) await this.load("replace");
  }

  async pickSpace(): Promise<string | null> {
    if (this.authorizing) return null;
    const viewer = runtime.viewer;
    this.authorizing = true;
    try {
      const result = await client.auth.authorize({
        target: { kind: "pick-space" },
        scopes: scopePermissions(this.kind, { kind: "space", spaceId: "" }),
        reason: m.resource_app_access_reason({}, { locale: runtime.locale }),
        alwaysAsk: true,
        fallback: "none",
      });
      if (this.#disposed || viewer !== runtime.viewer || result.status !== "granted" || result.target.kind !== "space")
        return null;
      if (result.target.name)
        this.spaceNames = { ...this.spaceNames, [result.target.spaceId]: result.target.name };
      return result.target.spaceId;
    } catch {
      return null;
    } finally {
      if (!this.#disposed) this.authorizing = false;
    }
  }

  dispose() {
    this.#disposed = true;
    this.#generation += 1;
    this.#stop();
  }

  #silentConsent(scope: ResourceScope) {
    return scopePermissions(this.kind, scope).every(isAppSilentShellScope);
  }

  #persist() {
    writeCache(this.#cacheKey, { rows: this.rows, cursor: this.cursor });
  }

  #subscribe(scope: ResourceScope) {
    if (scope.kind !== "space" || this.kind === "cronjob") return;
    this.#stopEvents = subscribeSpace(scope.spaceId, (event) => this.#onEvent(event, scope));
  }

  #onEvent(event: SpaceEvent, scope: Extract<ResourceScope, { kind: "space" }>) {
    if (!this.#active) return;
    if (this.kind === "app") {
      if (event.type === "app.version.published") this.#refreshSoon();
      return;
    }
    const task = asRecord(asRecord(event.payload)?.task);
    if (!task || (event.type !== "task.created" && event.type !== "task.updated")) return;
    if (this.kind === "checkpoint") {
      if (task.type === "save_checkpoint" && task.status === "completed") this.#refreshSoon();
      return;
    }
    if (scope.sessionId && task.sessionId !== scope.sessionId) return;
    if (event.type === "task.created") return this.#refreshSoon();
    const index = this.rows.findIndex((row) => row.id === task.id);
    const row = this.rows[index];
    if (row?.kind !== "task") return;
    const status = task.status as typeof row.status;
    if (!matchesTaskFilter(status, this.filter)) {
      this.rows = this.rows.filter((item) => item.id !== row.id);
    } else {
      const text = (key: string) => (typeof task[key] === "string" ? (task[key] as string) : null);
      this.rows[index] = {
        ...row,
        status,
        startedAt: text("startedAt") ?? row.startedAt,
        finishedAt: text("finishedAt") ?? row.finishedAt,
        errorMessage: text("errorMessage")?.slice(0, 240) ?? row.errorMessage,
      };
    }
    this.#persist();
  }

  #refreshSoon() {
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => void this.load("refresh"), 400);
  }

  #schedulePoll() {
    this.#clearPoll();
    if (
      this.#active &&
      !this.#stopEvents &&
      this.kind === "task" &&
      this.rows.some((row) => row.kind === "task" && (row.status === "pending" || row.status === "running"))
    )
      this.#poll = setTimeout(() => void this.load("refresh"), 5000);
  }

  #clearPoll() {
    if (this.#poll) clearTimeout(this.#poll);
    this.#poll = null;
  }

  #stop() {
    this.#clearPoll();
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = null;
    this.#stopEvents?.();
    this.#stopEvents = null;
  }
}
