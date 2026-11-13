import type { SessionRecord } from "@neta-art/cohub";
import { sdk } from "$lib/sdk";
import { sessionStore } from "$lib/stores/session-store";

// Single clicks wait this long so a double click can enter rename instead.
const NAVIGATE_DELAY_MS = 120;

function isPlainClick(event: MouseEvent) {
	return !(
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.button !== 0
	);
}

export class SessionRename {
	id = $state<string | null>(null);
	owner = $state<string | null>(null);
	value = $state("");
	saving = $state(false);
	error = $state("");
	#initial = "";
	#timer: ReturnType<typeof setTimeout> | null = null;

	click(event: MouseEvent, navigate: () => void, wait = true) {
		if (!isPlainClick(event)) return;
		event.preventDefault();
		this.cancelClick();
		if (!wait || event.detail === 0) {
			navigate();
			return;
		}
		this.#timer = setTimeout(() => {
			this.#timer = null;
			navigate();
		}, NAVIGATE_DELAY_MS);
	}

	cancelClick() {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = null;
	}

	doubleClick(
		event: MouseEvent,
		session: SessionRecord,
		title: string,
		owner: string,
	) {
		if (!isPlainClick(event)) return;
		event.preventDefault();
		event.stopPropagation();
		this.start(session, title, owner);
	}

	start(session: SessionRecord, title: string, owner: string) {
		this.cancelClick();
		if (this.saving) return;
		this.id = session.id;
		this.owner = owner;
		this.value = this.#initial = session.title ?? title;
		this.error = "";
	}

	cancel() {
		this.id = null;
		this.owner = null;
		this.value = "";
		this.error = "";
	}

	async submit(session: SessionRecord) {
		if (this.saving || this.id !== session.id) return;
		const title = this.value.trim();
		if (!title || title === this.#initial) {
			this.cancel();
			return;
		}
		this.saving = true;
		this.error = "";
		try {
			const result = await sdk
				.space(session.spaceId)
				.session(session.id)
				.rename(title);
			sessionStore.merge(result.session);
			if (this.id === session.id) this.cancel();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.saving = false;
		}
	}
}
