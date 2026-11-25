import type { JsonRecord, JsonRpcProcess } from "../json-rpc.js";
import { confirmQuiescentProcessGroup } from "../process-group.js";

const IDLE_MS = 2 * 60_000;
const MAX_WARM = 4;

type Warm = { host: JsonRpcProcess; launch: string; nativeSessionId: string; release: () => void };

/** At most one kept process per Session; a replacement waits until the previous one has stopped. */
export class WarmHosts {
  private readonly warm = new Map<string, Warm>();
  private readonly closing = new Map<string, { host: JsonRpcProcess; closed: Promise<void> }>();

  async take(sessionId: string, nativeSessionId: string, launch: string): Promise<JsonRpcProcess | null> {
    const entry = this.warm.get(sessionId);
    if (entry?.nativeSessionId === nativeSessionId && entry.launch === launch) {
      this.forget(sessionId);
      return entry.host;
    }
    this.retire(sessionId);
    const closing = this.closing.get(sessionId);
    if (closing) {
      await closing.closed.catch(async (error: unknown) => {
        const group = closing.host.processGroupId;
        if (group == null || !await confirmQuiescentProcessGroup(group)) throw new Error(`The Session's previous process has not stopped (${error instanceof Error ? error.message : String(error)})`);
      });
      if (this.closing.get(sessionId) === closing) this.closing.delete(sessionId);
    }
    return null;
  }

  keep(sessionId: string, nativeSessionId: string, launch: string, host: JsonRpcProcess, wakes: (event: JsonRecord) => boolean) {
    const drop = () => { if (this.warm.get(sessionId)?.host === host) this.retire(sessionId); };
    const timer = setTimeout(drop, IDLE_MS);
    timer.unref();
    const offEvent = host.onEvent((event) => { if (wakes(event)) drop(); });
    const offFailure = host.onFailure(drop);
    this.warm.set(sessionId, { host, launch, nativeSessionId, release: () => { clearTimeout(timer); offEvent(); offFailure(); } });
    if (this.warm.size > MAX_WARM) this.retire(this.warm.keys().next().value as string);
  }

  async close() {
    for (const sessionId of [...this.warm.keys()]) this.retire(sessionId);
    await Promise.allSettled([...this.closing.values()].map((closing) => closing.closed));
  }

  private forget(sessionId: string) {
    this.warm.get(sessionId)?.release();
    this.warm.delete(sessionId);
  }

  private retire(sessionId: string) {
    const host = this.warm.get(sessionId)?.host;
    if (!host) return;
    this.forget(sessionId);
    const previous = this.closing.get(sessionId)?.closed ?? Promise.resolve();
    const closed = previous.then(() => host.close());
    const closing = { host, closed };
    this.closing.set(sessionId, closing);
    closed.then(() => { if (this.closing.get(sessionId) === closing) this.closing.delete(sessionId); }, () => undefined);
  }
}
