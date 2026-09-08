export type MeasuredMessage = { id: string; revision: string };

// Estimates are only for scroll recovery, never FlatList's exact getItemLayout contract.
export class MessageMeasurements {
  private entries = new Map<string, { revision: string; height: number }>();
  private environment = "";

  configure(environment: string, messages: readonly MeasuredMessage[]): void {
    if (environment !== this.environment) {
      this.entries.clear();
      this.environment = environment;
    }
    const revisions = new Map(messages.map((message) => [message.id, message.revision]));
    for (const [id, entry] of this.entries) {
      if (revisions.get(id) !== entry.revision) this.entries.delete(id);
    }
  }

  measure(message: MeasuredMessage, height: number): void {
    if (!Number.isFinite(height) || height <= 0) throw new Error("Message height must be positive and finite.");
    this.entries.set(message.id, { revision: message.revision, height });
  }

  estimateOffset(messages: readonly MeasuredMessage[], index: number, averageHeight: number): number {
    let offset = 0;
    for (const message of messages.slice(0, index)) {
      const entry = this.entries.get(message.id);
      offset += entry?.revision === message.revision ? entry.height : Math.max(averageHeight, 1);
    }
    return offset;
  }
}

// Generation events contain complete snapshots, so intermediate snapshots can be coalesced.
export function createStreamBatch<T>(publish: (value: T) => void) {
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  const flush = () => {
    const next = pending;
    cancel();
    if (next) publish(next.value);
  };
  return {
    push(value: T) {
      pending = { value };
      if (timer === null) timer = setTimeout(flush, 32);
    },
    flush,
    cancel,
  };
}
