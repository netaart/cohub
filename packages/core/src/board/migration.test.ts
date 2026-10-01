import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { parseBoardDocument, upgradeBoardSnapshotV2 } from "@cohub/protocol";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/api/drizzle/v2");

const BOARD_ID = "11111111-1111-4111-8111-111111111111";
const SPACE_ID = "22222222-2222-4222-8222-222222222222";
const migrationSql = () => readFileSync(join(migrations, "0067_board_v3.sql"), "utf8").replaceAll("--> statement-breakpoint", "");
const journalOf = () => JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };

const readItems = async (client: PGlite) => (await client.query<{ id: string; data: unknown }>(`SELECT "id", jsonb_build_object('board', jsonb_build_object(), 'items', jsonb_build_object("id", "data"), 'animations', jsonb_build_object()) AS data FROM "v2"."board_items"`)).rows;

async function fixture() {
	const client = new PGlite({ extensions: { pg_trgm } });
	const journal = journalOf();
	const upTo = journal.entries.findIndex((entry) => entry.tag === "0067_board_v3");
	for (const entry of journal.entries.slice(0, upTo)) {
		await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
	}
	return client;
}

async function applyBoard(client: PGlite, nodes: Array<Record<string, unknown>>, clips: Array<Record<string, unknown>> = []) {
	await client.query(`INSERT INTO "v2"."boards" ("id", "space_id", "title", "version", "metadata") VALUES ($1, $2, 'Legacy', 1, '{}'::jsonb)`, [BOARD_ID, SPACE_ID]);
	for (const node of nodes) {
		const entries = Object.entries(node);
		await client.query(
			`INSERT INTO "v2"."board_nodes" (${entries.map(([column]) => `"${column}"`).join(", ")}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(", ")})`,
			entries.map(([, value]) => value),
		);
	}
	if (clips.length) {
		await client.query(`INSERT INTO "v2"."board_compositions" ("board_id", "id", "name", "duration", "playback", "markers", "metadata") VALUES ($1, 'tour', 'Tour', 2000, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb)`, [BOARD_ID]);
		for (const clip of clips) {
			const row = { board_id: BOARD_ID, composition_id: "tour", kind_version: 1, layer: "content", fill: "none", easing: "linear", seed: "s", ...clip };
			const entries = Object.entries(row);
			await client.query(
				`INSERT INTO "v2"."board_clips" (${entries.map(([column]) => `"${column}"`).join(", ")}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(", ")})`,
				entries.map(([, value]) => value),
			);
		}
	}
	await client.exec(migrationSql());
}

async function migrate(nodes: Array<Record<string, unknown>>, clips: Array<Record<string, unknown>> = []) {
	const client = await fixture();
	await applyBoard(client, nodes, clips);
	return { client, rows: await readItems(client) };
}

test("a v2 media node with no source path survives as a legacy item", async () => {
	const node = { board_id: BOARD_ID, node_id: "lost", type: "image", x: 10, y: 20, width: 300, height: 200, view: { title: "cover.png", mimeType: "image/png", unknownFact: 1 } };
	const { client, rows } = await migrate([node]);
	const parsed = parseBoardDocument(rows[0]?.data);
	assert.ok(parsed.ok, JSON.stringify(parsed.ok ? [] : parsed.diagnostics));
	const item = parsed.document.items.lost;
	assert.equal(item?.type, "legacy.image");
	assert.deepEqual(item?.position, { x: 10, y: 20 });
	assert.deepEqual(item?.props, { snapshot: { title: "cover.png", mimeType: "image/png" } });
	const archived = await client.query<{ nodes: Array<Record<string, unknown>> }>(`SELECT "patch"->'legacy'->'nodes' AS nodes FROM "v2"."board_transactions" WHERE "tx_id" = 'migration:board-v3'`);
	assert.equal(archived.rows[0]?.nodes.length, 1);
	assert.equal(archived.rows[0]?.nodes[0]?.node_id, "lost");
	assert.deepEqual(archived.rows[0]?.nodes[0]?.view, node.view);
	await client.close();
});

