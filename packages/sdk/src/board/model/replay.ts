import {
	applyBoardDelta,
	type BoardDocument,
	type BoardHistoryPage,
	type BoardTransactionRecord,
	type RequestSource,
} from "@cohub/protocol";

export type BoardReplayActorKind = "human" | "cli" | "agent";

export type BoardReplayEntry = {
	version: number;
	actorId: string;
	kind: BoardReplayActorKind;
	at: number;
};

export type BoardReplayPlayer = ReturnType<typeof createBoardReplayPlayer>;

export function boardReplayActorKind(source: RequestSource | null): BoardReplayActorKind {
	if (!source) return "human";
	if (source.toolCallId) return "agent";
	return source.via === "cli" ? "cli" : "human";
}

function entryOf(transaction: BoardTransactionRecord): BoardReplayEntry {
	return {
		version: transaction.version,
		actorId: transaction.actorId,
		kind: boardReplayActorKind(transaction.source),
		at: Date.parse(transaction.createdAt),
	};
}

export function createBoardReplayPlayer(live: BoardDocument, page: BoardHistoryPage) {
	let transactions: BoardTransactionRecord[] = [];
	let entries: BoardReplayEntry[] = [];
	let floor = page.version;
	let document = live;
	let cursor = page.version;
	const documents = new Map<number, BoardDocument>([[cursor, live]]);

	function addOlder(older: readonly BoardTransactionRecord[]) {
		const usable: BoardTransactionRecord[] = [];
		for (const transaction of [...older].sort((a, b) => b.version - a.version)) {
			if (transaction.version > floor) continue;
			if (!transaction.before || !transaction.after) break;
			if (transaction.version !== floor) break;
			usable.push(transaction);
			floor = transaction.baseVersion;
		}
		usable.reverse();
		transactions = [...usable, ...transactions];
		entries = [...usable.map(entryOf), ...entries];
	}
	addOlder(page.transactions);

	function lowerBound(version: number): number {
		let low = 0;
		let high = transactions.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if ((transactions[mid] as BoardTransactionRecord).version < version) low = mid + 1;
			else high = mid;
		}
		return low;
	}

	const head = () => transactions.at(-1)?.version ?? page.version;

	function seek(version: number): number {
		const target = Math.max(floor, Math.min(head(), version));
		while (cursor > target) {
			const transaction = transactions[lowerBound(cursor)];
			if (!transaction || transaction.version !== cursor || !transaction.before) break;
			document = applyBoardDelta(document, transaction.before);
			cursor = transaction.baseVersion;
		}
		for (let next = transactions[lowerBound(cursor + 1)]; next && next.version <= target; next = transactions[lowerBound(cursor + 1)]) {
			if (!next.after) break;
			document = applyBoardDelta(document, next.after);
			cursor = next.version;
		}
		return cursor;
	}

	return {
		get floor() {
			return floor;
		},
		get head() {
			return head();
		},
		get entries(): readonly BoardReplayEntry[] {
			return entries;
		},
		get version() {
			return cursor;
		},
		seek,
		documentAt(version: number): BoardDocument {
			const reached = seek(version);
			const cached = documents.get(reached);
			if (cached) return cached;
			documents.set(reached, document);
			return document;
		},
		changedItemIds(version: number): string[] {
			const transaction = transactions[lowerBound(version)];
			return transaction?.version === version ? Object.keys(transaction.after?.items ?? {}) : [];
		},
		prepend(older: BoardHistoryPage): void {
			addOlder(older.transactions);
		},
		append(latest: BoardHistoryPage): boolean {
			const current = head();
			const fresh = latest.transactions.filter((transaction) => transaction.version > current).sort((a, b) => a.version - b.version);
			if (fresh.length === 0) return true;
			if ((fresh[0] as BoardTransactionRecord).baseVersion > current) return false;
			transactions = [...transactions, ...fresh];
			entries = [...entries, ...fresh.map(entryOf)];
			return true;
		},
	};
}
