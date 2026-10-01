-- Board protocol v3: items, animations and tracks replace nodes, connections,
-- effects, compositions and clips. Every Board's complete v2 state is archived
-- verbatim in a migration transaction before anything is converted or dropped.

-- Reject identifiers that cannot be represented before touching any source rows.
-- Do not silently rename identifiers: external links may still refer to them.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT "node_id" AS id FROM "v2"."board_nodes" WHERE "deleted_at" IS NULL
      UNION ALL SELECT "connection_id" FROM "v2"."board_connections" WHERE "deleted_at" IS NULL
      UNION ALL SELECT 'connection-' || c."connection_id" FROM "v2"."board_connections" c
        JOIN "v2"."board_nodes" n ON n."board_id" = c."board_id" AND n."node_id" = c."connection_id"
        WHERE c."deleted_at" IS NULL AND n."deleted_at" IS NULL
      UNION ALL SELECT "id" FROM "v2"."board_compositions"
      UNION ALL SELECT "id" FROM "v2"."board_tracks"
      UNION ALL SELECT "id" FROM "v2"."board_clips"
    ) ids WHERE id = '' OR length(id) > 160 OR id = 'camera' OR id ~ '[[:space:]/]'
  ) THEN
    RAISE EXCEPTION 'Legacy Board identifiers are incompatible with Board v3';
  END IF;
END
$$;

CREATE FUNCTION pg_temp.board_v3_color(value text) RETURNS text AS $$
  SELECT CASE WHEN value IN ('brand', 'neutral', 'black', 'white', 'blue', 'green', 'amber', 'violet', 'rose') THEN value ELSE 'brand' END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp.board_v3_ease(value text) RETURNS text AS $$
  SELECT CASE value
    WHEN 'ease-in-quad' THEN 'cubic-bezier(0.11, 0, 0.5, 0)'
    WHEN 'ease-out-quad' THEN 'cubic-bezier(0.5, 1, 0.89, 1)'
    WHEN 'ease-in-out-quad' THEN 'cubic-bezier(0.45, 0, 0.55, 1)'
    WHEN 'ease-in-cubic' THEN 'cubic-bezier(0.32, 0, 0.67, 0)'
    WHEN 'ease-out-cubic' THEN 'cubic-bezier(0.33, 1, 0.68, 1)'
    WHEN 'ease-in-out-cubic' THEN 'cubic-bezier(0.65, 0, 0.35, 1)'
    WHEN 'ease-out-quart' THEN 'cubic-bezier(0.25, 1, 0.5, 1)'
    WHEN 'ease-out-expo' THEN 'cubic-bezier(0.16, 1, 0.3, 1)'
    ELSE NULL
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION pg_temp.board_v3_anchor(value jsonb) RETURNS jsonb AS $$
  SELECT CASE value->>'kind'
    WHEN 'side' THEN jsonb_build_object('side', value->'side', 'offset', coalesce(value->'offset', '0.5'::jsonb))
    WHEN 'fixed' THEN jsonb_build_object('x', value->'nx', 'y', value->'ny')
    ELSE NULL
  END
$$ LANGUAGE sql IMMUTABLE;

-- A `src` the v3 schema accepts: relative, non-empty, no backslash, no traversal.
CREATE FUNCTION pg_temp.board_v3_src(value text) RETURNS jsonb AS $$
  SELECT CASE
    WHEN value IS NULL OR value = '' OR length(value) > 4096 OR value LIKE '/%' OR value LIKE '%/' OR position('//' IN value) > 0 OR position(chr(92) IN value) > 0 OR value ~ '(^|/)(\.|\.\.)(/|$)'
      THEN NULL
    ELSE to_jsonb(value)
  END
$$ LANGUAGE sql IMMUTABLE;

-- Keep only the file facts the v3 snapshot schema knows.
CREATE FUNCTION pg_temp.board_v3_snapshot(value jsonb) RETURNS jsonb AS $$
  SELECT nullif(coalesce((
    SELECT jsonb_object_agg(key, val) FROM jsonb_each(coalesce(value, '{}'::jsonb)) AS entry(key, val)
    WHERE key IN ('title', 'mimeType', 'size', 'mtimeMs', 'naturalWidth', 'naturalHeight', 'durationMs', 'excerpt', 'coverPath', 'coverUrl')
  ), '{}'::jsonb), '{}'::jsonb)