test("paths the v3 schema rejects do not become src", async () => {
	for (const refPath of ["", null, "/absolute/hero.png", "assets/../secret.png", "assets\\hero.png", "assets//hero.png", "assets/hero.png/"]) {
		const node = { board_id: BOARD_ID, node_id: "media", type: "image", x: 0, y: 0, width: 300, height: 200, ref_path: refPath, ref_kind: "space-file", view: { title: "hero.png" } };
		const { client, rows } = await migrate([node]);
		const parsed = parseBoardDocument(rows[0]?.data);
		assert.ok(parsed.ok);
		assert.equal(parsed.document.items.media?.type, "legacy.image", `ref_path ${String(refPath)}`);
		await client.close();
	}
	const { client, rows } = await migrate([{ board_id: BOARD_ID, node_id: "media", type: "image", x: 0, y: 0, width: 300, height: 200, ref_path: "assets/hero.png", ref_kind: "space-file", view: { title: "hero.png", extra: true } }]);
	const parsed = parseBoardDocument(rows[0]?.data);
	assert.ok(parsed.ok);
	assert.equal(parsed.document.items.media?.type, "image");
	assert.deepEqual(parsed.document.items.media?.props.src, "assets/hero.png");
	const indexed = await client.query<{ src: string }>(`SELECT src FROM v2.board_items WHERE id = 'media'`);
	assert.equal(indexed.rows[0]?.src, "assets/hero.png");
	const foreignKeys = await client.query(`SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid::regclass::text LIKE 'v2.board%'`);
	assert.equal(foreignKeys.rows.length, 0);
	await client.close();
});

test("the migration and the TypeScript upgrade agree on camera tours", async () => {
	const upgradeNodes = ["a", "b", "c", "d"].map((id) => ({ id, type: "geo", position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, props: {}, style: {} }));
	const nodes = upgradeNodes.map((node, index) => ({ board_id: BOARD_ID, node_id: node.id, type: "geo", order_key: String(index), x: 0, y: 0, width: 100, height: 100, view: {}, data: {}, style: {} }));
	const easings = ["linear", "ease-in-quad", "ease-out-cubic", "ease-in-out-quart"];
	let seed = 1;
	const rnd = (limit: number) => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed % limit;
	};
	const generated = Array.from({ length: 24 }, (_, round) =>
		Array.from({ length: 1 + rnd(4) }, (_, index) => ({
			id: `c${round}-${index}`,
			start: rnd(4) * 200,
			duration: (1 + rnd(4)) * 100,
			item: nodes[rnd(4)]?.node_id as string,
			easing: easings[rnd(4)] as string,
		})),
	);
	const patches = generated.map((clips) =>
		upgradeBoardSnapshotV2({
			board: { title: "T", metadata: {} },
			items: upgradeNodes,
			compositions: [{ id: "tour", name: "T", timeline: { duration: 8000, tracks: [], markers: [], clips: clips.map((clip) => ({ id: clip.id, kind: "camera.focus", start: clip.start, duration: clip.duration, easing: clip.easing, params: { focus: { type: "item", itemId: clip.item } } })) }, playback: {} }],
		}),
	);
	for (const [index, clips] of generated.entries()) {
		const { client } = await migrate(nodes, clips.map((clip) => ({ id: clip.id, kind: "camera.focus", start: clip.start, duration: clip.duration, easing: clip.easing, target: { type: "item", itemId: clip.item }, params: { focus: { type: "item", itemId: clip.item } } })));
		const rows = await client.query<{ data: { keyframes: Array<{ at: number; value: unknown; ease?: string }> } }>(`SELECT "data" FROM "v2"."board_tracks" WHERE "id" = 'camera-focus'`);
		const parsed = parseBoardDocument(patches[index] as never);
		assert.ok(parsed.ok);
		const migrated = rows.rows[0]?.data.keyframes ?? [];
		const expected = parsed.document.animations.tour?.tracks["camera-focus"]?.keyframes ?? [];
		assert.deepEqual(
			migrated.map((keyframe) => [keyframe.at, keyframe.value, keyframe.ease ?? null]),
			expected.map((keyframe) => [keyframe.at, keyframe.value, (keyframe as { ease?: string }).ease ?? null]),
			`clips ${JSON.stringify(clips)}`,
		);
		await client.close();
	}
});

test("a tour starting at zero keeps its hold, and clips sharing a start agree", async () => {
	const node = (id: string, z: number) => ({ board_id: BOARD_ID, node_id: id, type: "geo", order_key: String(z), x: 0, y: 0, width: 100, height: 100, view: {}, data: {}, style: {} });
	const focus = (id: string, start: number, duration: number, item: string) => ({ id, kind: "camera.focus", start, duration, target: { type: "item", itemId: item }, params: { focus: { type: "item", itemId: item } } });
	const { client } = await migrate([node("a", 1), node("b", 2), node("c", 3)], [
		focus("d", 0, 600, "a"),
		focus("e", 0, 200, "b"),
		focus("f", 300, 100, "c"),
	]);
	const rows = await client.query<{ data: { keyframes: Array<{ at: number; value: unknown }> } }>(`SELECT "data" FROM "v2"."board_tracks" WHERE "id" = 'camera-focus'`);
	const keyframes = rows.rows[0]?.data.keyframes ?? [];
	assert.deepEqual(keyframes.map((keyframe) => [keyframe.at, keyframe.value]), [[0, "b"], [200, "b"], [400, "c"], [600, "c"]]);
	await client.close();
});

