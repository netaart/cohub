import { client } from "../client.ts";
import { forgetDraft, readDraft, writeDraft } from "../storage.ts";

/*
 * The unsaved form of the open resource: every edit is written to local storage
 * immediately, and the host window stays dirty until that write succeeded.
 */
export class DraftController {
  value = $state<Record<string, unknown> | null>(null);
  failed = $state(false);
  #key: string | null = null;

  get dirty() {
    return this.value !== null;
  }

  load(key: string | null) {
    this.#key = key;
    this.value = readDraft(key);
    this.failed = false;
    this.#report();
  }

  bind() {
    const key = this.#key;
    return (next: Record<string, unknown> | null) => {
      if (key === this.#key) this.update(next);
    };
  }

  update(next: Record<string, unknown> | null) {
    this.value = next;
    if (next === null) {
      forgetDraft(this.#key);
      this.failed = false;
    } else this.failed = !writeDraft(this.#key, next);
    this.#report();
  }

  persist() {
    if (!this.value) return true;
    this.failed = !writeDraft(this.#key, this.value);
    if (!this.failed) client.app.window.setState({ dirty: false });
    return !this.failed;
  }

  reset() {
    this.#key = null;
    this.value = null;
    this.failed = false;
    this.#report();
  }

  #report() {
    client.app.window.setState({ dirty: this.dirty });
  }
}