$$ LANGUAGE sql IMMUTABLE;

-- 1. Legacy transactions keep their v2 operations and inverses inside `patch`.
ALTER TABLE "v2"."board_transactions" DROP CONSTRAINT "board_transactions_board_id_boards_id_fk";
ALTER TABLE "v2"."board_transactions" ADD COLUMN "patch" jsonb;
ALTER TABLE "v2"."board_transactions" ADD COLUMN "changes" jsonb;
UPDATE "v2"."board_transactions" t SET "patch" = jsonb_build_object('legacy', jsonb_strip_nulls(jsonb_build_object(
  'protocol', 2,
  'operations', t."operations",
  'undoGroupId', t."undo_group_id",
  'inverses', (
    SELECT jsonb_agg(jsonb_build_object('index', o."operation_index", 'type', o."type", 'payload', o."payload", 'inverse', o."inverse") ORDER BY o."operation_index")
    FROM "v2"."board_operations" o WHERE o."transaction_id" = t."id"
  )
)));

ALTER TABLE "v2"."board_transactions" ALTER COLUMN "patch" SET NOT NULL;
ALTER TABLE "v2"."board_transactions" DROP COLUMN "operations";
ALTER TABLE "v2"."board_transactions" DROP COLUMN "undo_group_id";

-- 2. Archive every Board's complete v2 state as one migration transaction.
INSERT INTO "v2"."board_transactions" ("board_id", "tx_id", "base_version", "result_version", "actor_id", "patch", "changes", "receipt", "metadata", "created_at")
SELECT
  b."id",
  'migration:board-v3',
  b."version",
  b."version" + 1,
  'system',
  jsonb_build_object('legacy', jsonb_build_object(
    'protocol', 2,
    'board', jsonb_build_object('title', b."title", 'metadata', b."metadata"),
    'nodes', coalesce((SELECT jsonb_agg(to_jsonb(n) - 'board_id') FROM "v2"."board_nodes" n WHERE n."board_id" = b."id"), '[]'::jsonb),
    'connections', coalesce((SELECT jsonb_agg(to_jsonb(c) - 'board_id') FROM "v2"."board_connections" c WHERE c."board_id" = b."id"), '[]'::jsonb),
    'effects', coalesce((SELECT jsonb_agg(to_jsonb(e) - 'board_id') FROM "v2"."board_effects" e WHERE e."board_id" = b."id"), '[]'::jsonb),
    'compositions', coalesce((SELECT jsonb_agg(to_jsonb(c) - 'board_id') FROM "v2"."board_compositions" c WHERE c."board_id" = b."id"), '[]'::jsonb),
    'tracks', coalesce((SELECT jsonb_agg(to_jsonb(t) - 'board_id') FROM "v2"."board_tracks" t WHERE t."board_id" = b."id"), '[]'::jsonb),
    'clips', coalesce((SELECT jsonb_agg(to_jsonb(c) - 'board_id') FROM "v2"."board_clips" c WHERE c."board_id" = b."id"), '[]'::jsonb),
    'playback', (SELECT to_jsonb(p) - 'board_id' FROM "v2"."board_playback_states" p WHERE p."board_id" = b."id")
  )),
  NULL,
  jsonb_build_object('mutationId', 'migration:board-v3', 'status', 'applied', 'replayed', false, 'version', b."version" + 1,
    'changed', jsonb_build_object('board', true, 'items', '[]'::jsonb, 'animations', '[]'::jsonb), 'diagnostics', '[]'::jsonb),
  jsonb_build_object('migration', 'board-v3'),
  now()
FROM "v2"."boards" b;