test("clips that agree on start and end still migrate in a fixed order", async () => {
	const node = (id: string, z: number) => ({ board_id: BOARD_ID, node_id: id, type: "geo", order_key: String(z), x: 0, y: 0, width: 100, height: 100, view: {}, data: {}, style: {} });
	const focus = (id: string, start: number, duration: number, item: string) => ({ id, kind: "camera.focus", start, duration, target: { type: "item", itemId: item }, params: { focus: { type: "item", itemId: item } } });
	const { client } = await migrate([node("b", 1), node("c", 2)], [focus("c1", 0, 600, "c"), focus("c2", 300, 100, "c"), focus("b1", 300, 100, "b")]);
	const rows = await client.query<{ data: { keyframes: Array<{ at: number; value: unknown }> } }>(`SELECT "data" FROM "v2"."board_tracks" WHERE "id" = 'camera-focus'`);
	const keyframes = rows.rows[0]?.data.keyframes ?? [];
	assert.deepEqual(keyframes.map((keyframe) => [keyframe.at, keyframe.value]), [[0, "c"], [400, "c"], [600, "c"]]);
	await client.close();
});

test("overlapping camera tour clips migrate to ordered keyframes", async () => {
	const node = (id: string, z: number) => ({ board_id: BOARD_ID, node_id: id, type: "geo", order_key: String(z), x: 0, y: 0, width: 100, height: 100, view: {}, data: {}, style: {} });
	const focus = (id: string, start: number, duration: number, item: string) => ({ id, kind: "camera.focus", start, duration, target: { type: "item", itemId: item }, params: { focus: { type: "item", itemId: item } } });
	const { client } = await migrate([node("a", 1), node("b", 2)], [focus("f1", 0, 1000, "a"), focus("f2", 500, 1500, "b")]);
	const rows = await client.query<{ data: { keyframes: Array<{ at: number; value: unknown }> } }>(`SELECT "data" FROM "v2"."board_tracks" WHERE "id" = 'camera-focus'`);
	const keyframes = rows.rows[0]?.data.keyframes ?? [];
	assert.deepEqual(keyframes.map((keyframe) => [keyframe.at, keyframe.value]), [[0, "a"], [1000, "a"], [2000, "b"]]);
	assert.deepEqual(keyframes.map((keyframe) => keyframe.at), [...keyframes].map((keyframe) => keyframe.at).sort((a, b) => a - b));

	await client.close();
});

test("long legacy labels survive without invalidating the board", async () => {
	const label = "x".repeat(300);
	const { client, rows } = await migrate([
		{ board_id: BOARD_ID, node_id: "f", type: "frame", x: 0, y: 0, width: 400, height: 300, data: { label } },
		{ board_id: BOARD_ID, node_id: "a", type: "arrow", x: 0, y: 0, width: 100, height: 100, data: { label, start: { x: 0, y: 0 }, end: { x: 100, y: 100 } } },
	]);
	for (const row of rows) {
		const parsed = parseBoardDocument(row.data);
		assert.ok(parsed.ok);
		const item = parsed.document.items[row.id];
		assert.equal(item?.type, row.id === "f" ? "legacy.frame" : "legacy.arrow");
		assert.ok(item && "label" in item.props);
		assert.equal(item.props.label, label);
	}
	const types = await client.query<{ type: string }>(`SELECT type FROM v2.board_items WHERE id = 'f'`);
	assert.equal(types.rows[0]?.type, "legacy.frame");
	await client.close();
});

test("unsupported legacy ids stop before destructive migration work", async () => {
	const client = await fixture();
	await assert.rejects(applyBoard(client, [{ board_id: BOARD_ID, node_id: "camera", type: "geo", x: 0, y: 0, width: 100, height: 100 }]), /identifiers are incompatible/);
	const original = await client.query<{ node_id: string }>(`SELECT node_id FROM v2.board_nodes WHERE board_id = $1`, [BOARD_ID]);
	assert.equal(original.rows[0]?.node_id, "camera");
	await client.close();
});