-- 3. Board settings and the shared playback clock.
ALTER TABLE "v2"."boards" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "v2"."boards" ADD COLUMN "playback" jsonb;
UPDATE "v2"."boards" b SET
  "version" = b."version" + 1,
  "settings" = jsonb_strip_nulls(jsonb_build_object(
    'background', jsonb_strip_nulls(jsonb_build_object(
      'kind', CASE WHEN b."metadata"->'appearance'->'background'->>'kind' IN ('solid', 'dots', 'grid', 'image') THEN b."metadata"->'appearance'->'background'->>'kind' ELSE 'solid' END,
      'imageUrl', b."metadata"->'appearance'->'background'->'imageUrl',
      'fit', b."metadata"->'appearance'->'background'->'fit',
      'opacity', b."metadata"->'appearance'->'background'->'opacity'
    )),
    'grid', CASE WHEN (b."metadata"->'appearance'->'grid'->>'visible')::boolean THEN jsonb_build_object('visible', true, 'size', coalesce(b."metadata"->'appearance'->'grid'->'size', '24'::jsonb)) END,
    'enter', CASE WHEN b."metadata"->'appearance'->'motion'->'enter'->>'kind' = 'effects.deal' THEN '{"preset":"deal"}'::jsonb END
  ));

-- 4. Items.
CREATE TABLE "v2"."board_items" (
  "board_id" uuid NOT NULL,
  "id" text NOT NULL,
  "type" varchar(80) NOT NULL,
  "parent_id" text,
  "z" double precision DEFAULT 0 NOT NULL,
  "min_x" double precision NOT NULL,
  "min_y" double precision NOT NULL,
  "max_x" double precision NOT NULL,
  "max_y" double precision NOT NULL,
  "src" text,
  "binds" text[] DEFAULT '{}'::text[] NOT NULL,
  "data" jsonb NOT NULL,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

WITH nodes AS (
  SELECT n.*,
    row_number() OVER (PARTITION BY n."board_id" ORDER BY n."order_key" NULLS LAST, n."node_id") AS "z_rank",
    radians(n."rotation") AS "r",
    pg_temp.board_v3_src(n."ref_path") IS NOT NULL AS "has_src"
  FROM "v2"."board_nodes" n
  WHERE n."deleted_at" IS NULL
)
INSERT INTO "v2"."board_items" ("board_id", "id", "type", "z", "min_x", "min_y", "max_x", "max_y", "src", "data", "version", "created_at", "updated_at")
SELECT
  n."board_id",
  n."node_id",
  CASE n."type" WHEN 'geo' THEN 'shape' ELSE n."type" END,
  n."z_rank",
  n."x" + n."width" / 2 - (abs(n."width" * cos(n."r")) + abs(n."height" * sin(n."r"))) / 2,
  n."y" + n."height" / 2 - (abs(n."width" * sin(n."r")) + abs(n."height" * cos(n."r"))) / 2,
  n."x" + n."width" / 2 + (abs(n."width" * cos(n."r")) + abs(n."height" * sin(n."r"))) / 2,
  n."y" + n."height" / 2 + (abs(n."width" * sin(n."r")) + abs(n."height" * cos(n."r"))) / 2,
  -- The same guard the payload uses, so the column never names a dropped source.
  CASE WHEN n."type" IN ('image', 'video', 'audio', 'file') THEN pg_temp.board_v3_src(n."ref_path") #>> '{}' END,
  jsonb_strip_nulls(jsonb_build_object(
    'type', CASE
      WHEN n."type" IN ('image', 'video', 'audio', 'file') AND NOT n."has_src" THEN 'legacy.' || n."type"
      WHEN n."type" = 'geo' THEN 'shape'
      WHEN n."type" IN ('frame', 'arrow') AND length(n."data"->>'label') > 280 THEN 'legacy.' || n."type"
      WHEN n."type" IN ('text', 'draw', 'arrow', 'frame', 'image', 'video', 'audio', 'file', 'task') THEN n."type"
      ELSE CASE WHEN position('.' IN n."type") > 0 THEN n."type" ELSE 'legacy.' || n."type" END END,
    'z', n."z_rank",
    'position', CASE WHEN n."type" = 'arrow' THEN NULL ELSE jsonb_build_object('x', n."x", 'y', n."y") END,
    'size', CASE WHEN n."type" IN ('text', 'draw', 'arrow') THEN NULL ELSE jsonb_build_object('width', n."width", 'height', n."height") END,
    'rotation', CASE WHEN n."type" = 'arrow' OR n."rotation" = 0 THEN NULL ELSE to_jsonb(n."rotation") END,
    'locked', CASE WHEN (n."data"->>'locked')::boolean THEN 'true'::jsonb END,
    'metadata', nullif(n."data"->'metadata', '{}'::jsonb),
    'style', nullif(jsonb_strip_nulls(CASE n."type"
      WHEN 'text' THEN jsonb_build_object('fill', CASE WHEN coalesce(n."data"->>'color', 'neutral') <> 'neutral' THEN pg_temp.board_v3_color(n."data"->>'color') END)
      WHEN 'geo' THEN jsonb_build_object(
        'stroke', pg_temp.board_v3_color(coalesce(n."data"->>'color', 'brand')),
        'fill', CASE WHEN coalesce((n."data"->>'fillOpacity')::double precision, 0) > 0 THEN pg_temp.board_v3_color(coalesce(n."data"->>'color', 'brand')) END,
        'fillOpacity', CASE WHEN coalesce((n."data"->>'fillOpacity')::double precision, 0) > 0 THEN n."data"->'fillOpacity' END)
      WHEN 'draw' THEN jsonb_build_object('stroke', pg_temp.board_v3_color(coalesce(n."data"->>'color', 'brand')), 'strokeWidth', coalesce(n."data"->'size', '4'::jsonb))
      WHEN 'arrow' THEN jsonb_build_object('stroke', pg_temp.board_v3_color(coalesce(n."data"->>'color', 'brand')), 'strokeWidth', coalesce(n."data"->'size', '2.5'::jsonb))
      WHEN 'frame' THEN jsonb_build_object('stroke', CASE WHEN coalesce(n."data"->>'color', 'neutral') <> 'neutral' THEN pg_temp.board_v3_color(n."data"->>'color') END)
      ELSE '{}'::jsonb END), '{}'::jsonb),
    'props', CASE n."type"
      WHEN 'text' THEN jsonb_build_object('text', coalesce(n."data"->'text', '""'::jsonb), 'fontSize', coalesce(n."data"->'fontSize', '24'::jsonb))
      WHEN 'geo' THEN jsonb_build_object('geometry', coalesce(n."data"->'geo', '"rectangle"'::jsonb), 'text', coalesce(n."data"->'text', '""'::jsonb), 'fontSize', '14'::jsonb)
      WHEN 'draw' THEN jsonb_build_object('points', coalesce(n."data"->'points', '[]'::jsonb))
      WHEN 'arrow' THEN jsonb_strip_nulls(jsonb_build_object(
        'start', n."data"->'start', 'end', n."data"->'end',
        'bend', CASE WHEN coalesce((n."data"->>'bend')::double precision, 0) <> 0 THEN n."data"->'bend' END,
        'arrowStart', CASE WHEN (n."data"->>'arrowStart')::boolean THEN 'true'::jsonb END,
        'arrowEnd', CASE WHEN (n."data"->>'arrowEnd')::boolean IS FALSE THEN 'false'::jsonb END,
        'label', nullif(n."data"->'label', '""'::jsonb)))
      WHEN 'frame' THEN jsonb_build_object('label', coalesce(n."data"->'label', '""'::jsonb))
      WHEN 'image' THEN jsonb_strip_nulls(jsonb_build_object('src', pg_temp.board_v3_src(n."ref_path"), 'snapshot', pg_temp.board_v3_snapshot(n."view"), 'crop', n."data"->'crop'))
      WHEN 'video' THEN jsonb_strip_nulls(jsonb_build_object('src', pg_temp.board_v3_src(n."ref_path"), 'snapshot', pg_temp.board_v3_snapshot(n."view")))
      WHEN 'audio' THEN jsonb_strip_nulls(jsonb_build_object('src', pg_temp.board_v3_src(n."ref_path"), 'snapshot', pg_temp.board_v3_snapshot(n."view")))
      WHEN 'file' THEN jsonb_strip_nulls(jsonb_build_object('src', pg_temp.board_v3_src(n."ref_path"), 'snapshot', pg_temp.board_v3_snapshot(n."view")))
      WHEN 'task' THEN jsonb_build_object('taskRunId', n."data"->'taskRunId', 'snapshot', n."view")
      -- Media with no usable path keeps its payload verbatim, as a legacy item.
      ELSE (n."data" - 'locked' - 'metadata' - 'kindVersion')
    END
  )),
  b."version",
  n."created_at",
  n."updated_at"
FROM nodes n
JOIN "v2"."boards" b ON b."id" = n."board_id";

-- Connections become arrows bound to the items they join.
WITH connections AS (
  SELECT c.*,
    CASE WHEN EXISTS (SELECT 1 FROM "v2"."board_items" i WHERE i."board_id" = c."board_id" AND i."id" = c."connection_id")
      THEN 'connection-' || c."connection_id" ELSE c."connection_id" END AS "item_id",
    (SELECT max(i."z") FROM "v2"."board_items" i WHERE i."board_id" = c."board_id") AS "top",
    row_number() OVER (PARTITION BY c."board_id" ORDER BY c."connection_id") AS "rank"
  FROM "v2"."board_connections" c
  WHERE c."deleted_at" IS NULL
)
INSERT INTO "v2"."board_items" ("board_id", "id", "type", "z", "min_x", "min_y", "max_x", "max_y", "binds", "data", "version", "created_at", "updated_at")
SELECT
  c."board_id",
  c."item_id",
  'arrow',
  coalesce(c."top", 0) + c."rank",
  least(s."min_x", t."min_x"), least(s."min_y", t."min_y"), greatest(s."max_x", t."max_x"), greatest(s."max_y", t."max_y"),
  ARRAY[c."source_node_id", c."target_node_id"],
  jsonb_strip_nulls(jsonb_build_object(
    'type', 'arrow',
    'z', coalesce(c."top", 0) + c."rank",
    'props', jsonb_strip_nulls(jsonb_build_object(
      'start', jsonb_strip_nulls(jsonb_build_object('item', c."source_node_id", 'anchor', pg_temp.board_v3_anchor(c."source_anchor"))),
      'end', jsonb_strip_nulls(jsonb_build_object('item', c."target_node_id", 'anchor', pg_temp.board_v3_anchor(c."target_anchor"))),
      'route', coalesce(c."routing"->'kind', '"curve"'::jsonb),
      'bend', CASE WHEN coalesce((c."routing"->>'bend')::double precision, 0) <> 0 THEN c."routing"->'bend' END,
      'waypoints', CASE WHEN jsonb_array_length(coalesce(c."routing"->'waypoints', '[]'::jsonb)) > 0 THEN c."routing"->'waypoints' END,
      'arrowStart', CASE WHEN c."direction" IN ('backward', 'both') THEN 'true'::jsonb END,
      'arrowEnd', CASE WHEN c."direction" IN ('backward', 'none') THEN 'false'::jsonb END,
      'label', nullif(to_jsonb(c."label"), '""'::jsonb),
      'relation', CASE WHEN c."relation" <> 'related' THEN to_jsonb(c."relation") END
    )),
    'style', jsonb_strip_nulls(jsonb_build_object(
      'stroke', pg_temp.board_v3_color(coalesce(c."style"->>'color', 'brand')),
      'strokeWidth', coalesce(c."style"->'size', '2.5'::jsonb),
      'dash', CASE WHEN c."style"->>'line' = 'dashed' THEN '"dashed"'::jsonb END
    )),
    'metadata', nullif(c."metadata", '{}'::jsonb)
  )),
  b."version",
  c."created_at",
  c."updated_at"
FROM connections c
JOIN "v2"."boards" b ON b."id" = c."board_id"
JOIN "v2"."board_items" s ON s."board_id" = c."board_id" AND s."id" = c."source_node_id"
JOIN "v2"."board_items" t ON t."board_id" = c."board_id" AND t."id" = c."target_node_id";

UPDATE "v2"."board_items" SET "type" = "data"->>'type';

UPDATE "v2"."board_items" SET "binds" = ARRAY(
  SELECT DISTINCT value FROM (VALUES ("data"->'props'->'start'->>'item'), ("data"->'props'->'end'->>'item')) AS ends(value) WHERE value IS NOT NULL
) WHERE "type" = 'arrow';

CREATE UNIQUE INDEX "v2_uq_board_items_board_id" ON "v2"."board_items" USING btree ("board_id", "id");
CREATE INDEX "v2_idx_board_items_parent" ON "v2"."board_items" USING btree ("board_id", "parent_id", "z");
CREATE INDEX "v2_idx_board_items_bounds" ON "v2"."board_items" USING gist (box(point("min_x", "min_y"), point("max_x", "max_y")));
CREATE INDEX "v2_idx_board_items_src" ON "v2"."board_items" USING btree ("board_id", "src");
CREATE INDEX "v2_idx_board_items_binds" ON "v2"."board_items" USING gin ("binds");

-- 5. Animations and tracks.
CREATE TABLE "v2"."board_animations" (
  "board_id" uuid NOT NULL,
  "id" text NOT NULL,
  "data" jsonb NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO "v2"."board_animations" ("board_id", "id", "data", "revision", "created_at", "updated_at")
SELECT
  c."board_id",
  c."id",
  jsonb_strip_nulls(jsonb_build_object(
    'name', nullif(c."name", ''),
    'duration', greatest(c."duration", 1),
    'play', CASE WHEN a."legacy"->'board'->'metadata'->'playback'->>'compositionId' = c."id" THEN '"auto"'::jsonb END,
    'delay', CASE WHEN a."legacy"->'board'->'metadata'->'playback'->>'compositionId' = c."id" AND coalesce((a."legacy"->'board'->'metadata'->'playback'->>'delayMs')::double precision, 0) > 0
      THEN a."legacy"->'board'->'metadata'->'playback'->'delayMs' END,
    'loop', CASE WHEN (c."playback"->>'loop')::boolean THEN 'true'::jsonb END,
    'end', CASE WHEN c."playback"->>'endBehavior' = 'reset' THEN '"reset"'::jsonb END,
    'markers', nullif((SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('at', m->'time', 'label', m->'metadata'->'label'))), '[]'::jsonb) FROM jsonb_array_elements(c."markers") m), '[]'::jsonb)
  )),
  c."revision" + 1,
  c."created_at",
  c."updated_at"
FROM "v2"."board_compositions" c
JOIN LATERAL (
  SELECT t."patch"->'legacy' AS "legacy" FROM "v2"."board_transactions" t
  WHERE t."board_id" = c."board_id" AND t."tx_id" = 'migration:board-v3'
) a ON true
WHERE NOT EXISTS (SELECT 1 FROM "v2"."board_items" i WHERE i."board_id" = c."board_id" AND i."id" = c."id");

ALTER TABLE "v2"."board_tracks" RENAME TO "board_tracks_v2";
DROP INDEX IF EXISTS "v2"."v2_uq_board_tracks_composition_id";
DROP INDEX IF EXISTS "v2"."v2_idx_board_tracks_composition_id";

CREATE TABLE "v2"."board_tracks" (
  "board_id" uuid NOT NULL,
  "animation_id" text NOT NULL,
  "id" text NOT NULL,
  "target" text NOT NULL,
  "refs" text[] DEFAULT '{}'::text[] NOT NULL,
  "data" jsonb NOT NULL
);
CREATE UNIQUE INDEX "v2_uq_board_tracks_animation_id" ON "v2"."board_tracks" USING btree ("board_id", "animation_id", "id");

-- Property tracks were offsets from the item: they composite additively.
INSERT INTO "v2"."board_tracks" ("board_id", "animation_id", "id", "target", "refs", "data")
SELECT
  t."board_id",
  t."composition_id",
  t."id",
  t."target"->>'itemId',
  ARRAY[t."target"->>'itemId'],
  jsonb_strip_nulls(jsonb_build_object(
    'target', t."target"->>'itemId',
    'property', CASE t."channel" WHEN 'transform.translation' THEN 'position' WHEN 'transform.rotation' THEN 'rotation' WHEN 'transform.scale' THEN 'scale' ELSE 'opacity' END,
    'composite', 'add',
    'interpolation', CASE WHEN t."interpolation" = 'step' THEN 'step' END,
    'keyframes', (
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'at', k->'time',
        'value', CASE WHEN t."channel" = 'transform.rotation' THEN to_jsonb(degrees((k->>'value')::double precision)) ELSE k->'value' END,
        'ease', pg_temp.board_v3_ease(k->>'easing')
      )) ORDER BY ordinality)
      FROM jsonb_array_elements(t."keyframes") WITH ORDINALITY AS keyframe(k, ordinality)
    )
  ))
FROM "v2"."board_tracks_v2" t
JOIN "v2"."board_animations" a ON a."board_id" = t."board_id" AND a."id" = t."composition_id"
JOIN "v2"."board_items" i ON i."board_id" = t."board_id" AND i."id" = t."target"->>'itemId'
WHERE t."target"->>'type' = 'item'
  AND t."channel" IN ('transform.translation', 'transform.rotation', 'transform.scale', 'style.opacity');

-- Reveals, shakes and motion paths become property tracks.
INSERT INTO "v2"."board_tracks" ("board_id", "animation_id", "id", "target", "refs", "data")
SELECT
  c."board_id",
  c."composition_id",
  c."id",
  CASE WHEN c."kind" = 'camera.shake' THEN 'camera' ELSE c."target"->>'itemId' END,
  CASE WHEN c."kind" = 'camera.shake' THEN '{}'::text[] ELSE ARRAY[c."target"->>'itemId'] END,
  CASE c."kind"
    WHEN 'text.reveal' THEN jsonb_build_object('target', c."target"->>'itemId', 'property', 'props.reveal', 'keyframes', jsonb_build_array(
      jsonb_build_object('at', c."start", 'value', 0),
      jsonb_strip_nulls(jsonb_build_object('at', c."start" + c."duration", 'value', 1, 'ease', pg_temp.board_v3_ease(c."easing")))))
    WHEN 'draw.reveal' THEN jsonb_build_object('target', c."target"->>'itemId', 'property', 'style.trim', 'keyframes', jsonb_build_array(
      jsonb_build_object('at', c."start", 'value', 0),
      jsonb_strip_nulls(jsonb_build_object('at', c."start" + c."duration", 'value', 1, 'ease', pg_temp.board_v3_ease(c."easing")))))
    WHEN 'camera.shake' THEN jsonb_build_object('target', 'camera', 'property', 'shake', 'keyframes', jsonb_build_array(
      jsonb_build_object('at', c."start", 'value', coalesce(c."params"->'amount', '12'::jsonb)),
      jsonb_build_object('at', c."start" + c."duration", 'value', 0)))
    ELSE jsonb_strip_nulls(jsonb_build_object('target', c."target"->>'itemId', 'property', 'position', 'composite', 'add', 'interpolation', 'spline',
      'orient', CASE WHEN (c."params"->>'orient')::boolean THEN 'true'::jsonb END,
      'keyframes', (
        SELECT jsonb_agg(jsonb_build_object(
          'at', c."start" + c."duration" * (ordinality - 1) / greatest(jsonb_array_length(c."params"->'points') - 1, 1),
          'value', jsonb_build_object('x', p->'x', 'y', p->'y')) ORDER BY ordinality)
        FROM jsonb_array_elements(c."params"->'points') WITH ORDINALITY AS point(p, ordinality))))
  END
FROM "v2"."board_clips" c
JOIN "v2"."board_animations" a ON a."board_id" = c."board_id" AND a."id" = c."composition_id"
WHERE (c."kind" IN ('text.reveal', 'draw.reveal', 'motion.path')
    AND c."target"->>'type' = 'item'
    AND EXISTS (SELECT 1 FROM "v2"."board_items" i WHERE i."board_id" = c."board_id" AND i."id" = c."target"->>'itemId')
    AND (c."kind" <> 'motion.path' OR jsonb_array_length(coalesce(c."params"->'points', '[]'::jsonb)) >= 2))
  OR c."kind" = 'camera.shake';

-- Camera tours: each focus clip holds the previous target until it starts, then travels.
WITH focus AS (
  SELECT c."board_id", c."composition_id", c."id", c."start", c."duration", c."easing",
    CASE c."params"->'focus'->>'type'
      WHEN 'item' THEN c."params"->'focus'->'itemId'
      WHEN 'frame' THEN c."params"->'focus'->'frameId'
      WHEN 'items' THEN c."params"->'focus'->'itemIds'->0
      WHEN 'rect' THEN c."params"->'focus'->'rect'
    END AS "value"
  FROM "v2"."board_clips" c
  JOIN "v2"."board_animations" a ON a."board_id" = c."board_id" AND a."id" = c."composition_id"
  WHERE c."kind" = 'camera.focus'
), ranked AS (
  -- The camera watches one clip at a time: the latest to have started owns it, and a
  -- clip that names an item the Board no longer has is skipped entirely. Ordering by
  -- id last keeps the sequence total, so clips that agree on both times still have a
  -- fixed order — the same one `upgradeBoardSnapshotV2` computes for a v2 snapshot.
  SELECT f.*, row_number() OVER (PARTITION BY f."board_id", f."composition_id" ORDER BY f."start", f."start" + f."duration", f."id") AS "seq"
  FROM focus f
  WHERE f."value" IS NOT NULL
    AND (jsonb_typeof(f."value") <> 'string' OR EXISTS (SELECT 1 FROM "v2"."board_items" i WHERE i."board_id" = f."board_id" AND i."id" = (f."value" #>> '{}')))
), moments AS (
  -- Every instant the focus can change: zero, and each clip's arrival.
  SELECT DISTINCT r."board_id", r."composition_id", m."at"
  FROM ranked r
  CROSS JOIN LATERAL (
    SELECT 0::double precision AS "at" UNION ALL SELECT r."start" + r."duration"
  ) AS m
), resolved AS (
  -- The focus on screen at each instant.
  --
  -- `owner` is the clip the camera is on: the latest to have started, and among clips
  -- that started together, the one that ends first. `replaced` is the clip one below it
  -- in that order, whose focus is still on screen while `owner` is on its way.
  --
  -- So the camera shows `owner`'s focus once `owner` has arrived, `replaced`'s focus
  -- while it has not, and the first clip's focus before anything has started.
  SELECT m."board_id", m."composition_id", m."at",
    CASE
      WHEN owner."seq" IS NULL THEN first."value"
      WHEN m."at" >= owner."start" + owner."duration" THEN owner."value"
      ELSE coalesce(replaced."value", owner."value")
    END AS "value",
    -- The easing belongs to the clip that arrives at this instant, which is the one
    -- the interval ending here travels towards — not necessarily the owner, which a
    -- later clip may already have taken over.
    arriving."easing",
    coalesce(owner."seq", 0) AS "seq"
  FROM moments m
  LEFT JOIN LATERAL (
    SELECT a."easing" FROM ranked a
    WHERE a."board_id" = m."board_id" AND a."composition_id" = m."composition_id"
      AND a."start" + a."duration" = m."at"
    ORDER BY a."seq" DESC LIMIT 1
  ) arriving ON true
  LEFT JOIN LATERAL (
    SELECT o.* FROM ranked o
    WHERE o."board_id" = m."board_id" AND o."composition_id" = m."composition_id" AND o."start" <= m."at"
    ORDER BY o."seq" DESC LIMIT 1
  ) owner ON true
  LEFT JOIN LATERAL (
    SELECT p."value" FROM ranked p
    WHERE p."board_id" = owner."board_id" AND p."composition_id" = owner."composition_id" AND p."seq" < owner."seq"
    ORDER BY p."seq" DESC LIMIT 1
  ) replaced ON true
  LEFT JOIN LATERAL (
    SELECT f."value" FROM ranked f
    WHERE f."board_id" = m."board_id" AND f."composition_id" = m."composition_id" AND f."seq" = 1
  ) first ON true
)INSERT INTO "v2"."board_tracks" ("board_id", "animation_id", "id", "target", "refs", "data")
SELECT
  k."board_id",
  k."composition_id",
  'camera-focus',
  'camera',
  coalesce(array_agg(DISTINCT k."value" #>> '{}') FILTER (WHERE jsonb_typeof(k."value") = 'string'), '{}'::text[]),
  jsonb_build_object('target', 'camera', 'property', 'focus', 'keyframes', jsonb_agg(
    jsonb_strip_nulls(jsonb_build_object('at', k."at", 'value', k."value", 'ease', pg_temp.board_v3_ease(k."easing"))) ORDER BY k."at", k."seq"))
FROM resolved k
WHERE k."value" IS NOT NULL
GROUP BY k."board_id", k."composition_id"
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX "v2_uq_board_animations_board_id" ON "v2"."board_animations" USING btree ("board_id", "id");
CREATE INDEX "v2_idx_board_tracks_refs" ON "v2"."board_tracks" USING gin ("refs");

-- 6. The archived tables go; their rows live on in the migration transactions.
DROP TABLE "v2"."board_tracks_v2";
DROP TABLE "v2"."board_clips";
DROP TABLE "v2"."board_compositions";
DROP TABLE "v2"."board_effects";
DROP TABLE "v2"."board_connections";
DROP TABLE "v2"."board_playback_states";
DROP TABLE "v2"."board_operations";
DROP TABLE "v2"."board_nodes";
ALTER TABLE "v2"."boards" DROP COLUMN "metadata";
